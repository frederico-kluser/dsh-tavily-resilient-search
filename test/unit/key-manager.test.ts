/**
 * Camada UNIT — máquina de estados do agrupamento de credenciais.
 *
 * Determinismo total: relógio e jitter injetados (sem Date.now()/Math.random,
 * sem sleeps) — cada asserção é sobre matemática exata.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  COOLDOWN_BASE_MS,
  COOLDOWN_JITTER_MS,
  COOLDOWN_MAX_MS,
  TavilyKeyManager,
} from '../../src/key-manager.js'

const K1 = 'tvly-key-one-aaaaaaaaaaaaaaaa'
const K2 = 'tvly-key-two-bbbbbbbbbbbbbbbb'
const K3 = 'tvly-key-three-cccccccccccccc'

function makeClock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('TavilyKeyManager — contrato de construção', () => {
  it('lança sem chaves quando allowEmpty não é pedido (contrato do briefing)', () => {
    assert.throws(() => new TavilyKeyManager([]), /É obrigatório configurar pelo menos uma chave/)
  })

  it('aceita pool vazio com allowEmpty (modo keyless-only documentado)', () => {
    const manager = new TavilyKeyManager([], { allowEmpty: true })
    assert.equal(manager.size, 0)
    assert.equal(manager.getNextKey(), null)
  })
})

describe('TavilyKeyManager — distribuição round-robin', () => {
  it('alterna credenciais ACTIVE em round-robin', () => {
    const manager = new TavilyKeyManager([K1, K2, K3])
    assert.equal(manager.getNextKey()!.key, K1)
    assert.equal(manager.getNextKey()!.key, K2)
    assert.equal(manager.getNextKey()!.key, K3)
    assert.equal(manager.getNextKey()!.key, K1)
  })

  it('contabiliza totalRequests por credencial', () => {
    const manager = new TavilyKeyManager([K1, K2])
    manager.getNextKey()
    manager.getNextKey()
    manager.getNextKey()
    assert.equal(manager.getNextKey()!.totalRequests, 2)
  })
})

describe('TavilyKeyManager — 429 RATE_LIMITED', () => {
  it('respeita Retry-After em segundos e recupera após o cooldown', () => {
    const clock = makeClock()
    const manager = new TavilyKeyManager([K1, K2], { now: clock.now })
    manager.markRateLimited(K1, 2)

    assert.equal(manager.getStatus(K1), 'RATE_LIMITED')
    assert.equal(manager.getCooldownUntil(K1), clock.now() + 2000)

    // durante o cooldown, só K2 é selecionável
    assert.equal(manager.getNextKey()!.key, K2)
    assert.equal(manager.getNextKey()!.key, K2)

    clock.advance(2000)
    assert.equal(manager.getNextKey()!.key, K1)
    assert.equal(manager.getStatus(K1), 'ACTIVE')
    assert.equal(manager.getCooldownUntil(K1), 0)
  })

  it('sem Retry-After aplica recuo exponencial truncado com jitter', () => {
    const clock = makeClock()
    const manager = new TavilyKeyManager([K1], { now: clock.now, random: () => 0.5 })
    manager.markRateLimited(K1)
    // k=1: min(60000, 500*2^1) + floor(0.5*500) = 1000 + 250
    assert.equal(manager.getCooldownUntil(K1), clock.now() + COOLDOWN_BASE_MS * 2 + 250)

    clock.advance(10_000)
    manager.getNextKey() // revive
    manager.markRateLimited(K1)
    // k=1 outra vez (failureCount reinicia na recuperação): mesma fórmula
    assert.equal(manager.getCooldownUntil(K1), clock.now() + COOLDOWN_BASE_MS * 2 + 250)
  })

  it('saturações consecutivas dobram o cooldown até ao teto', () => {
    const clock = makeClock()
    const manager = new TavilyKeyManager([K1], { now: clock.now, random: () => 0 })
    manager.markRateLimited(K1) // k=1 → 1000ms
    const first = manager.getCooldownUntil(K1)! - clock.now()
    assert.equal(first, 1000)

    // sem passar o cooldown: segunda saturação (k=2 → 2000ms)
    manager.markRateLimited(K1) // marca sobre a mesma chave em cooldown
    const second = manager.getCooldownUntil(K1)! - clock.now()
    assert.equal(second, 2000)

    // saturações sucessivas → exponencial truncado em COOLDOWN_MAX_MS
    for (let i = 0; i < 10; i++) manager.markRateLimited(K1)
    assert.equal(manager.getCooldownUntil(K1)! - clock.now(), COOLDOWN_MAX_MS)
  })

  it('jitter δ fica em [0, COOLDOWN_JITTER_MS)', () => {
    const clock = makeClock()
    for (const r of [0, 0.25, 0.75, 0.999999]) {
      const manager = new TavilyKeyManager([K1], { now: clock.now, random: () => r })
      manager.markRateLimited(K1)
      const delay = manager.getCooldownUntil(K1)! - clock.now()
      const base = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2)
      assert.ok(delay >= base && delay < base + COOLDOWN_JITTER_MS, `delay=${delay} fora da banda`)
    }
  })
})

describe('TavilyKeyManager — 432/433 QUOTA_EXHAUSTED', () => {
  it('suspende até à meia-noite UTC do mês seguinte e revive depois', () => {
    // 2026-09-24T12:00:00Z → reposição em 2026-10-01T00:00:00Z
    const start = Date.UTC(2026, 8, 24, 12, 0, 0)
    const clock = makeClock(start)
    const manager = new TavilyKeyManager([K1, K2], { now: clock.now })

    manager.markQuotaExhausted(K1)
    const expected = Date.UTC(2026, 9, 1, 0, 0, 0)
    assert.equal(manager.getCooldownUntil(K1), expected)
    assert.equal(manager.getStatus(K1), 'QUOTA_EXHAUSTED')

    // antes da reposição: apenas K2
    assert.equal(manager.getNextKey()!.key, K2)
    assert.equal(manager.getNextKey()!.key, K2)

    // A recuperação é LAZY (sem timers): a expiração do cooldown é aplicada na
    // seleção seguinte — leituras puras não mutam estado.
    clock.advance(expected - start + 1)
    assert.equal(manager.getStatus(K1), 'QUOTA_EXHAUSTED') // ainda não revivida
    assert.equal(manager.getNextKey()!.key, K1) // seleção aplica a expiração
    assert.equal(manager.getStatus(K1), 'ACTIVE')
  })

  it('ancora a reposição em UTC, não no fuso local', () => {
    const clock = makeClock(Date.UTC(2026, 11, 31, 23, 59, 59))
    const manager = new TavilyKeyManager([K1], { now: clock.now })
    manager.markQuotaExhausted(K1)
    assert.equal(manager.getCooldownUntil(K1), Date.UTC(2027, 0, 1, 0, 0, 0))
  })
})

describe('TavilyKeyManager — 401 REVOKED', () => {
  it('exclui a chave em definitivo, mesmo após muito tempo', () => {
    const clock = makeClock()
    const manager = new TavilyKeyManager([K1, K2], { now: clock.now })
    manager.markRevoked(K1)
    assert.equal(manager.getStatus(K1), 'REVOKED')

    clock.advance(365 * 24 * 3600 * 1000)
    assert.equal(manager.getNextKey()!.key, K2)
    assert.equal(manager.getNextKey()!.key, K2) // K1 nunca mais
    assert.equal(manager.getStatus(K1), 'REVOKED')
    assert.equal(manager.getCooldownUntil(K1), 0)
  })

  it('esgota o pool com todas as chaves revogadas → null (contingência keyless)', () => {
    const manager = new TavilyKeyManager([K1, K2])
    manager.markRevoked(K1)
    manager.markRevoked(K2)
    assert.equal(manager.getNextKey(), null)
  })
})
