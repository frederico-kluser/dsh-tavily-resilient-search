/**
 * Camada UNIT — credencial administrativa, orçamento de falhas e nonces.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AUTH_FAILURE_LIMIT,
  AuthFailureTracker,
  NONCE_TTL_MS,
  NonceStore,
  digestToken,
  generateAdminToken,
  verifyToken,
} from '../../src/admin/auth.js'

describe('token administrativo', () => {
  it('gera 256 bits de CSPRNG em hex (≥ 128 exigidos)', () => {
    const token = generateAdminToken()
    assert.match(token, /^[0-9a-f]{64}$/)
    assert.notEqual(token, generateAdminToken())
  })

  it('o digest é estável e o token nunca é recuperável a partir dele', () => {
    const token = generateAdminToken()
    const digest = digestToken(token)
    assert.match(digest, /^[0-9a-f]{64}$/)
    assert.equal(digest, digestToken(token))
    assert.ok(!digest.includes(token))
  })

  it('verifyToken aceita o candidato exato e rejeita qualquer outro', () => {
    const token = generateAdminToken()
    const digest = digestToken(token)
    assert.equal(verifyToken(token, digest), true)
    assert.equal(verifyToken(`${token}x`, digest), false)
    assert.equal(verifyToken(generateAdminToken(), digest), false)
    assert.equal(verifyToken(undefined, digest), false)
    assert.equal(verifyToken('', digest), false)
    assert.equal(verifyToken(token, 'not-a-digest'), false)
  })
})

describe('AuthFailureTracker — teto NIST SP 800-63B-4', () => {
  it('bloqueia após 100 falhas consecutivas e sucesso reinicia o orçamento', () => {
    const tracker = new AuthFailureTracker()
    const remote = '127.0.0.1'
    for (let i = 0; i < AUTH_FAILURE_LIMIT - 1; i++) tracker.registerFailure(remote)
    assert.equal(tracker.isLocked(remote), false)
    tracker.registerFailure(remote)
    assert.equal(tracker.isLocked(remote), true)
    assert.equal(tracker.failureCount(remote), AUTH_FAILURE_LIMIT)

    tracker.registerSuccess(remote) // recomendação NIST: sucesso descarta falhas
    assert.equal(tracker.isLocked(remote), false)
  })

  it('orçamentos são independentes por origem', () => {
    const tracker = new AuthFailureTracker(3)
    tracker.registerFailure('a')
    tracker.registerFailure('a')
    tracker.registerFailure('a')
    assert.equal(tracker.isLocked('a'), true)
    assert.equal(tracker.isLocked('b'), false)
  })
})

describe('NonceStore — confirmação de ações destrutivas', () => {
  const now = { t: 1_700_000_000_000 }
  const clock = () => now.t

  it('emite e consome exatamente uma vez, ligado a ação/alvo/origem', () => {
    const nonces = new NonceStore(clock)
    const nonce = nonces.issue('remove-key', '2', '127.0.0.1')
    assert.match(nonce, /^[0-9a-f]{32}$/)

    assert.equal(nonces.consume(nonce, 'remove-key', '2', '127.0.0.1'), true)
    assert.equal(nonces.consume(nonce, 'remove-key', '2', '127.0.0.1'), false, 'uso único')
  })

  it('rejeita quando ação, alvo ou origem não correspondem', () => {
    const nonces = new NonceStore(clock)
    const a = nonces.issue('remove-key', '2', '127.0.0.1')
    assert.equal(nonces.consume(a, 'remove-key', '3', '127.0.0.1'), false, 'alvo')
    const b = nonces.issue('remove-key', '2', '127.0.0.1')
    assert.equal(nonces.consume(b, 'other-action', '2', '127.0.0.1'), false, 'ação')
    const c = nonces.issue('remove-key', '2', '127.0.0.1')
    assert.equal(nonces.consume(c, 'remove-key', '2', '10.0.0.9'), false, 'origem')
  })

  it('expira ao fim do prazo', () => {
    const nonces = new NonceStore(clock)
    const nonce = nonces.issue('remove-key', '0', '127.0.0.1')
    now.t += NONCE_TTL_MS + 1
    assert.equal(nonces.consume(nonce, 'remove-key', '0', '127.0.0.1'), false)
  })

  it('rejeita entradas vazias/ausentes', () => {
    const nonces = new NonceStore(clock)
    assert.equal(nonces.consume(undefined, 'remove-key', '0', '127.0.0.1'), false)
    assert.equal(nonces.consume('', 'remove-key', '0', '127.0.0.1'), false)
  })
})
