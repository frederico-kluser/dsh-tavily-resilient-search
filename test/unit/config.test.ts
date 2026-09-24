/**
 * Camada UNIT — validação fail-loud da configuração.
 *
 * A regra de segurança crítica está aqui: a conjugação
 * `danger-full-access + approval: never` é IRRECUPERÁVEL de propósito.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertValidConfig,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_INCLUDE_ANSWER,
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_DEPTH,
  DEFAULT_TIMEOUT_MS,
  FORBIDDEN_PROFILE_MESSAGE,
} from '../../src/config.js'
import type { PluginConfig } from '../../src/types.js'

const SAFE = { sandbox: 'workspace-write', approval: 'ask' } as const

function base(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return { securityProfile: SAFE, ...overrides }
}

describe('assertValidConfig — perfil de segurança (fail-closed)', () => {
  it('RECUSA a conjugação danger-full-access + never, com mensagem acionável', () => {
    assert.throws(
      () => assertValidConfig(base({ securityProfile: { sandbox: 'danger-full-access', approval: 'never' } })),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal(err.message, FORBIDDEN_PROFILE_MESSAGE)
        assert.match(err.message, /indirect prompt injection/)
        assert.match(err.message, /workspace-write/)
        return true
      },
    )
  })

  it('aceita danger-full-access com approval: ask (alargado, mas vigiado)', () => {
    const resolved = assertValidConfig(base({ securityProfile: { sandbox: 'danger-full-access', approval: 'ask' } }))
    assert.equal(resolved.securityProfile.sandbox, 'danger-full-access')
  })

  it('aceita workspace-write com approval: never (automação controlada)', () => {
    const resolved = assertValidConfig(base({ securityProfile: { sandbox: 'workspace-write', approval: 'never' } }))
    assert.equal(resolved.securityProfile.approval, 'never')
  })

  it('exige a atestação explícita do perfil (fail-loud, nunca assume seguro)', () => {
    assert.throws(
      () => assertValidConfig({} as PluginConfig),
      /'securityProfile' é obrigatório/,
    )
  })

  it('rejeita enum desconhecido em sandbox/approval', () => {
    assert.throws(
      () => assertValidConfig(base({ securityProfile: { sandbox: 'yolo' as never, approval: 'ask' } })),
      /securityProfile\.sandbox/,
    )
    assert.throws(
      () => assertValidConfig(base({ securityProfile: { sandbox: 'workspace-write', approval: 'maybe' as never } })),
      /securityProfile\.approval/,
    )
  })
})

describe('assertValidConfig — materialização de defaults', () => {
  it('materializa os defaults documentados', () => {
    const resolved = assertValidConfig(base())
    assert.equal(resolved.searchDepth, DEFAULT_SEARCH_DEPTH)
    assert.equal(resolved.maxResults, DEFAULT_MAX_RESULTS)
    assert.equal(resolved.includeAnswer, DEFAULT_INCLUDE_ANSWER)
    assert.equal(resolved.timeoutMs, DEFAULT_TIMEOUT_MS)
    assert.equal(resolved.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS)
    assert.equal(resolved.projectId, null)
    assert.deepEqual(resolved.apiKeys, [])
  })

  it('apiKeys vazias/ausentes são estado legítimo (não lança)', () => {
    assert.deepEqual(assertValidConfig(base()).apiKeys, [])
    assert.deepEqual(assertValidConfig(base({ apiKeys: [] })).apiKeys, [])
    assert.deepEqual(assertValidConfig(base({ apiKeys: ['', '   '] })).apiKeys, [])
  })

  it('filta entradas vazias e deduplica preservando a ordem', () => {
    const resolved = assertValidConfig(base({ apiKeys: [' k1 ', '', 'k2', 'k1', 'k3'] }))
    assert.deepEqual(resolved.apiKeys, ['k1', 'k2', 'k3'])
  })

  it('rejeita apiKeys que não sejam strings (fail-loud)', () => {
    assert.throws(() => assertValidConfig(base({ apiKeys: [123 as never] })), /apenas strings/)
    assert.throws(() => assertValidConfig(base({ apiKeys: 'k1' as never })), /array de strings/)
  })

  it('valida limites de tempo e coerência callTimeoutMs ≥ timeoutMs', () => {
    assert.throws(() => assertValidConfig(base({ timeoutMs: 10 })), /timeoutMs/)
    assert.throws(() => assertValidConfig(base({ timeoutMs: 1.5 })), /timeoutMs/)
    assert.throws(() => assertValidConfig(base({ callTimeoutMs: 1_000_000 })), /callTimeoutMs/)
    assert.throws(
      () => assertValidConfig(base({ timeoutMs: 30_000, callTimeoutMs: 10_000 })),
      /não pode ser inferior/,
    )
  })

  it('valida maxResults, searchDepth e projectId', () => {
    assert.throws(() => assertValidConfig(base({ maxResults: 0 })), /maxResults/)
    assert.throws(() => assertValidConfig(base({ searchDepth: 'ludicrous' as never })), /searchDepth/)
    assert.throws(() => assertValidConfig(base({ projectId: '  ' })), /projectId/)
  })
})
