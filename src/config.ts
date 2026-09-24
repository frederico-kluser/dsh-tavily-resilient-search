/**
 * Validação fail-loud da configuração declarativa.
 *
 * Regra de ouro (anti-pattern P-06 / baseline de segurança): configuração
 * inválida ou perfil de segurança inseguro FAZEM THROW no `apply()` — nunca se
 * cai silenciosamente num default permissivo. Valores em falta tornam-se o
 * default DOCUMENTADO; a conjugação proibida é irrecuperável de propósito.
 */
import type {
  AdminConfig,
  ApprovalProfile,
  PluginConfig,
  ResolvedAdminConfig,
  ResolvedConfig,
  SandboxProfile,
  SearchDepth,
  SecurityProfile,
} from './types.js'

const SEARCH_DEPTHS: readonly SearchDepth[] = ['ultra-fast', 'fast', 'basic', 'advanced']
const SANDBOXES: readonly SandboxProfile[] = ['workspace-write', 'danger-full-access']
const APPROVALS: readonly ApprovalProfile[] = ['ask', 'never']

export const DEFAULT_SEARCH_DEPTH: SearchDepth = 'basic'
export const DEFAULT_MAX_RESULTS = 5
export const DEFAULT_INCLUDE_ANSWER = true
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_CALL_TIMEOUT_MS = 120_000

const MIN_TIMEOUT_MS = 250
const MAX_TIMEOUT_MS = 300_000

/** Origens de soquete admitidas por omissão no painel (loopback). */
export const DEFAULT_TRUSTED_REMOTES: readonly string[] = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
/** Nomes de Host admitidos por omissão no painel (defesa contra DNS rebinding). */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1']

const PREFIX = '[dsh-tavily-resilient-search]'

/** Mensagem da recusa de carga sob a conjugação perigosa (proibida de propósito). */
export const FORBIDDEN_PROFILE_MESSAGE =
  `${PREFIX} Recusa de carga (fail-closed): a conjugação securityProfile ` +
  `{ sandbox: 'danger-full-access', approval: 'never' } é proibida com este plugin. ` +
  `Uma fonte web envenenada (indirect prompt injection) poderia induzir execução de ` +
  `terminal sem escrutínio. Use sandbox: 'workspace-write' e/ou approval: 'ask'.`

function fail(message: string): never {
  throw new Error(`${PREFIX} Configuração inválida: ${message}`)
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(`'${field}' deve ser um de ${allowed.map((a) => `"${a}"`).join(', ')} (recebido: ${JSON.stringify(value)})`)
  }
  return value as T
}

function assertPositiveInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(`'${field}' deve ser um inteiro em [${min}, ${max}] (recebido: ${JSON.stringify(value)})`)
  }
  return value
}

function assertSecurityProfile(value: unknown): SecurityProfile {
  if (!value || typeof value !== 'object') {
    fail(`'securityProfile' é obrigatório (atestação explícita do perfil de instalação): ` +
      `{ sandbox: 'workspace-write' | 'danger-full-access', approval: 'ask' | 'never' }`)
  }
  const profile = value as Partial<SecurityProfile>
  const sandbox = assertEnum(profile.sandbox, SANDBOXES, 'securityProfile.sandbox')
  const approval = assertEnum(profile.approval, APPROVALS, 'securityProfile.approval')
  if (sandbox === 'danger-full-access' && approval === 'never') {
    // Fail-loud irrecuperável: explicit > implicit. Ver FORBIDDEN_PROFILE_MESSAGE.
    throw new Error(FORBIDDEN_PROFILE_MESSAGE)
  }
  return { sandbox, approval }
}

function normalizeApiKeys(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail(`'apiKeys' deve ser um array de strings (recebido: ${typeof value})`)
  const seen = new Set<string>()
  const keys: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      fail(`'apiKeys' deve conter apenas strings (recebido: ${typeof entry})`)
    }
    const key = entry.trim()
    if (key.length === 0) continue // entrada vazia = não configurada; filtrada, como no manifesto
    if (seen.has(key)) continue // dedupe estável; duplicados não dobram a capacidade do pool
    seen.add(key)
    keys.push(key)
  }
  return keys
}

function assertStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`'${field}' deve ser um array não vazio de strings`)
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      fail(`'${field}' deve conter apenas strings não vazias`)
    }
    out.push(entry.trim())
  }
  return out
}

function assertAdminConfig(value: unknown): ResolvedAdminConfig {
  if (value === undefined || value === null) {
    return {
      enabled: true,
      trustedRemotes: [...DEFAULT_TRUSTED_REMOTES],
      allowedHosts: [...DEFAULT_ALLOWED_HOSTS],
      stateDir: null,
      allowPublicBind: false,
      storeTokenFile: true,
    }
  }
  if (typeof value !== 'object') fail(`'admin' deve ser um objeto`)
  const admin = value as AdminConfig
  if (admin.enabled !== undefined && typeof admin.enabled !== 'boolean') {
    fail(`'admin.enabled' deve ser booleano`)
  }
  if (admin.allowPublicBind !== undefined && typeof admin.allowPublicBind !== 'boolean') {
    fail(`'admin.allowPublicBind' deve ser booleano`)
  }
  if (admin.storeTokenFile !== undefined && typeof admin.storeTokenFile !== 'boolean') {
    fail(`'admin.storeTokenFile' deve ser booleano`)
  }
  if (admin.stateDir !== undefined && (typeof admin.stateDir !== 'string' || admin.stateDir.trim().length === 0)) {
    fail(`'admin.stateDir' deve ser uma string não vazia`)
  }
  return {
    enabled: admin.enabled ?? true,
    trustedRemotes:
      admin.trustedRemotes === undefined ? [...DEFAULT_TRUSTED_REMOTES] : assertStringList(admin.trustedRemotes, 'admin.trustedRemotes'),
    allowedHosts:
      admin.allowedHosts === undefined ? [...DEFAULT_ALLOWED_HOSTS] : assertStringList(admin.allowedHosts, 'admin.allowedHosts'),
    stateDir: admin.stateDir?.trim() ?? null,
    allowPublicBind: admin.allowPublicBind ?? false,
    storeTokenFile: admin.storeTokenFile ?? true,
  }
}

/**
 * Valida e materializa a configuração. Lança em configuração inválida ou no
 * perfil proibido `danger-full-access + never`.
 */
export function assertValidConfig(config: PluginConfig | undefined): ResolvedConfig {
  if (!config || typeof config !== 'object') {
    fail(`configuração ausente — declare pelo menos 'securityProfile'`)
  }

  const securityProfile = assertSecurityProfile(config.securityProfile)
  const apiKeys = normalizeApiKeys(config.apiKeys)

  const searchDepth =
    config.searchDepth === undefined
      ? DEFAULT_SEARCH_DEPTH
      : assertEnum(config.searchDepth, SEARCH_DEPTHS, 'searchDepth')

  const maxResults =
    config.maxResults === undefined
      ? DEFAULT_MAX_RESULTS
      : assertPositiveInt(config.maxResults, 'maxResults', 1, 100)

  const includeAnswer =
    config.includeAnswer === undefined ? DEFAULT_INCLUDE_ANSWER : config.includeAnswer
  if (typeof includeAnswer !== 'boolean') fail(`'includeAnswer' deve ser booleano`)

  const timeoutMs =
    config.timeoutMs === undefined
      ? DEFAULT_TIMEOUT_MS
      : assertPositiveInt(config.timeoutMs, 'timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)

  const callTimeoutMs =
    config.callTimeoutMs === undefined
      ? DEFAULT_CALL_TIMEOUT_MS
      : assertPositiveInt(config.callTimeoutMs, 'callTimeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)

  if (callTimeoutMs < timeoutMs) {
    fail(`'callTimeoutMs' (${callTimeoutMs}) não pode ser inferior a 'timeoutMs' (${timeoutMs})`)
  }

  let projectId: string | null = null
  if (config.projectId !== undefined) {
    if (typeof config.projectId !== 'string' || config.projectId.trim().length === 0) {
      fail(`'projectId' deve ser uma string não vazia`)
    }
    projectId = config.projectId.trim()
  }

  return {
    apiKeys,
    searchDepth,
    maxResults,
    includeAnswer,
    timeoutMs,
    callTimeoutMs,
    projectId,
    admin: assertAdminConfig(config.admin),
    securityProfile,
  }
}
