/**
 * Camada UNIT — salvaguarda volumétrica (teto de 50 KB de texto).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applySharedBudget,
  MAX_RESULT_TEXT_BYTES,
  truncateToBudget,
  utf8Bytes,
} from '../../src/text-budget.js'

describe('truncateToBudget', () => {
  it('devolve intacto o texto dentro do orçamento', () => {
    const result = truncateToBudget('olá mundo', 100)
    assert.deepEqual(result, { text: 'olá mundo', truncated: false })
  })

  it('trunca para dentro do orçamento em bytes UTF-8', () => {
    const text = 'x'.repeat(1000)
    const result = truncateToBudget(text, 100)
    assert.equal(result.truncated, true)
    assert.equal(result.text.length, 100)
    assert.ok(utf8Bytes(result.text) <= 100)
  })

  it('nunca divide pontos de código UTF-8 (sem U+FFFD no resultado)', () => {
    // '😀' são 4 bytes; um corte a meio produziria surrogate órfão / U+FFFD
    const text = '😀'.repeat(100) // 400 bytes
    for (const budget of [1, 2, 3, 5, 7, 100, 101, 399]) {
      const result = truncateToBudget(text, budget)
      assert.ok(utf8Bytes(result.text) <= budget, `budget=${budget} ultrapassado`)
      assert.ok(!result.text.includes('\uFFFD'), `budget=${budget} cortou a meio um code point`)
      // round-trip de UTF-8 sem perda na parte preservada
      assert.equal(result.text, '😀'.repeat(Math.floor(budget / 4)))
    }
  })

  it('trata compostos multi-byte (CJK) com exatidão de bytes', () => {
    const text = '漢'.repeat(50) // 3 bytes cada → 150 bytes
    const result = truncateToBudget(text, 100)
    assert.equal(utf8Bytes(result.text), 99) // 33 glifos × 3 bytes
    assert.equal(result.truncated, true)
  })

  it('orçamento zero esvazia e assinala truncagem', () => {
    assert.deepEqual(truncateToBudget('abc', 0), { text: '', truncated: true })
    assert.deepEqual(truncateToBudget('', 0), { text: '', truncated: false })
  })
})

describe('applySharedBudget', () => {
  it('partilha um orçamento sequencial pelas partes, pela ordem dada', () => {
    const result = applySharedBudget(['aaaa', 'bbbb', 'cccc'], 6)
    assert.deepEqual(result, { parts: ['aaaa', 'bb', ''], truncated: true })
  })

  it('sem estouro não trunca nada', () => {
    const result = applySharedBudget(['aa', 'bb'], 6)
    assert.deepEqual(result, { parts: ['aa', 'bb'], truncated: false })
  })

  it('um documento-bomba de 2 MB colapsa para dentro do teto nominal', () => {
    const bomb = '💣'.repeat(1_000_000) // ~4 MB
    const result = applySharedBudget([bomb])
    assert.equal(result.truncated, true)
    assert.ok(utf8Bytes(result.parts[0]!) <= MAX_RESULT_TEXT_BYTES)
  })

  it('o teto nominal é 50 KB', () => {
    assert.equal(MAX_RESULT_TEXT_BYTES, 50 * 1024)
  })
})
