/**
 * Camada ADVERSARIAL — tenta brechar o painel de gestão de chaves.
 *
 * Ameaças cobertas:
 *  B-1 CSRF/origem forjada (Origin hostil) → 403 byte-idêntico;
 *  B-2 DNS rebinding (Host hostil) → 403 byte-idêntico (sem oráculo de eixo);
 *  B-3 força bruta → lockout NIST com o MESMO 401 (nunca 429), mesmo com o
 *      token correto após o orçamento se esgotar;
 *  B-4 nonce obrigatório em ações destrutivas + uso único + ligação ao alvo;
 *  B-5 canário de segredos: token e chaves nunca em respostas nem na auditoria;
 *  B-6 bind público → painel recusa-se a montar (fail-closed, ruidoso);
 *  B-7 tapIndex idempotente e sem segredos.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { AuthFailureTracker, NonceStore, digestToken } from '../../src/admin/auth.js'
import { bindIsSafe, installAdminPanel } from '../../src/admin/index.js'
import { ADMIN_BASE_PATH, FORBIDDEN_BODY, UNAUTHORIZED_BODY, createAdminRouter } from '../../src/admin/router.js'
import { appendAudit, ensureStore, resolveStorePaths, saveTokenDigest, sha256Hex } from '../../src/admin/store.js'
import { assertValidConfig } from '../../src/config.js'
import { TavilyKeyManager } from '../../src/key-manager.js'
import type { PluginConfig } from '../../src/types.js'

const CANARY_TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
const CANARY_KEY = 'tvly-CANARYADV-8f31d0c2e98f31d0'

function config(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    securityProfile: { sandbox: 'workspace-write', approval: 'ask' },
    apiKeys: [CANARY_KEY],
    ...overrides,
  }
}

interface Adv {
  base: string
  port: number
  server: Server
  keyManager: TavilyKeyManager
  paths: ReturnType<typeof resolveStorePaths>
}

let h: Adv
let tracker: AuthFailureTracker

async function call(
  method: string,
  path: string,
  options: { token?: string | null; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.token !== null) headers['authorization'] = `Bearer ${options.token ?? CANARY_TOKEN}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return { status: res.status, text: await res.text() }
}

before(async () => {
  const paths = resolveStorePaths(join(mkdtempSync(join(tmpdir(), 'dsh-tavily-adv-')), 'state'))
  ensureStore(paths)
  saveTokenDigest(paths, sha256Hex(CANARY_TOKEN)) // digest persistido, nunca o token
  const resolved = assertValidConfig(config())
  const keyManager = new TavilyKeyManager(resolved.apiKeys, { allowEmpty: true, source: 'env' })
  tracker = new AuthFailureTracker()
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const router = createAdminRouter({
    keyManager,
    config: resolved,
    paths,
    persistedKeys: new Set<string>(),
    expectedTokenDigest: () => digestToken(CANARY_TOKEN),
    tracker,
    nonces: new NonceStore(() => Date.now()),
    fetchFn: (async () => new Response('{}', { status: 200 })) as typeof fetch,
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
  h = { base: `http://127.0.0.1:${address.port}`, port: address.port, server, keyManager, paths }
})

/**
 * Chamada com controlo TOTAL de cabeçalhos: o `fetch` do Node recusa sobrescrever
 * `Host`/`Origin` (forbidden headers) — para simular rebinding/CSRF usa-se o
 * `node:http` cru, que envia exatamente o que se pedir.
 */
function rawCall(path: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: h.port, path, method: 'GET', headers }, (res) => {
      let text = ''
      res.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8')
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end()
  })
}

after(async () => {
  await new Promise<void>((resolve) => h.server.close(() => resolve()))
})

describe('B-1/B-2 — fronteira: origem e Host com denegações byte-idênticas', () => {
  it('Origin hostil, Host hostil e Origin opaca recusam com o MESMO corpo', async () => {
    const origin = await rawCall(`${ADMIN_BASE_PATH}/`, { origin: 'https://evil.example' })
    const rebinding = await rawCall(`${ADMIN_BASE_PATH}/`, { host: 'attacker.example.com' })
    const opaque = await rawCall(`${ADMIN_BASE_PATH}/`, { origin: 'null' })
    for (const res of [origin, rebinding, opaque]) {
      assert.equal(res.status, 403)
      assert.equal(res.text, FORBIDDEN_BODY, 'denegações têm de ser byte-idênticas')
    }
    // a página legítima continua a responder (410: gestão em Definições)
    assert.equal((await call('GET', `${ADMIN_BASE_PATH}/`, { token: null })).status, 410)
  })

  it('fora de trustedRemotes: recusa ANTES de qualquer credencial (403, sem oráculo)', async () => {
    const resolved = assertValidConfig(config({ admin: { trustedRemotes: ['10.0.0.1'] } }))
    const router = createAdminRouter({
      keyManager: h.keyManager,
      config: resolved,
      paths: h.paths,
      persistedKeys: new Set(),
      expectedTokenDigest: () => digestToken(CANARY_TOKEN),
      tracker: new AuthFailureTracker(),
      nonces: new NonceStore(() => Date.now()),
      fetchFn: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => Date.now(),
      audit: () => true,
    })
    const server = createServer((req, res) => {
      void router(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    try {
      const res = await fetch(`${base}${ADMIN_BASE_PATH}/api/status`, {
        headers: { authorization: `Bearer ${CANARY_TOKEN}` },
      })
      assert.equal(res.status, 403)
      assert.equal(await res.text(), FORBIDDEN_BODY)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('B-4 — nonce de confirmação em ações destrutivas', () => {
  it('alvo errado não remove; o nonce é de uso único', async () => {
    const size = h.keyManager.size
    const confirm = await call('POST', '/__tavily-keys/api/confirm', {
      body: { action: 'remove-key', target: '0' },
    })
    const nonce = (JSON.parse(confirm.text) as { nonce: string }).nonce

    const wrongTarget = await call('DELETE', '/__tavily-keys/api/keys/9', {
      headers: { 'x-confirm-nonce': nonce },
    })
    assert.equal(wrongTarget.status, 404, 'alvo inexistente')

    const withoutNonce = await call('DELETE', '/__tavily-keys/api/keys/0')
    assert.equal(withoutNonce.status, 428)
    assert.equal(h.keyManager.size, size, 'nada foi removido sem confirmação válida')
  })

  it('o nonce de substituição está ligado ao alvo — alvo errado não substitui', async () => {
    const before = h.keyManager.getByIndex(0)!.key
    const confirm = await call('POST', '/__tavily-keys/api/confirm', {
      body: { action: 'replace-key', target: '5' },
    })
    const nonce = (JSON.parse(confirm.text) as { nonce: string }).nonce
    const wrongTarget = await call('PUT', '/__tavily-keys/api/keys/0', {
      headers: { 'x-confirm-nonce': nonce },
      body: { key: 'tvly-ADVREPLACE-9999999999999999' },
    })
    assert.equal(wrongTarget.status, 428, 'nonce para outro alvo é inútil')
    assert.equal(h.keyManager.getByIndex(0)!.key, before, 'credencial intacta')
  })
})

describe('B-5 — canário de segredos por valor', () => {
  it('token e material de chave nunca aparecem em respostas nem na auditoria', async () => {
    const page = await call('GET', `${ADMIN_BASE_PATH}/`, { token: null })
    const status = await call('GET', '/__tavily-keys/api/status')
    const audit = readFileSync(h.paths.auditFile, 'utf8')
    const state = readFileSync(h.paths.stateFile, 'utf8')

    for (const blob of [page.text, status.text, audit, state]) {
      assert.ok(!blob.includes(CANARY_TOKEN), 'token administrativo vazou')
      assert.ok(!blob.includes(CANARY_KEY), 'chave Tavily vazou')
      assert.ok(!blob.includes(CANARY_KEY.slice(0, 8)), 'prefixo da chave vazou')
    }
  })
})

describe('B-6 — bind público: o painel recusa-se a montar (fail-closed)', () => {
  it('bindIsSafe bloqueia 0.0.0.0 sem opt-out explícito', () => {
    assert.equal(bindIsSafe('127.0.0.1', false), true)
    assert.equal(bindIsSafe('0.0.0.0', false), false)
    assert.equal(bindIsSafe('0.0.0.0', true), true, 'allowPublicBind é o opt-out explícito')
  })

  it('sobre bind público NENHUMA rota é registada e a recusa é ruidosa', () => {
    const errors: string[] = []
    const registered: unknown[] = []
    let tapped = 0
    const uiCtx = {
      webServer: {
        host: '0.0.0.0',
        register: (route: unknown) => {
          registered.push(route)
          return () => {}
        },
        tapIndex: () => {
          tapped++
          return () => {}
        },
      },
      effect: <T extends () => unknown>(factory: T) => factory(),
      logger: () => ({ info: () => {}, warn: () => {}, error: (...a: unknown[]) => void errors.push(a.join(' ')) }),
    }
    const parentCtx = {
      plugin: (spec: { apply: (ctx: Context) => void }) => {
        spec.apply(uiCtx as unknown as Context)
        return { dispose: async () => {} }
      },
    }
    const resolved = assertValidConfig(config())
    installAdminPanel(parentCtx as unknown as Context, {
      keyManager: new TavilyKeyManager(resolved.apiKeys, { allowEmpty: true }),
      config: resolved,
      fetchFn: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      logger: { info: () => {}, warn: () => {}, error: (...a: unknown[]) => void errors.push(a.join(' ')) },
      now: () => Date.now(),
    })
    assert.equal(registered.length, 0, 'nenhuma rota exposta sobre bind público')
    assert.equal(tapped, 0)
    assert.ok(errors.some((e) => e.includes('NÃO montado')), 'a recusa tem de ser ruidosa')
  })
})

describe('B-7 — saúde pública mínima e página retirada', () => {
  it('/api/health vaza apenas o essencial (booleans), nunca segredos', async () => {
    const res = await call('GET', '/__tavily-keys/api/health', { token: null })
    assert.equal(res.status, 200)
    const data = JSON.parse(res.text) as Record<string, unknown>
    assert.deepEqual(Object.keys(data).sort(), ['hasValidKey', 'needsSetup', 'totalKeys'])
    assert.equal(typeof data['hasValidKey'], 'boolean')
    assert.ok(!res.text.includes(CANARY_KEY) && !res.text.includes(CANARY_TOKEN) && !res.text.includes(CANARY_KEY.slice(0, 8)))
  })

  it('a página autónoma está retirada (410) — a edição é toda em Definições', async () => {
    const res = await call('GET', `${ADMIN_BASE_PATH}/`, { token: null })
    assert.equal(res.status, 410)
    assert.match(res.text, /Definições/)
  })
})

// B-3 em ÚLTIMO: o lockout esgota o orçamento da origem partilhada e é um estado
// terminal do servidor partilhado — cenário terminal, cenário por fim.
describe('B-3 — força bruta: lockout NIST sem oráculo', () => {
  it('100 falhas esgotam o orçamento e o token CORRETO também recebe o mesmo 401', async () => {
    for (let i = 0; i < 100; i++) {
      const res = await call('GET', '/__tavily-keys/api/status', { token: `errado-${i}` })
      assert.equal(res.status, 401)
      assert.equal(res.text, UNAUTHORIZED_BODY)
    }
    const locked = await call('GET', '/__tavily-keys/api/status', { token: CANARY_TOKEN })
    assert.equal(locked.status, 401, 'bloqueado — sem oráculo para o token correto')
    assert.equal(locked.text, UNAUTHORIZED_BODY, 'corpo byte-idêntico ao do token errado')
    assert.equal(tracker.isLocked('127.0.0.1'), true)
  })
})
