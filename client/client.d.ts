/**
 * Contrato de tipos do meio do cliente (bundle de browser em `client.js`).
 * O bundle exporta `apply(ctx)` e `inject` — o mesmo formato medido em
 * `@deepseek-ai/dsh-client-ui-message-feedback` (`exports.apply`/`exports.inject`).
 */
import type { Context } from '@deepseek-ai/cordis'

/** Services do contexto de cliente exigidos pelo meio do cliente. */
export declare const inject: string[]

/**
 * Regista a secção `settings.section` (CRUD de chaves Tavily) no layout de
 * Definições do DSH.
 */
export declare function apply(ctx: Context): void
