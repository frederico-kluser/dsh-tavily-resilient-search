/**
 * Camada UNIT — gestão em tempo de execução do pool (painel) sem vazar segredos.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TavilyKeyManager } from '../../src/key-manager.js'

const K1 = 'tvly-FIRSTKEY-aaaaaaaaaa1111'
const K2 = 'tvly-SECONDKEY-bbbbbbbbbb2222'

describe('TavilyKeyManager — gestão do pool via painel', () => {
  it('addKey acrescenta, trata espaços e recusa duplicados', () => {
    const manager = new TavilyKeyManager([K1], { allowEmpty: true })
    assert.equal(manager.addKey(`  ${K2}  `), true)
    assert.equal(manager.size, 2)
    assert.equal(manager.getByIndex(1)!.key, K2)
    assert.equal(manager.addKey(K2), false, 'duplicado não dobra a capacidade')
    assert.equal(manager.addKey('   '), false)
    assert.equal(manager.size, 2)
  })

  it('removeKeyByIndex devolve os metadados (com proveniência) e desloca os índices', () => {
    const manager = new TavilyKeyManager([], { allowEmpty: true })
    manager.addKey(K1, 'store')
    manager.addKey(K2, 'ui')
    const removed = manager.removeKeyByIndex(0)
    assert.equal(removed!.key, K1)
    assert.equal(removed!.source, 'store')
    assert.equal(manager.size, 1)
    assert.equal(manager.getByIndex(0)!.key, K2)
    assert.equal(manager.removeKeyByIndex(5), undefined)
    assert.equal(manager.removeKeyByIndex(-1), undefined)
    assert.equal(manager.removeKeyByIndex(1.5), undefined)
  })

  it('snapshot é MASCARADO — nunca material de segredo, nem prefixo', () => {
    const manager = new TavilyKeyManager([K1], { allowEmpty: true })
    manager.addKey(K2, 'ui')
    const snap = manager.snapshot()
    assert.equal(snap.length, 2)
    const serialized = JSON.stringify(snap)
    for (const secret of [K1, K2]) {
      assert.ok(!serialized.includes(secret), 'chave completa vazou no snapshot')
      assert.ok(!serialized.includes(secret.slice(0, 8)), 'prefixo da chave vazou no snapshot')
      assert.ok(!serialized.includes(secret.slice(0, 4)))
    }
    assert.equal(snap[0]!.ref, `…${K1.slice(-4)}`)
    assert.equal(snap[0]!.source, 'env')
    assert.equal(snap[1]!.source, 'ui')
  })

  it('snapshot reflete cooldowns sem mutar estado', () => {
    let t = 1_700_000_000_000
    const manager = new TavilyKeyManager([K1], { now: () => t, allowEmpty: true })
    manager.markRateLimited(K1, 3)
    const before = manager.snapshot()[0]!
    assert.equal(before.status, 'RATE_LIMITED')
    assert.equal(before.cooldownRemainingMs, 3000)
    assert.equal(manager.snapshot()[0]!.status, 'RATE_LIMITED', 'leituras não mutam')
    t += 5000
    assert.equal(manager.snapshot()[0]!.cooldownRemainingMs, 0)
    assert.equal(manager.getNextKey()!.key, K1, 'seleção aplica a expiração')
  })
})
