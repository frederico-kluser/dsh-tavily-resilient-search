/**
 * Executor da ferramenta `web_search`: despacho HTTP com rotação ATÓMICA de
 * credenciais, retentativas transparentes e contingência keyless — sem nunca
 * propagar uma rejeição de promessa ao agent loop (exceto cancelamento).
 *
 * Separação deliberada: a intenção semântica (query) está desconhecida da
 * camada física de despacho; todo o estado de credenciais vive em
 * {@link TavilyKeyManager} e é mutado de forma síncrona.
 */
import type { TavilyKeyManager } from './key-manager.js'
import { applySharedBudget } from './text-budget.js'
import type {
  ExecContext,
  LoggerLike,
  ResolvedConfig,
  SearchArgs,
  SearchOutput,
  SourceRecord,
  TavilySearchResponse,
} from './types.js'

export const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search'

/** Limite duro de caracteres da consulta (a Tavily recomenda < 1500). */
export const MAX_QUERY_LENGTH = 4000

/** Teto de resultados qualificados por invocação. */
export const HARD_MAX_RESULTS = 10

/** Mensagem emitida quando o ciclo de execução cancela a operação. */
export const ABORTED_MESSAGE =
  'A operação de pesquisa na web foi terminada pelo ciclo de execução do agente.'

/** Classificação semântica do estado HTTP devolvido pela API Tavily. */
export type StatusClass =
  | 'success'
  | 'invalid-request'
  | 'forbidden'
  | 'unauthorized'
  | 'rate-limited'
  | 'quota-exhausted'
  | 'paygo-exhausted'
  | 'transient'
  | 'unexpected'

/**
 * Tabela discriminatória de estados HTTP (núcleo da lógica de rotação):
 * 2xx sucesso · 400 malformado (não rotaciona) · 401 revogada · 403 interdito ·
 * 429 limite de taxa · 432 cota mensal · 433 teto PAYGO · 5xx transiente.
 */
export function classifyStatus(status: number): StatusClass {
  if (status >= 200 && status < 300) return 'success'
  if (status === 400) return 'invalid-request'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 429) return 'rate-limited'
  if (status === 432) return 'quota-exhausted'
  if (status === 433) return 'paygo-exhausted'
  if (status >= 500 && status < 600) return 'transient'
  return 'unexpected'
}

/**
 * Interpreta o cabeçalho `Retry-After` (segundos delta-HTTP ou data HTTP) em
 * segundos. Devolve `undefined` quando ausente ou ilegível — o chamador aplica
 * então o recuo exponencial truncado com jitter.
 */
export function parseRetryAfterSeconds(headerValue: string | null, nowMs: number): number | undefined {
  if (!headerValue) return undefined
  const trimmed = headerValue.trim()
  if (trimmed.length === 0) return undefined
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)
  const dateMs = Date.parse(trimmed)
  if (Number.isNaN(dateMs)) return undefined
  return Math.max(0, Math.ceil((dateMs - nowMs) / 1000))
}

/**
 * Identificação de credencial em registos: apenas os ÚLTIMOS 4 caracteres.
 * Nunca o prefixo — o prefixo é material de segredo e não entra em logs.
 */
export function maskKey(key: string): string {
  const suffix = key.length <= 4 ? '····' : key.slice(-4)
  return `…${suffix}`
}

/**
 * Redação de segredos POR VALOR (defesa em profundidade contra exfiltração):
 * qualquer ocorrência de material de credencial em texto é substituída. Um
 * corpo de resposta malicioso que ecoasse a chave recebida no `Authorization`
 * nunca a propaga para o contexto do modelo nem para os registos.
 */
export function redactSecrets(text: string, keys: readonly string[]): string {
  let out = text
  for (const key of keys) {
    if (key.length >= 4 && out.includes(key)) out = out.split(key).join('[REDACTED]')
  }
  return out
}

/** Aplica a redação a todos os campos de texto do valor canónico. */
export function applyRedaction(out: SearchOutput, redact: (text: string) => string): SearchOutput {
  return {
    ...out,
    query: redact(out.query),
    answer: out.answer === null ? null : redact(out.answer),
    error: out.error === null ? null : redact(out.error),
    detail: out.detail === null ? null : redact(out.detail),
    suggestion: out.suggestion === null ? null : redact(out.suggestion),
    sources: out.sources.map((s) => ({
      ...s,
      title: redact(s.title),
      url: redact(s.url),
      snippet: redact(s.snippet),
    })),
  }
}

export interface ExecutorDeps {
  keyManager: TavilyKeyManager
  /** Injeção do transporte HTTP (testes usam um double com contrato). */
  fetchFn: typeof fetch
  logger: LoggerLike
  /** Relógio injetável (ms epoch) — determinismo em testes. */
  now: () => number
  config: ResolvedConfig
}

function failure(
  query: string,
  error: string,
  detail: string | null,
  suggestion: string | null,
  keylessFallbackUsed: boolean,
): SearchOutput {
  return {
    ok: false,
    query,
    answer: null,
    sources: [],
    responseTime: null,
    resultsTruncated: false,
    keylessFallbackUsed,
    error,
    detail,
    suggestion,
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: unknown }
    const detail = payload?.detail
    if (detail && typeof detail === 'object' && typeof (detail as { error?: unknown }).error === 'string') {
      return (detail as { error: string }).error
    }
    if (typeof detail === 'string' && detail.length > 0) return detail
  } catch {
    // corpo não-JSON: cai para o statusText
  }
  return response.statusText || `HTTP ${response.status}`
}

/**
 * Cria a função `execute` da ferramenta. O ciclo de retentativa itera pelas
 * credenciais ativas; em erro de saturação/faturação muta o estado da chave
 * causadora e reemite a requisição com o payload INTACTO, escolhendo de imediato
 * o próximo descritor desimpedido. Quando todo o pool está impedido, a última
 * tentativa recorre ao modo keyless (`X-Tavily-Access-Mode: keyless`).
 */
export function createSearchExecutor(deps: ExecutorDeps) {
  const { keyManager, fetchFn, now, config } = deps

  // Defesa em profundidade (canário de segredos por valor): material de
  // credencial é removido de TODO o texto de saída e de registos.
  const redactAll = (text: string): string => redactSecrets(text, config.apiKeys)
  const safeArg = (x: unknown): unknown => (typeof x === 'string' ? redactAll(x) : x)
  const logger: LoggerLike = {
    info: (...a) => deps.logger.info(...a.map(safeArg)),
    warn: (...a) => deps.logger.warn(...a.map(safeArg)),
    error: (...a) => deps.logger.error(...a.map(safeArg)),
  }

  async function runSearchInner(args: SearchArgs, exec: ExecContext): Promise<SearchOutput> {
    const query = typeof args.query === 'string' ? args.query.trim() : ''

    if (query.length === 0) {
      return failure(
        '',
        'A consulta de pesquisa está vazia.',
        null,
        'Formule termos objetivos e refinados antes de pesquisar.',
        false,
      )
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return failure(
        query.slice(0, 64),
        `A consulta excede o limite de ${MAX_QUERY_LENGTH} caracteres (${query.length}).`,
        null,
        'Condense a consulta para menos de 1500 caracteres (recomendado).',
        false,
      )
    }

    const depth = args.search_depth ?? config.searchDepth
    const requestedMax = typeof args.max_results === 'number' ? args.max_results : config.maxResults
    const maxResults = Math.min(Math.max(1, Math.trunc(requestedMax)), HARD_MAX_RESULTS)
    const topic = args.topic ?? 'general'

    // include_raw_content é deliberadamente NUNCA enviado: texto integral sem
    // resumo provoca explosão de contexto (ver salvaguarda volumétrica).
    const body = JSON.stringify({
      query,
      search_depth: depth,
      max_results: maxResults,
      topic,
      include_answer: config.includeAnswer,
      chunks_per_source: 3,
    })

    const maxAttempts = keyManager.size + 1
    let attempts = 0
    let keylessFallbackUsed = false
    let lastErrorNarrative = 'Nenhuma credencial disponível para processamento.'

    while (attempts < maxAttempts) {
      attempts++

      if (exec.signal.aborted) throw new Error(ABORTED_MESSAGE)

      const keyMeta = keyManager.getNextKey()
      const isKeylessFallback = keyMeta === null
      const keyRef = keyMeta ? maskKey(keyMeta.key) : 'keyless'

      if (isKeylessFallback) {
        keylessFallbackUsed = true
        logger.warn(
          '[dsh-tavily-resilient-search] Agrupamento Tavily sem credenciais desimpedidas — contingência sem chave (keyless).',
        )
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (isKeylessFallback) {
        headers['X-Tavily-Access-Mode'] = 'keyless'
      } else {
        headers['Authorization'] = `Bearer ${keyMeta!.key}`
      }
      if (config.projectId !== null) headers['X-Project-ID'] = config.projectId
      const sessionId = exec.rootCallId ?? exec.callId
      if (typeof sessionId === 'string' && sessionId.length > 0) headers['X-Session-Id'] = sessionId

      const timeoutController = new AbortController()
      let timedOut = false
      const timeoutTimer = setTimeout(() => {
        timedOut = true
        timeoutController.abort()
      }, config.timeoutMs)
      const onParentAbort = (): void => timeoutController.abort()
      exec.signal.addEventListener('abort', onParentAbort, { once: true })

      try {
        const response = await fetchFn(TAVILY_SEARCH_ENDPOINT, {
          method: 'POST',
          headers,
          body,
          signal: timeoutController.signal,
        })

        if (response.ok) {
          let payload: TavilySearchResponse
          try {
            payload = (await response.json()) as TavilySearchResponse
          } catch {
            lastErrorNarrative = 'Corpo de resposta ilegível (JSON inválido).'
            continue
          }

          const rawSources = Array.isArray(payload.results) ? payload.results : []
          const sources: SourceRecord[] = rawSources.slice(0, HARD_MAX_RESULTS).map((r) => ({
            title: typeof r?.title === 'string' ? r.title : '',
            url: typeof r?.url === 'string' ? r.url : '',
            snippet: typeof r?.content === 'string' ? r.content : '',
            score: typeof r?.score === 'number' ? r.score : 0,
          }))
          const answer = typeof payload.answer === 'string' ? payload.answer : null

          // Salvaguarda volumétrica: 50 KB de texto no TOTAL (resposta + snippets).
          const budgeted = applySharedBudget([answer ?? '', ...sources.map((s) => s.snippet)])
          const budgetedAnswer = budgeted.parts[0] ?? ''
          for (let i = 0; i < sources.length; i++) {
            sources[i]!.snippet = budgeted.parts[i + 1] ?? ''
          }

          return {
            ok: true,
            query: typeof payload.query === 'string' ? payload.query : query,
            answer: answer !== null && budgetedAnswer.length > 0 ? budgetedAnswer : null,
            sources,
            responseTime: typeof payload.response_time === 'number' ? payload.response_time : null,
            resultsTruncated: budgeted.truncated,
            keylessFallbackUsed,
            error: null,
            detail: null,
            suggestion: null,
          }
        }

        const statusCode = response.status
        const errorDetail = await readErrorDetail(response)
        lastErrorNarrative = `HTTP ${statusCode}: ${errorDetail}`
        const statusClass = classifyStatus(statusCode)

        if (keyMeta) {
          if (statusClass === 'quota-exhausted' || statusClass === 'paygo-exhausted') {
            logger.error(
              `[dsh-tavily-resilient-search] Chave ${keyRef} com cota de créditos esgotada (HTTP ${statusCode}). Suspendendo até à reposição mensal (1.º dia do mês, UTC).`,
            )
            keyManager.markQuotaExhausted(keyMeta.key)
            continue
          }

          if (statusClass === 'rate-limited') {
            const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('Retry-After'), now())
            logger.warn(
              `[dsh-tavily-resilient-search] Chave ${keyRef} atingiu o limite de taxa (HTTP 429). Arrefecimento de ${retryAfterSeconds ?? '…'}s.`,
            )
            keyManager.markRateLimited(keyMeta.key, retryAfterSeconds)
            continue
          }

          if (statusClass === 'unauthorized') {
            logger.error(
              `[dsh-tavily-resilient-search] Chave ${keyRef} revogada ou inválida (HTTP 401). Removida em definitivo do agrupamento ativo.`,
            )
            keyManager.markRevoked(keyMeta.key)
            continue
          }
        }

        if (statusClass === 'transient') {
          logger.warn(
            `[dsh-tavily-resilient-search] Instabilidade transiente nos servidores Tavily (HTTP ${statusCode}); tentando a próxima alternativa...`,
          )
          continue
        }

        // 400/403 e restantes 4xx são irrecuperáveis por rotação: NÃO se troca de
        // credencial (o problema é o payload ou o acesso, não a chave).
        if (statusClass === 'invalid-request') {
          return failure(
            query,
            `Falha na requisição de busca: ${lastErrorNarrative}`,
            lastErrorNarrative,
            'Verifique se os termos de busca contêm caracteres restritos ou parâmetros incompatíveis.',
            keylessFallbackUsed,
          )
        }
        if (statusClass === 'forbidden') {
          return failure(
            query,
            `Acesso ao recurso interdito: ${lastErrorNarrative}`,
            lastErrorNarrative,
            'O domínio ou a rota está indisponível para esta conta (restrição geográfica ou de plano). Prossiga com outras fontes.',
            keylessFallbackUsed,
          )
        }
        return failure(
          query,
          `Falha na requisição de busca: ${lastErrorNarrative}`,
          lastErrorNarrative,
          'Reformule a pesquisa ou tente novamente mais tarde.',
          keylessFallbackUsed,
        )
      } catch (fetchErr) {
        if (exec.signal.aborted) throw new Error(ABORTED_MESSAGE, { cause: fetchErr })
        const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
        lastErrorNarrative = timedOut
          ? `Timeout após ${config.timeoutMs}ms sem resposta da API Tavily.`
          : `Erro de comunicação no soquete de rede: ${message}`
        logger.warn(`[dsh-tavily-resilient-search] ${lastErrorNarrative} A tentar a próxima alternativa...`)
        continue
      } finally {
        clearTimeout(timeoutTimer)
        exec.signal.removeEventListener('abort', onParentAbort)
      }
    }

    // Esgotadas TODAS as alternativas de transporte: conclusão lógica VÁLIDA da
    // ferramenta — nunca uma exceção que ejetasse o agent loop do DSH.
    return failure(
      query,
      'Capacidade de pesquisa externa temporariamente inacessível.',
      lastErrorNarrative,
      'Prossiga o raciocínio recorrendo ao contexto da base de código local.',
      keylessFallbackUsed,
    )
  }

  // Ponto de saída ÚNICO: tudo o que o executor devolve passa pela redação de
  // segredos por valor antes de chegar ao modelo/registry.
  return async function runSearch(args: SearchArgs, exec: ExecContext): Promise<SearchOutput> {
    return applyRedaction(await runSearchInner(args, exec), redactAll)
  }
}
