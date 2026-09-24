/**
 * Router do painel de gestão de chaves (`/__tavily-keys`).
 *
 * Ordem FIXA de verificação (inverter é regressão de segurança):
 *   origem (socket `trustedRemotes` + cabeçalho `Origin`) → `Host` → credencial.
 *
 *  - as duas denegações de fronteira (403) são BYTE-IDÊNTICAS entre si e todas
 *    as denegações de credencial (401) são byte-idênticas entre si — sem oráculo;
 *  - o lockout por orçamento de falhas (NIST) responde o MESMO 401;
 *  - ações destrutivas exigem nonce de confirmação (uso único, com prazo);
 *  - cada decisão mutável ou denegada é auditada (append-only).
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TavilyKeyManager } from '../key-manager.js'
import { classifyStatus, maskKey, parseRetryAfterSeconds, TAVILY_SEARCH_ENDPOINT } from '../search-executor.js'
import type { LoggerLike, ResolvedConfig } from '../types.js'
import type { AuthFailureTracker, NonceStore } from './auth.js'
import { verifyToken } from './auth.js'
import { renderPage } from './page.js'
import type { AuditEntry, StorePaths } from './store.js'
import { savePersistedKeys } from './store.js'

export const ADMIN_BASE_PATH = '/__tavily-keys'

/** Denegações de fronteira: corpo byte-idêntico em todas as ocorrências (sem oráculo). */
export const FORBIDDEN_BODY = '{"error":"forbidden"}\n'
/** Denegações de credencial: corpo byte-idêntico (token errado, ausente OU lockout). */
export const UNAUTHORIZED_BODY = '{"error":"unauthorized"}\n'

const MAX_BODY_BYTES = 16 * 1024
const TEST_TIMEOUT_MS = 10_000
const MIN_KEY_LENGTH = 16
const MAX_KEY_LENGTH = 512

export interface AdminRouterDeps {
  keyManager: TavilyKeyManager
  config: ResolvedConfig
  paths: StorePaths
  persistedKeys: Set<string>
  /** Digest do token administrativo efetivo (pode mudar após reset). */
  expectedTokenDigest: () => string
  tracker: AuthFailureTracker
  nonces: NonceStore
  fetchFn: typeof fetch
  logger: LoggerLike
  now: () => number
  /** Devolve `false` quando a auditoria falhou (operações mutáveis falham fechado). */
  audit: (entry: AuditEntry) => boolean
}

/** Normaliza um hostname para comparação (minúsculas, sem colchetes IPv6). */
export function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase()
  const withoutPort = trimmed.startsWith('[')
    ? (trimmed.match(/^\[([^\]]*)\]/)?.[1] ?? trimmed)
    : (trimmed.split(':')[0] ?? trimmed)
  return withoutPort
}

function socketRemote(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? 'unknown'
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' ? value : null
}

/**
 * Fronteira: origem (socket + `Origin`) → `Host`. Devolve `false` para QUALQUER
 * falha — o chamador responde 403 byte-idêntico, sem dizer qual o eixo falhou.
 */
export function checkBoundary(req: IncomingMessage, config: ResolvedConfig): boolean {
  const admin = config.admin
  const allowed = new Set(admin.allowedHosts.map(normalizeHost))

  // 1) origem por soquete (trustedRemotes): fora da lista → recusa ANTES da credencial
  const remote = socketRemote(req)
  if (!admin.trustedRemotes.includes(remote)) return false

  // 2) origem declarada (cabeçalho Origin): se presente, tem de ser da lista
  const origin = headerValue(req, 'origin')
  if (origin !== null) {
    if (origin === 'null') return false // iframe/opaco: nunca confiável
    let originHost: string
    try {
      originHost = normalizeHost(new URL(origin).hostname)
    } catch {
      return false
    }
    if (!allowed.has(originHost)) return false
  }

  // 3) nome pedido (Host): defesa contra DNS rebinding
  const host = headerValue(req, 'host')
  if (host === null) return false
  return allowed.has(normalizeHost(host))
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  })
  res.end(text)
}

function sendForbidden(res: ServerResponse): void {
  res.writeHead(403, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  })
  res.end(FORBIDDEN_BODY)
}

function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'www-authenticate': 'Bearer realm="dsh-tavily-keys"',
    'content-security-policy': "default-src 'none'",
  })
  res.end(UNAUTHORIZED_BODY)
}

async function readBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('corpo excede o limite'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (raw.trim().length === 0) return {}
  const parsed: unknown = JSON.parse(raw)
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
}

function isValidKeyCandidate(key: string): boolean {
  return (
    key.length >= MIN_KEY_LENGTH &&
    key.length <= MAX_KEY_LENGTH &&
    // imprimível ASCII sem espaços: material de segredo não contém whitespace
    /^[\x21-\x7e]+$/.test(key)
  )
}

export function createAdminRouter(deps: AdminRouterDeps) {
  const { keyManager, config, persistedKeys, tracker, nonces, fetchFn, logger, now } = deps

  const audit = (entry: AuditEntry): boolean => {
    const ok = deps.audit(entry)
    if (!ok) logger.error('[dsh-tavily-resilient-search] auditoria falhou — a operação correspondente foi negada (fail-closed)')
    return ok
  }

  const remoteOf = (req: IncomingMessage): string => socketRemote(req)

  function authenticate(req: IncomingMessage): boolean {
    const remote = remoteOf(req)
    if (tracker.isLocked(remote)) {
      audit({ action: 'auth', outcome: 'deny', remote, detail: 'failure-budget-exhausted' })
      return false // MESMO 401 — nunca um 429 (sem oráculo)
    }
    const authorization = headerValue(req, 'authorization')
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : undefined
    if (verifyToken(token, deps.expectedTokenDigest())) {
      tracker.registerSuccess(remote)
      return true
    }
    const failures = tracker.registerFailure(remote)
    audit({ action: 'auth', outcome: 'deny', remote, detail: `bad-token failures=${failures}` })
    return false
  }

  async function handleStatus(res: ServerResponse, remote: string): Promise<void> {
    sendJson(res, 200, {
      pool: keyManager.snapshot(),
      totalKeys: keyManager.size,
      keylessOnly: keyManager.size === 0,
      searchDepth: config.searchDepth,
      maxResults: config.maxResults,
      includeAnswer: config.includeAnswer,
      timeoutMs: config.timeoutMs,
      persistedCount: persistedKeys.size,
      stateDir: deps.paths.dir,
    })
    void remote
  }

  async function handleAddKey(req: IncomingMessage, res: ServerResponse, remote: string): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'corpo inválido' })
      return
    }
    const key = typeof body['key'] === 'string' ? body['key'].trim() : ''
    const persist = body['persist'] !== false
    if (!isValidKeyCandidate(key)) {
      audit({ action: 'add-key', outcome: 'deny', remote, detail: 'invalid-format' })
      sendJson(res, 400, { error: 'formato de chave inválido' })
      return
    }
    const added = keyManager.addKey(key, 'ui')
    if (!added) {
      audit({ action: 'add-key', outcome: 'deny', remote, detail: 'duplicate' })
      sendJson(res, 409, { error: 'chave já existente no pool' })
      return
    }
    if (persist) {
      persistedKeys.add(key)
      savePersistedKeys(deps.paths, [...persistedKeys])
    }
    const snapshot = keyManager.snapshot()
    const ref = snapshot[snapshot.length - 1]?.ref ?? maskKey(key)
    if (!audit({ action: 'add-key', outcome: 'permit', remote, target: ref, detail: persist ? 'persisted' : 'volatile' })) {
      sendJson(res, 500, { error: 'auditoria indisponível — operação revertida' })
      keyManager.removeKeyByIndex(keyManager.size - 1)
      if (persist) {
        persistedKeys.delete(key)
        savePersistedKeys(deps.paths, [...persistedKeys])
      }
      return
    }
    sendJson(res, 200, { ok: true, ref, persisted: persist })
  }

  async function handleRemoveKey(req: IncomingMessage, res: ServerResponse, remote: string, indexText: string): Promise<void> {
    const index = Number.parseInt(indexText, 10)
    const target = String(index)
    const nonce = headerValue(req, 'x-confirm-nonce') ?? undefined
    if (!Number.isInteger(index) || index < 0 || index >= keyManager.size) {
      sendJson(res, 404, { error: 'credencial inexistente' })
      return
    }
    if (!nonces.consume(nonce, 'remove-key', target, remote)) {
      audit({ action: 'remove-key', outcome: 'deny', remote, target, detail: 'missing-or-stale-nonce' })
      sendJson(res, 428, { error: 'confirmação necessária — obtenha um nonce em POST /api/confirm' })
      return
    }
    const removed = keyManager.removeKeyByIndex(index)
    if (!removed) {
      sendJson(res, 404, { error: 'credencial inexistente' })
      return
    }
    const wasPersisted = persistedKeys.delete(removed.key)
    if (wasPersisted) savePersistedKeys(deps.paths, [...persistedKeys])
    if (!audit({ action: 'remove-key', outcome: 'permit', remote, target: maskKey(removed.key), detail: `source=${removed.source}` })) {
      sendJson(res, 500, { error: 'auditoria indisponível' })
      return
    }
    sendJson(res, 200, {
      ok: true,
      ref: maskKey(removed.key),
      volatileEnvKey: removed.source === 'env',
      message:
        removed.source === 'env'
          ? 'chave vinda do ambiente: a remoção é volátil e regressa no próximo arranque'
          : 'chave removida',
    })
  }

  async function handleReplaceKey(req: IncomingMessage, res: ServerResponse, remote: string, indexText: string): Promise<void> {
    const index = Number.parseInt(indexText, 10)
    const target = String(index)
    const nonce = headerValue(req, 'x-confirm-nonce') ?? undefined
    const current = Number.isInteger(index) ? keyManager.getByIndex(index) : undefined
    if (!current) {
      sendJson(res, 404, { error: 'credencial inexistente' })
      return
    }
    if (!nonces.consume(nonce, 'replace-key', target, remote)) {
      audit({ action: 'replace-key', outcome: 'deny', remote, target, detail: 'missing-or-stale-nonce' })
      sendJson(res, 428, { error: 'confirmação necessária — obtenha um nonce em POST /api/confirm' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'corpo inválido' })
      return
    }
    const key = typeof body['key'] === 'string' ? body['key'].trim() : ''
    const persist = body['persist'] !== false
    if (!isValidKeyCandidate(key)) {
      audit({ action: 'replace-key', outcome: 'deny', remote, target, detail: 'invalid-format' })
      sendJson(res, 400, { error: 'formato de chave inválido' })
      return
    }
    const old = keyManager.replaceKeyByIndex(index, key, 'ui')
    if (!old) {
      audit({ action: 'replace-key', outcome: 'deny', remote, target, detail: 'duplicate-or-invalid' })
      sendJson(res, 409, { error: 'chave já existente no pool' })
      return
    }
    const wasPersisted = persistedKeys.delete(old.key)
    if (persist) persistedKeys.add(key)
    if (wasPersisted || persist) savePersistedKeys(deps.paths, [...persistedKeys])
    const ref = maskKey(key)
    if (!audit({ action: 'replace-key', outcome: 'permit', remote, target: ref, detail: `replaced=${maskKey(old.key)}` })) {
      // fail-closed: auditoria em falta reverte a substituição
      keyManager.replaceKeyByIndex(index, old.key, old.source)
      persistedKeys.delete(key)
      if (wasPersisted) persistedKeys.add(old.key)
      savePersistedKeys(deps.paths, [...persistedKeys])
      sendJson(res, 500, { error: 'auditoria indisponível — operação revertida' })
      return
    }
    sendJson(res, 200, { ok: true, ref, persisted: persist, message: `chave ${ref} substituída` })
  }

  async function handleConfirm(req: IncomingMessage, res: ServerResponse, remote: string): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'corpo inválido' })
      return
    }
    const action = body['action']
    const target = body['target']
    if ((action !== 'remove-key' && action !== 'replace-key') || typeof target !== 'string') {
      sendJson(res, 400, { error: 'ação de confirmação desconhecida' })
      return
    }
    const nonce = nonces.issue(action, target, remote)
    if (!audit({ action: 'confirm', outcome: 'permit', remote, target: `${action}:${target}` })) {
      sendJson(res, 500, { error: 'auditoria indisponível' })
      return
    }
    sendJson(res, 200, { nonce })
  }

  async function handleTestKey(res: ServerResponse, remote: string, indexText: string): Promise<void> {
    const index = Number.parseInt(indexText, 10)
    const meta = Number.isInteger(index) ? keyManager.getByIndex(index) : undefined
    if (!meta) {
      sendJson(res, 404, { error: 'credencial inexistente' })
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    try {
      const response = await fetchFn(TAVILY_SEARCH_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${meta.key}` },
        body: JSON.stringify({
          query: 'dsh tavily key check',
          search_depth: 'ultra-fast',
          max_results: 1,
          topic: 'general',
          include_answer: false,
          chunks_per_source: 1,
        }),
        signal: controller.signal,
      })
      const statusClass = classifyStatus(response.status)
      if (statusClass === 'success') {
        audit({ action: 'test-key', outcome: 'permit', remote, target: maskKey(meta.key), detail: 'ok' })
        sendJson(res, 200, { ok: true, outcome: 'ok', message: 'chave válida (1 crédito gasto)' })
        return
      }
      if (statusClass === 'unauthorized') keyManager.markRevoked(meta.key)
      else if (statusClass === 'rate-limited') {
        keyManager.markRateLimited(meta.key, parseRetryAfterSeconds(response.headers.get('Retry-After'), now()))
      } else if (statusClass === 'quota-exhausted' || statusClass === 'paygo-exhausted') {
        keyManager.markQuotaExhausted(meta.key)
      }
      audit({ action: 'test-key', outcome: 'error', remote, target: maskKey(meta.key), detail: `http=${response.status}` })
      sendJson(res, 200, { ok: false, outcome: statusClass, message: `HTTP ${response.status}` })
    } catch {
      audit({ action: 'test-key', outcome: 'error', remote, target: maskKey(meta.key), detail: 'network-or-timeout' })
      sendJson(res, 200, { ok: false, outcome: 'unreachable', message: 'sem resposta da API Tavily (rede/timeout)' })
    } finally {
      clearTimeout(timer)
    }
  }

  return async function adminRouter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1-3) fronteira: origem → Host (denegações byte-idênticas)
    if (!checkBoundary(req, config)) {
      audit({ action: 'boundary', outcome: 'deny', remote: remoteOf(req) })
      sendForbidden(res)
      return
    }

    const url = new URL(req.url ?? '/', 'http://internal.invalid')
    const pathname = url.pathname === ADMIN_BASE_PATH ? '/' : url.pathname.slice(ADMIN_BASE_PATH.length) || '/'
    const method = req.method ?? 'GET'
    const remote = remoteOf(req)

    // Página (sem segredos): só precisa de passar a fronteira.
    if (method === 'GET' && (pathname === '/' || pathname === '')) {
      const nonce = randomBytes(16).toString('hex')
      const html = renderPage({ scriptNonce: nonce, basePath: ADMIN_BASE_PATH })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
          `connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      })
      res.end(html)
      return
    }

    // 4) credencial para toda a superfície /api (401 byte-idêntico em qualquer falha)
    if (pathname.startsWith('/api/')) {
      if (!authenticate(req)) {
        sendUnauthorized(res)
        return
      }

      if (method === 'GET' && pathname === '/api/status') {
        await handleStatus(res, remote)
        return
      }
      if (method === 'POST' && pathname === '/api/keys') {
        await handleAddKey(req, res, remote)
        return
      }
      if (method === 'POST' && pathname === '/api/confirm') {
        await handleConfirm(req, res, remote)
        return
      }
      const keyMatch = pathname.match(/^\/api\/keys\/([0-9]+)(\/test)?$/)
      if (keyMatch && method === 'DELETE' && !keyMatch[2]) {
        await handleRemoveKey(req, res, remote, keyMatch[1]!)
        return
      }
      if (keyMatch && method === 'PUT' && !keyMatch[2]) {
        await handleReplaceKey(req, res, remote, keyMatch[1]!)
        return
      }
      if (keyMatch && keyMatch[2] === '/test' && method === 'POST') {
        await handleTestKey(res, remote, keyMatch[1]!)
        return
      }
    }

    sendJson(res, 404, { error: 'not found' })
  }
}
