/**
 * Camada INTEGRAÇÃO — o router do painel sobre um servidor HTTP REAL (porta 0),
 * com o fluxo completo: página → autenticação → gestão do pool → confirmação.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  AuthFailureTracker,
  NonceStore,
  digestToken,
  generateAdminToken,
} from '../../src/admin/auth.js'
import { ADMIN_BASE_PATH, createAdminRouter } from '../../src/admin/router.js'
import {
  appendAudit,
  ensureStore,
  loadPersistedKeys,
  resolveStorePaths,
} from '../../src/admin/store.js'
import { assertValidConfig } from '../../src/config.js'
import { TavilyKeyManager } from '../../src/key-manager.js'
import type { PluginConfig } from '../../src/types.js'

const TOKEN = generateAdminToken()
const K1 = 'tvly-INTKEYONE-aaaaaaaaaa1111'
const K2 = 'tvly-INTKEYTWO-bbbbbbbbbb2222'

interface Harness {
  base: string
  server: Server
  keyManager: TavilyKeyManager
  persistedKeys: Set<string>
  paths: ReturnType<typeof resolveStorePaths>
  auditLines: () => string[]
  script: Array<{ status: number; body?: unknown }>
}

function config(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    securityProfile: { sandbox: 'workspace-write', approval: 'ask' },
    apiKeys: [K1],
    ...overrides,
  }
}

let h: Harness

async function call(
  method: string,
  path: string,
  options: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string; json: unknown; headers: Headers }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.token !== null) headers['authorization'] = `Bearer ${options.token ?? TOKEN}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    // corpo não-JSON
  }
  return { status: res.status, text, json, headers: res.headers }
}

before(async () => {
  const paths = resolveStorePaths(join(mkdtempSync(join(tmpdir(), 'dsh-tavily-int-')), 'state'))
  ensureStore(paths)
  const resolved = assertValidConfig(config())
  const keyManager = new TavilyKeyManager(resolved.apiKeys, { allowEmpty: true, source: 'env' })
  const persistedKeys = new Set<string>()
  const script: Array<{ status: number; body?: unknown }> = []
  const fetchFn: typeof fetch = (async () => {
    const step = script.shift() ?? { status: 500, body: {} }
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status })
  }) as typeof fetch

  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const router = createAdminRouter({
    keyManager,
    config: resolved,
    paths,
    persistedKeys,
    expectedTokenDigest: () => digestToken(TOKEN),
    tracker: new AuthFailureTracker(),
    nonces: new NonceStore(() => Date.now()),
    fetchFn,
    logger,
    now: () => Date.now(),
    audit: (entry) => {
      try {
        appendAudit(paths, entry)
        return true
      } catch {
        return false
      }
    },
  })

  const server = createServer((req, res) => {
    void router(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('sem porta')
  h = {
    base: `http://127.0.0.1:${address.port}`,
    server,
    keyManager,
    persistedKeys,
    paths,
    auditLines: () => readFileSync(paths.auditFile, 'utf8').trim().split('\n').filter(Boolean),
    script,
  }
})

after(async () => {
  await new Promise<void>((resolve) => h.server.close(() => resolve()))
})

describe('painel — página e autenticação', () => {
  it('a página carrega com CSP estrita e nonce de script por resposta', async () => {
    const res = await call('GET', `${ADMIN_BASE_PATH}/`, { token: null })
    assert.equal(res.status, 200)
    assert.match(res.text, /Gestão de chaves Tavily/)
    const csp = res.headers.get('content-security-policy') ?? ''
    assert.match(csp, /script-src 'nonce-[0-9a-f]{32}'/)
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /frame-ancestors 'none'/)
  })

  it('sem credencial: 401 com corpo byte-idêntico ao de token errado', async () => {
    const missing = await call('GET', '/__tavily-keys/api/status', { token: null })
    const wrong = await call('GET', '/__tavily-keys/api/status', { token: 'errado' })
    assert.equal(missing.status, 401)
    assert.equal(wrong.status, 401)
    assert.equal(missing.text, wrong.text)
  })

  it('com credencial: estado do pool mascarado', async () => {
    const res = await call('GET', '/__tavily-keys/api/status')
    assert.equal(res.status, 200)
    const data = res.json as { pool: Array<{ ref: string; source: string }>; totalKeys: number }
    assert.equal(data.totalKeys, 1)
    assert.equal(data.pool[0]!.ref, `…${K1.slice(-4)}`)
    assert.equal(data.pool[0]!.source, 'env')
    assert.ok(!res.text.includes(K1), 'chave completa nunca aparece')
  })
})

describe('painel — gestão do pool', () => {
  it('adiciona chave persistindo-a em keys.json 0600', async () => {
    const res = await call('POST', '/__tavily-keys/api/keys', { body: { key: K2, persist: true } })
    assert.equal(res.status, 200)
    assert.equal(h.keyManager.size, 2)
    assert.deepEqual(loadPersistedKeys(h.paths), [K2])
    assert.equal(statSync(h.paths.keysFile).mode & 0o777, 0o600)
    assert.deepEqual([...h.persistedKeys], [K2])
  })

  it('recusa duplicados e formatos inválidos', async () => {
    assert.equal((await call('POST', '/__tavily-keys/api/keys', { body: { key: K2 } })).status, 409)
    assert.equal((await call('POST', '/__tavily-keys/api/keys', { body: { key: 'curta' } })).status, 400)
    assert.equal((await call('POST', '/__tavily-keys/api/keys', { body: { key: 'tem espaço no meio' } })).status, 400)
  })

  it('remoção exige nonce de confirmação (uso único)', async () => {
    const before = h.keyManager.size
    const denied = await call('DELETE', '/__tavily-keys/api/keys/1')
    assert.equal(denied.status, 428)
    assert.equal(h.keyManager.size, before)

    const confirm = await call('POST', '/__tavily-keys/api/confirm', {
      body: { action: 'remove-key', target: '1' },
    })
    const nonce = (confirm.json as { nonce: string }).nonce

    const ok = await call('DELETE', '/__tavily-keys/api/keys/1', { headers: { 'x-confirm-nonce': nonce } })
    assert.equal(ok.status, 200)
    assert.equal(h.keyManager.size, before - 1)
    assert.deepEqual(loadPersistedKeys(h.paths), [], 'removida também do keys.json')

    const reuse = await call('DELETE', '/__tavily-keys/api/keys/0', { headers: { 'x-confirm-nonce': nonce } })
    assert.equal(reuse.status, 428, 'nonce é de uso único')
  })

  it('teste de chave classifica a resposta e muta o estado do pool', async () => {
    h.script.push({ status: 200, body: { results: [] } })
    const ok = await call('POST', '/__tavily-keys/api/keys/0/test')
    assert.equal(ok.status, 200)
    assert.equal((ok.json as { outcome: string }).outcome, 'ok')

    h.script.push({ status: 401, body: {} })
    const bad = await call('POST', '/__tavily-keys/api/keys/0/test')
    assert.equal((bad.json as { outcome: string }).outcome, 'unauthorized')
    assert.equal(h.keyManager.getStatus(h.keyManager.getByIndex(0)!.key), 'REVOKED')
  })

  it('audita todas as decisões mutáveis e denegações', () => {
    const blob = h.auditLines().join('\n')
    for (const action of ['auth', 'add-key', 'confirm', 'remove-key', 'test-key']) {
      assert.ok(blob.includes(`"action":"${action}"`), `auditoria sem ${action}`)
    }
  })

  it('rota desconhecida devolve 404', async () => {
    assert.equal((await call('GET', '/__tavily-keys/api/nada')).status, 404)
    assert.equal((await call('DELETE', '/__tavily-keys/api/keys/99')).status, 404)
  })
})
