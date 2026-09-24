/**
 * Camada INTEGRAÇÃO — rotação atómica de chaves sobre um double de transporte.
 *
 * O double `fakeFetch` tem contrato explícito: emite sequências HTTP por ordem e
 * regista cada invocação (URL, cabeçalhos, corpo). Se a assinatura de fetch
 * mudar, estas chamadas partem alto — nunca silenciosamente.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TavilyKeyManager } from '../../src/key-manager.js'
import {
  classifyStatus,
  createSearchExecutor,
  parseRetryAfterSeconds,
  type ExecutorDeps,
} from '../../src/search-executor.js'
import { assertValidConfig } from '../../src/config.js'
import { utf8Bytes } from '../../src/text-budget.js'
import type { PluginConfig } from '../../src/types.js'

const K1 = 'tvly-KEYONE-aaaaaaaaaaaa1111'
const K2 = 'tvly-KEYTWO-bbbbbbbbbbbb2222'

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

interface ScriptedResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** Rejeita a promise como um erro de rede. */
  networkError?: string
  /** Não resolve até o sinal abortar (simula pendura). */
  hangUntilAbort?: boolean
}

function fakeTransport(script: ScriptedResponse[]) {
  const calls: RecordedCall[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v
    }
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: String(init?.body ?? ''),
    })
    const step = script.shift()
    if (!step) throw new Error('fakeTransport: script esgotado — mais chamadas HTTP do que o esperado')
    if (step.networkError) throw new TypeError(step.networkError)
    if (step.hangUntilAbort) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status,
      headers: { 'content-type': 'application/json', ...step.headers },
    })
  }
  return { fetchFn, calls }
}

function makeLogger() {
  const lines: string[] = []
  return {
    lines,
    logger: {
      info: (...a: unknown[]) => void lines.push(`info ${a.join(' ')}`),
      warn: (...a: unknown[]) => void lines.push(`warn ${a.join(' ')}`),
      error: (...a: unknown[]) => void lines.push(`error ${a.join(' ')}`),
    },
  }
}

function makeClock(start = 1_700_000_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => void (t += ms) }
}

const OK_BODY = {
  query: 'dsh cordis plugins',
  answer: 'Tudo é plugin no DSH.',
  results: [
    { title: 'Cordis', url: 'https://example.com/cordis', content: 'microkernel composable', score: 0.91 },
    { title: 'DSH', url: 'https://example.com/dsh', content: 'harness de agentes', score: 0.72 },
  ],
  response_time: 1.23,
}

function setup(options: {
  keys?: string[]
  script: ScriptedResponse[]
  overrides?: Partial<PluginConfig>
  start?: number
}) {
  const config = assertValidConfig({
    securityProfile: { sandbox: 'workspace-write', approval: 'ask' },
    apiKeys: options.keys ?? [K1, K2],
    ...options.overrides,
  })
  const clock = makeClock(options.start)
  const { logger, lines } = makeLogger()
  const transport = fakeTransport(options.script)
  const keyManager = new TavilyKeyManager(config.apiKeys, { now: clock.now, allowEmpty: true })
  const deps: ExecutorDeps = {
    keyManager,
    fetchFn: transport.fetchFn,
    logger,
    now: clock.now,
    config,
  }
  const run = createSearchExecutor(deps)
  return { run, keyManager, clock, calls: transport.calls, logLines: lines, config }
}

const ARGS = { query: 'dsh cordis plugins' }
const EXEC = { signal: new AbortController().signal }

describe('search-executor — classificadores puros', () => {
  it('mapeia a tabela discriminatória de estados HTTP', () => {
    assert.equal(classifyStatus(200), 'success')
    assert.equal(classifyStatus(204), 'success')
    assert.equal(classifyStatus(400), 'invalid-request')
    assert.equal(classifyStatus(401), 'unauthorized')
    assert.equal(classifyStatus(403), 'forbidden')
    assert.equal(classifyStatus(429), 'rate-limited')
    assert.equal(classifyStatus(432), 'quota-exhausted')
    assert.equal(classifyStatus(433), 'paygo-exhausted')
    assert.equal(classifyStatus(500), 'transient')
    assert.equal(classifyStatus(503), 'transient')
    assert.equal(classifyStatus(418), 'unexpected')
  })

  it('interpreta Retry-After em segundos delta e em data HTTP', () => {
    const now = Date.UTC(2026, 8, 24, 12, 0, 0)
    assert.equal(parseRetryAfterSeconds('30', now), 30)
    assert.equal(parseRetryAfterSeconds(' 5 ', now), 5)
    assert.equal(parseRetryAfterSeconds(new Date(now + 90_000).toUTCString(), now), 90)
    assert.equal(parseRetryAfterSeconds(new Date(now - 90_000).toUTCString(), now), 0)
    assert.equal(parseRetryAfterSeconds('nonsense', now), undefined)
    assert.equal(parseRetryAfterSeconds(null, now), undefined)
    assert.equal(parseRetryAfterSeconds('', now), undefined)
  })
})

describe('search-executor — caminho feliz e normalização', () => {
  it('normaliza a resposta para o contrato canónico', async () => {
    const { run, calls } = setup({ script: [{ status: 200, body: OK_BODY }] })
    const out = await run(ARGS, EXEC)

    assert.equal(out.ok, true)
    assert.equal(out.query, 'dsh cordis plugins')
    assert.equal(out.answer, 'Tudo é plugin no DSH.')
    assert.equal(out.responseTime, 1.23)
    assert.equal(out.sources.length, 2)
    assert.deepEqual(out.sources[0], {
      title: 'Cordis',
      url: 'https://example.com/cordis',
      snippet: 'microkernel composable',
      score: 0.91,
    })
    assert.equal(out.resultsTruncated, false)
    assert.equal(out.keylessFallbackUsed, false)
    assert.equal(out.error, null)

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://api.tavily.com/search')
    assert.equal(calls[0]!.method, 'POST')
    assert.equal(calls[0]!.headers['authorization'], `Bearer ${K1}`)
    assert.equal(calls[0]!.headers['content-type'], 'application/json')
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>
    assert.deepEqual(body, {
      query: 'dsh cordis plugins',
      search_depth: 'basic',
      max_results: 5,
      topic: 'general',
      include_answer: true,
      chunks_per_source: 3,
    })
    // include_raw_content NUNCA enviado (salvaguarda de explosão de contexto)
    assert.ok(!('include_raw_content' in body))
  })

  it('propaga parâmetros do modelo (depth, max_results, topic) com clamp a 10', async () => {
    const { run, calls } = setup({
      script: [{ status: 200, body: OK_BODY }],
      overrides: { includeAnswer: false },
    })
    await run(
      { ...ARGS, search_depth: 'advanced', max_results: 99, topic: 'news' },
      EXEC,
    )
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>
    assert.equal(body['search_depth'], 'advanced')
    assert.equal(body['max_results'], 10)
    assert.equal(body['topic'], 'news')
    assert.equal(body['include_answer'], false)
  })

  it('envia X-Project-ID e X-Session-Id quando configurados/disponíveis', async () => {
    const { run, calls } = setup({
      script: [{ status: 200, body: OK_BODY }],
      overrides: { projectId: 'proj-alpha' },
    })
    await run(ARGS, { signal: new AbortController().signal, callId: 'call-42' })
    assert.equal(calls[0]!.headers['x-project-id'], 'proj-alpha')
    assert.equal(calls[0]!.headers['x-session-id'], 'call-42')
  })
})

describe('search-executor — rotação atómica de credenciais', () => {
  it('401 banem a chave e avança imediatamente para a próxima', async () => {
    const { run, keyManager, calls } = setup({
      keys: [K1, K2],
      script: [
        { status: 401, body: { detail: { error: 'invalid api key' } } },
        { status: 200, body: OK_BODY },
      ],
    })
    const out = await run(ARGS, EXEC)

    assert.equal(out.ok, true)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]!.headers['authorization'], `Bearer ${K1}`)
    assert.equal(calls[1]!.headers['authorization'], `Bearer ${K2}`)
    assert.equal(keyManager.getStatus(K1), 'REVOKED')

    // em chamadas futuras a chave banida não volta a ser usada: a1.ª alternativa
    // é K2 (script esgotado → falhas de rede seguras, sem ejetar o loop)
    const callsBefore = calls.length
    const second = await run(ARGS, EXEC)
    assert.equal(second.ok, false)
    assert.ok(calls.length > callsBefore)
    for (const call of calls.slice(callsBefore)) {
      assert.equal(call.headers['authorization'], `Bearer ${K2}`)
    }
  })

  it('429 com Retry-After marca cooldown exato e rotaciona', async () => {
    const { run, keyManager, clock, calls } = setup({
      keys: [K1, K2],
      script: [
        { status: 429, body: { detail: { error: 'rate limited' } }, headers: { 'Retry-After': '2' } },
        { status: 200, body: OK_BODY },
      ],
    })
    const out = await run(ARGS, EXEC)

    assert.equal(out.ok, true)
    assert.equal(calls.length, 2)
    assert.equal(calls[1]!.headers['authorization'], `Bearer ${K2}`)
    assert.equal(keyManager.getStatus(K1), 'RATE_LIMITED')
    assert.equal(keyManager.getCooldownUntil(K1), clock.now() + 2000)
  })

  it('429 sem Retry-After usa o recuo exponencial com jitter', async () => {
    const { run, keyManager, clock } = setup({
      keys: [K1, K2],
      script: [
        { status: 429, body: {} },
        { status: 200, body: OK_BODY },
      ],
    })
    await run(ARGS, EXEC)
    const delay = keyManager.getCooldownUntil(K1)! - clock.now()
    // k=1: min(60000, 500*2^1) + δ, δ ∈ [0,500)
    assert.ok(delay >= 1000 && delay < 1500, `delay=${delay} fora da banda`)
  })

  it('432 suspende a chave até ao mês seguinte (UTC) e rotaciona', async () => {
    const start = Date.UTC(2026, 8, 24, 12, 0, 0)
    const { run, keyManager, calls } = setup({
      keys: [K1, K2],
      script: [
        { status: 432, body: { detail: { error: 'plan limit reached' } } },
        { status: 200, body: OK_BODY },
      ],
      start,
    })
    const out = await run(ARGS, EXEC)

    assert.equal(out.ok, true)
    assert.equal(calls.length, 2)
    assert.equal(keyManager.getStatus(K1), 'QUOTA_EXHAUSTED')
    assert.equal(keyManager.getCooldownUntil(K1), Date.UTC(2026, 9, 1, 0, 0, 0))
  })

  it('433 (PAYGO) suspende igualmente e rotaciona', async () => {
    const { run, keyManager } = setup({
      keys: [K1, K2],
      script: [
        { status: 433, body: {} },
        { status: 200, body: OK_BODY },
      ],
    })
    const out = await run(ARGS, EXEC)
    assert.equal(out.ok, true)
    assert.equal(keyManager.getStatus(K1), 'QUOTA_EXHAUSTED')
  })

  it('pool esgotado ativa a contingência keyless (sem Authorization, X-Tavily-Access-Mode)', async () => {
    const { run, calls } = setup({
      keys: [K1],
      script: [
        { status: 432, body: {} },
        { status: 200, body: OK_BODY },
      ],
    })
    const out = await run(ARGS, EXEC)

    assert.equal(out.ok, true)
    assert.equal(out.keylessFallbackUsed, true)
    assert.equal(calls.length, 2)
    assert.equal(calls[1]!.headers['x-tavily-access-mode'], 'keyless')
    assert.ok(!('authorization' in calls[1]!.headers))
  })

  it('sem chaves configuradas opera em keyless-only desde a primeira chamada', async () => {
    const { run, calls } = setup({
      keys: [],
      script: [{ status: 200, body: OK_BODY }],
    })
    const out = await run(ARGS, EXEC)
    assert.equal(out.ok, true)
    assert.equal(out.keylessFallbackUsed, true)
    assert.equal(calls[0]!.headers['x-tavily-access-mode'], 'keyless')
    assert.ok(!('authorization' in calls[0]!.headers))
  })

  it('5xx transiente não muta estado de chave e tenta a alternativa', async () => {
    const { run, keyManager, calls } = setup({
      keys: [K1, K2],
      script: [
        { status: 502, body: {} },
        { status: 200, body: OK_BODY },
      ],
    })
    const out = await run(ARGS, EXEC)
    assert.equal(out.ok, true)
    assert.equal(calls.length, 2)
    assert.equal(keyManager.getStatus(K1), 'ACTIVE')
    assert.equal(keyManager.getStatus(K2), 'ACTIVE')
  })

  it('erro de rede retenta a alternativa sem ejetar o agent loop', async () => {
    const { run, calls } = setup({
      keys: [K1, K2],
      script: [{ networkError: 'ECONNRESET' }, { status: 200, body: OK_BODY }],
    })
    const out = await run(ARGS, EXEC)
    assert.equal(out.ok, true)
    assert.equal(calls.length, 2)
    assert.equal(calls[1]!.headers['authorization'], `Bearer ${K2}`)
  })
})

describe('search-executor — erros irrecuperáveis não rotacionam', () => {
  it('400 aborta com sugestão, sem trocar de credencial', async () => {
    const { run, keyManager, calls } = setup({
      keys: [K1, K2],
      script: [{ status: 400, body: { detail: { error: 'query is malformed' } } }],
    })
    const out = await run(ARGS, EXEC)

    assert.equal(out.ok, false)
    assert.equal(calls.length, 1)
    assert.match(out.detail ?? '', /HTTP 400: query is malformed/)
    assert.match(out.suggestion ?? '', /caracteres restritos/)
    assert.equal(keyManager.getStatus(K1), 'ACTIVE')
  })

  it('403 aborta informando impossibilidade de acesso, sem trocar de credencial', async () => {
    const { run, calls } = setup({
      keys: [K1, K2],
      script: [{ status: 403, body: {} }],
    })
    const out = await run(ARGS, EXEC)
    assert.equal(out.ok, false)
    assert.equal(calls.length, 1)
    assert.match(out.error ?? '', /interdito/)
  })
})

describe('search-executor — esgotamento total devolve conclusão válida (nunca lança)', () => {
  it('todas as alternativas falham → erro estruturado com sugestão de recuperação', async () => {
    const { run, calls } = setup({
      keys: [K1],
      script: [{ status: 500, body: {} }, { status: 500, body: {} }],
    })
    const out = await run(ARGS, EXEC)

    assert.equal(out.ok, false)
    assert.equal(calls.length, 2) // K1 + keyless
    assert.equal(out.error, 'Capacidade de pesquisa externa temporariamente inacessível.')
    assert.match(out.detail ?? '', /HTTP 500/)
    assert.match(out.suggestion ?? '', /base de código local/)
    assert.equal(out.sources.length, 0)
  })
})

describe('search-executor — cancelamento e timeout', () => {
  it('cancelamento do ciclo de execução rejeita com a mensagem contratada', async () => {
    const { run } = setup({ keys: [K1], script: [{ hangUntilAbort: true }] })
    const controller = new AbortController()
    const promise = run(ARGS, { signal: controller.signal })
    controller.abort()
    await assert.rejects(promise, /terminada pelo ciclo de execução do agente/)
  })

  it('timeout por tentativa é tratado como transiente e rotaciona', async () => {
    const { run, calls } = setup({
      keys: [K1, K2],
      script: [{ hangUntilAbort: true }, { status: 200, body: OK_BODY }],
      overrides: { timeoutMs: 250, callTimeoutMs: 10_000 },
    })
    const out = await run(ARGS, EXEC)
    assert.equal(out.ok, true)
    assert.equal(calls.length, 2)
  })
})

describe('search-executor — validação de entrada e salvaguarda volumétrica', () => {
  it('consulta vazia devolve erro estruturado sem chamada de rede', async () => {
    const { run, calls } = setup({ keys: [K1], script: [] })
    const out = await run({ query: '   ' }, EXEC)
    assert.equal(out.ok, false)
    assert.equal(calls.length, 0)
    assert.match(out.suggestion ?? '', /termos objetivos/)
  })

  it('consulta acima do limite duro é rejeitada localmente', async () => {
    const { run, calls } = setup({ keys: [K1], script: [] })
    const out = await run({ query: 'q'.repeat(5000) }, EXEC)
    assert.equal(out.ok, false)
    assert.equal(calls.length, 0)
    assert.match(out.error ?? '', /4000 caracteres/)
  })

  it('conteúdo gigante é truncado para o teto de 50 KB', async () => {
    const big = 'x'.repeat(200_000)
    const { run } = setup({
      keys: [K1],
      script: [
        {
          status: 200,
          body: { query: 'q', answer: big, results: [{ title: 't', url: 'u', content: big, score: 1 }] },
        },
      ],
    })
    const out = await run({ query: 'q' }, EXEC)
    assert.equal(out.ok, true)
    assert.equal(out.resultsTruncated, true)
    const total = utf8Bytes(out.answer ?? '') + out.sources.reduce((n, s) => n + utf8Bytes(s.snippet), 0)
    assert.ok(total <= 50 * 1024, `total=${total} excede 50 KB`)
  })
})
