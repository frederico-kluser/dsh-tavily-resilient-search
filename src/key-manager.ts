/**
 * Gestor do agrupamento de credenciais Tavily — máquina de estados finita por
 * chave, com distribuição round-robin.
 *
 * Estados: ACTIVE → RATE_LIMITED (429) → ACTIVE (após cooldown)
 *          ACTIVE → QUOTA_EXHAUSTED (432/433) → ACTIVE (após reposição mensal UTC)
 *          ACTIVE → REVOKED (401) — excluída em definitivo
 *
 * Mutações são síncronas sobre propriedades (event loop do Node.js), pelo que a
 * atualização de estado é atómica face ao despacho.
 *
 * Determinismo (testes): relógio e jitter são INJETÁVEIS — sem leituras nuas de
 * Date.now()/Math.random() dentro da lógica.
 */

export type KeyStatus = 'ACTIVE' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'REVOKED'

export interface KeyMetadata {
  key: string
  status: KeyStatus
  cooldownUntil: number
  failureCount: number
  totalRequests: number
}

export interface KeyManagerOptions {
  /** Relógio injetável (ms desde a epoch). Por omissão, Date.now(). */
  now?: () => number
  /** Gerador injetável do jitter δ ∈ [0,1). Por omissão, Math.random. */
  random?: () => number
  /** Arranque com pool vazio (modo keyless-only documentado). Por omissão, falha alto. */
  allowEmpty?: boolean
}

/** $T_0$ — patamar basal de arrefecimento exponencial (ms). */
export const COOLDOWN_BASE_MS = 500
/** $T_{\max}$ — teto do recuo exponencial truncado (ms). */
export const COOLDOWN_MAX_MS = 60_000
/** Amplitude máxima do jitter $\delta$ (ms). */
export const COOLDOWN_JITTER_MS = 500

export class TavilyKeyManager {
  private keys: KeyMetadata[]
  private currentIndex: number = 0
  private readonly now: () => number
  private readonly random: () => number

  constructor(apiKeys: string[], options: KeyManagerOptions = {}) {
    if (!apiKeys || apiKeys.length === 0) {
      if (!options.allowEmpty) {
        throw new Error('[dsh-tavily-resilient-search] É obrigatório configurar pelo menos uma chave Tavily válida.')
      }
    }
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? Math.random
    this.keys = (apiKeys ?? []).map((key) => ({
      key,
      status: 'ACTIVE',
      cooldownUntil: 0,
      failureCount: 0,
      totalRequests: 0,
    }))
  }

  /** Dimensão do agrupamento (número de credenciais configuradas, independentemente do estado). */
  public get size(): number {
    return this.keys.length
  }

  /**
   * Seleciona a próxima credencial desimpedida (round-robin sobre as ACTIVE),
   * revivendo primeiro as chaves cujo arrefecimento expirou.
   *
   * Devolve `null` quando não há nenhuma credencial disponível — o chamador
   * ativa então a contingência keyless.
   */
  public getNextKey(): KeyMetadata | null {
    const now = this.now()
    const poolSize = this.keys.length

    // Recuperação determinística: RATE_LIMITED e QUOTA_EXHAUSTED voltam a ACTIVE
    // quando o cooldown expira. REVOKED nunca volta (irrecuperável por definição).
    for (const keyMeta of this.keys) {
      if (keyMeta.status !== 'REVOKED' && keyMeta.status !== 'ACTIVE' && now >= keyMeta.cooldownUntil) {
        keyMeta.status = 'ACTIVE'
        keyMeta.cooldownUntil = 0
        keyMeta.failureCount = 0
      }
    }

    for (let i = 0; i < poolSize; i++) {
      const idx = (this.currentIndex + i) % poolSize
      const candidate = this.keys[idx]!
      if (candidate.status === 'ACTIVE') {
        this.currentIndex = (idx + 1) % poolSize
        candidate.totalRequests++
        return candidate
      }
    }

    return null
  }

  /**
   * HTTP 429 — limite de taxa. Transita para RATE_LIMITED com
   * $T = T_{Retry\text{-}After}$ quando presente; caso contrário
   * $T = \min(T_{\max}, T_0 \cdot 2^{k}) + \delta$, com $k$ = saturações
   * consecutivas da chave e $\delta \in [0, 500)$ ms contra ressaturação em bloco.
   */
  public markRateLimited(key: string, retryAfterSeconds?: number): void {
    const keyMeta = this.keys.find((k) => k.key === key)
    if (!keyMeta) return

    keyMeta.status = 'RATE_LIMITED'
    keyMeta.failureCount++

    const delayMs =
      retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? retryAfterSeconds * 1000
        : Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * Math.pow(2, keyMeta.failureCount)) +
          Math.floor(this.random() * COOLDOWN_JITTER_MS)

    keyMeta.cooldownUntil = this.now() + delayMs
  }

  /**
   * HTTP 432/433 — cota mensal ou teto PAYGO esgotado. A Tavily repõe as cotas no
   * primeiro instante do primeiro dia do mês civil (UTC), pelo que a credencial
   * fica suspensa até à meia-noite UTC do mês seguinte.
   */
  public markQuotaExhausted(key: string): void {
    const keyMeta = this.keys.find((k) => k.key === key)
    if (!keyMeta) return

    keyMeta.status = 'QUOTA_EXHAUSTED'
    keyMeta.failureCount++
    const now = new Date(this.now())
    const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0)
    keyMeta.cooldownUntil = nextMonth
  }

  /** HTTP 401 — violação irrecuperável de autorização: excluída em definitivo. */
  public markRevoked(key: string): void {
    const keyMeta = this.keys.find((k) => k.key === key)
    if (!keyMeta) return
    keyMeta.status = 'REVOKED'
  }

  /** Estado atual de uma credencial (observabilidade e testes). */
  public getStatus(key: string): KeyStatus | undefined {
    return this.keys.find((k) => k.key === key)?.status
  }

  /**
   * Instante (ms epoch) até ao qual a credencial está indisponível, ou 0.
   * Para observabilidade sem expor material de segredo.
   */
  public getCooldownUntil(key: string): number | undefined {
    return this.keys.find((k) => k.key === key)?.cooldownUntil
  }
}
