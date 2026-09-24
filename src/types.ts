/**
 * Tipos de fio da API Tavily e contrato canónico da ferramenta `web_search`.
 *
 * Os DTOs Tavily espelham o endpoint POST https://api.tavily.com/search tal como
 * documentado no briefing de arquitetura; campos ausentes são tratados como
 * ausentes (a API pode omitir `answer` / `response_time`).
 */

/** Profundidades de pesquisa aceites pelo endpoint /search. */
export type SearchDepth = 'ultra-fast' | 'fast' | 'basic' | 'advanced'

/** Segmentação temática aceite pelo endpoint /search. */
export type SearchTopic = 'general' | 'news'

/** Argumentos do modelo para `web_search`. */
export interface SearchArgs {
  query: string
  search_depth?: SearchDepth
  max_results?: number
  topic?: SearchTopic
}

/** Uma fonte qualificada devolvida ao modelo. */
export interface SourceRecord {
  title: string
  url: string
  snippet: string
  score: number
}

/**
 * Valor canónico (lossless JSON) devolvido por `web_search`.
 *
 * Forma TOTAL: todos os campos presentes sempre, com `null` explícito quando
 * não aplicável — previsível para o modelo e para testes, sem campos omitidos.
 */
export interface SearchOutput {
  ok: boolean
  query: string
  answer: string | null
  sources: SourceRecord[]
  responseTime: number | null
  resultsTruncated: boolean
  keylessFallbackUsed: boolean
  error: string | null
  detail: string | null
  suggestion: string | null
}

/** Um resultado bruto devolvido pelo endpoint /search. */
export interface TavilySearchResult {
  title: string
  url: string
  content: string
  score: number
}

/** Corpo de resposta do endpoint /search. */
export interface TavilySearchResponse {
  query: string
  answer?: string
  results?: TavilySearchResult[]
  response_time?: number
}

/** Eixo de isolamento de recursos (sandbox). */
export type SandboxProfile = 'workspace-write' | 'danger-full-access'

/** Eixo de validação humana (approval). */
export type ApprovalProfile = 'ask' | 'never'

/** Atestação do perfil de segurança da instalação (obrigatória; fail-closed). */
export interface SecurityProfile {
  sandbox: SandboxProfile
  approval: ApprovalProfile
}

/** Configuração do painel de gestão de chaves servido no webServer do DSH. */
export interface AdminConfig {
  /** Predefinição: true. Sem webServer (headless) o painel simplesmente não sobe. */
  enabled?: boolean
  /** Origens de soquete admitidas (trustedRemotes). Predefinição: loopback. */
  trustedRemotes?: string[]
  /** Nomes de Host admitidos (defesa contra DNS rebinding). Predefinição: loopback. */
  allowedHosts?: string[]
  /** Diretório de estado (0700) — predefinição: $DSH_HOME/dsh-tavily-resilient-search. */
  stateDir?: string
  /** Opt-out explícito da recusa de bind não-loopback (fail-closed por omissão). */
  allowPublicBind?: boolean
  /**
   * Guardar o token administrativo em `admin-token.txt` (0600) para recuperação
   * local. Predefinição: true (documentado em docs/seguranca.md).
   */
  storeTokenFile?: boolean
}

/** AdminConfig totalmente materializada. */
export interface ResolvedAdminConfig {
  enabled: boolean
  trustedRemotes: string[]
  allowedHosts: string[]
  stateDir: string | null
  allowPublicBind: boolean
  storeTokenFile: boolean
}

/** Configuração declarativa do plugin (camadas Bundle < Profile < Home < CLI overlay). */
export interface PluginConfig {
  /** Agrupamento de credenciais Tavily. Ausente/vazio = modo keyless-only (legítimo, documentado). */
  apiKeys?: string[]
  searchDepth?: SearchDepth
  maxResults?: number
  includeAnswer?: boolean
  /** Timeout por tentativa HTTP (ms). */
  timeoutMs?: number
  /** Orçamento cooperativo total da chamada da ferramenta (ms), declarado ao registry. */
  callTimeoutMs?: number
  /** Segregação por projeto (cabeçalho X-Project-ID). */
  projectId?: string
  /** Painel de gestão de chaves via interface (predefinição: ativo, restrito a loopback). */
  admin?: AdminConfig
  /** Atestação do perfil de segurança — obrigatória. */
  securityProfile: SecurityProfile
}

/** Configuração totalmente materializada após validação fail-loud. */
export interface ResolvedConfig {
  apiKeys: string[]
  searchDepth: SearchDepth
  maxResults: number
  includeAnswer: boolean
  timeoutMs: number
  callTimeoutMs: number
  projectId: string | null
  admin: ResolvedAdminConfig
  securityProfile: SecurityProfile
}

/**
 * Superfície mínima de logging usada pelo executor. `ctx.logger(nome)` do Cordis
 * satisfaz isto estruturalmente (LoggerService estende Record<LoggerType, LoggerMethod>).
 */
export interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * Contexto de execução mínimo de que o executor precisa. O `ToolRunContext` real
 * do @deepseek-ai/dsh-tools é estruturalmente compatível (superset).
 */
export interface ExecContext {
  readonly signal: AbortSignal
  readonly callId?: unknown
  readonly rootCallId?: unknown
}
