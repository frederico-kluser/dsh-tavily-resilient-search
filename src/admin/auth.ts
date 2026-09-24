/**
 * Credencial administrativa, limitador de falhas e nonce de confirmação.
 *
 * Baseline (docs/seguranca.md):
 *  - token gerado por CSPRNG (32 bytes = 256 bits ≥ 128 exigidos); só o digest
 *    sha256 é guardado em estado (0600); a comparação é `timingSafeEqual` sobre
 *    digests de tamanho fixo (32 bytes) — nunca sobre o segredo à vista;
 *  - teto de falhas NIST SP 800-63B-4 §3.2.2: no máximo 100 falhas
 *    consecutivas por origem antes de desativar o autenticador; sucesso
 *    reinicia o orçamento (recomendação NIST); o lockout responde EXATAMENTE o
 *    mesmo 401 — nunca um 429, para não ser oráculo;
 *  - ações destrutivas exigem um nonce de confirmação (defesa contra confused
 *    deputy / replay): uso único, com prazo, ligado a (ação, alvo, origem).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { sha256Hex } from './store.js'

/** Teto de falhas consecutivas (NIST SP 800-63B-4 §3.2.2). */
export const AUTH_FAILURE_LIMIT = 100

/** Prazo de validade do nonce de confirmação (ms). */
export const NONCE_TTL_MS = 120_000

export function generateAdminToken(): string {
  return randomBytes(32).toString('hex')
}

export function digestToken(token: string): string {
  return sha256Hex(token)
}

/**
 * Comparação em tempo constante sobre digests sha256 de tamanho fixo.
 * `storedDigest` malformado devolve `false` sem lançar.
 */
export function verifyToken(candidate: string | undefined, storedDigest: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  if (!/^[0-9a-f]{64}$/.test(storedDigest)) return false
  const a = Buffer.from(digestToken(candidate), 'hex')
  const b = Buffer.from(storedDigest, 'hex')
  return timingSafeEqual(a, b)
}

/** Orçamento de falhas por origem (socket), com recuperação local. */
export class AuthFailureTracker {
  private readonly failures = new Map<string, number>()

  constructor(private readonly limit: number = AUTH_FAILURE_LIMIT) {}

  public isLocked(remote: string): boolean {
    return (this.failures.get(remote) ?? 0) >= this.limit
  }

  public registerFailure(remote: string): number {
    const next = (this.failures.get(remote) ?? 0) + 1
    this.failures.set(remote, next)
    return next
  }

  /** Sucesso descarta as falhas anteriores (recomendação NIST). */
  public registerSuccess(remote: string): void {
    this.failures.delete(remote)
  }

  public failureCount(remote: string): number {
    return this.failures.get(remote) ?? 0
  }
}

interface NonceGrant {
  action: string
  target: string
  remote: string
  expiresAt: number
}

/** Nonces de confirmação de ações destrutivas (uso único, prazo, ligados). */
export class NonceStore {
  private readonly grants = new Map<string, NonceGrant>()

  constructor(private readonly now: () => number) {}

  public issue(action: string, target: string, remote: string, ttlMs: number = NONCE_TTL_MS): string {
    this.prune()
    const nonce = randomBytes(16).toString('hex')
    this.grants.set(nonce, { action, target, remote, expiresAt: this.now() + ttlMs })
    return nonce
  }

  /** Consumo único: um nonce válido serve exatamente UMA ação, alvo e origem. */
  public consume(nonce: string | undefined, action: string, target: string, remote: string): boolean {
    if (typeof nonce !== 'string' || nonce.length === 0) return false
    this.prune()
    const grant = this.grants.get(nonce)
    if (!grant) return false
    this.grants.delete(nonce) // uso único — removido mesmo que não corresponda
    return grant.action === action && grant.target === target && grant.remote === remote
  }

  private prune(): void {
    const now = this.now()
    for (const [nonce, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(nonce)
    }
  }
}
