/**
 * Camada UNIT — persistência 0600/0700, escrita atómica e auditoria apensível
 * resistente a troca por symlink (O_NOFOLLOW).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  appendAudit,
  ensureStore,
  loadPersistedKeys,
  loadTokenDigest,
  resolveStorePaths,
  savePersistedKeys,
  saveTokenDigest,
  sha256Hex,
} from '../../src/admin/store.js'

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tavily-store-'))
  const paths = resolveStorePaths(join(dir, 'state'))
  ensureStore(paths)
  return paths
}

describe('store — modos de ficheiro e escrita atómica', () => {
  it('diretório 0700 e ficheiros 0600', () => {
    const paths = makeStore()
    assert.equal(statSync(paths.dir).mode & 0o777, 0o700)

    saveTokenDigest(paths, sha256Hex('token'))
    savePersistedKeys(paths, ['k1'])
    assert.equal(statSync(paths.stateFile).mode & 0o777, 0o600)
    assert.equal(statSync(paths.keysFile).mode & 0o777, 0o600)
    assert.ok(!existsSync(`${paths.stateFile}.tmp-${process.pid}`), 'sem temporários a sobrar')
  })

  it('guarda e recarrega APENAS o digest do token', () => {
    const paths = makeStore()
    const digest = sha256Hex('super-secret-token')
    saveTokenDigest(paths, digest)
    assert.equal(loadTokenDigest(paths), digest)
    const raw = readFileSync(paths.stateFile, 'utf8')
    assert.ok(!raw.includes('super-secret-token'), 'o token em claro nunca é persistido')
  })

  it('digest malformado é ignorado (fail-safe)', () => {
    const paths = makeStore()
    writeFileSync(paths.stateFile, JSON.stringify({ adminTokenSha256: 'nope' }), { mode: 0o600 })
    assert.equal(loadTokenDigest(paths), null)
  })

  it('chaves persistidas sobrevivem em keys.json', () => {
    const paths = makeStore()
    savePersistedKeys(paths, ['tvly-a', 'tvly-b'])
    assert.deepEqual(loadPersistedKeys(paths), ['tvly-a', 'tvly-b'])
  })
})

describe('store — auditoria apensível', () => {
  it('acrescenta linhas JSON sem truncar as anteriores', () => {
    const paths = makeStore()
    appendAudit(paths, { action: 'auth', outcome: 'deny', remote: '127.0.0.1' })
    appendAudit(paths, { action: 'add-key', outcome: 'permit', remote: '127.0.0.1', target: '…c2e9' })
    const lines = readFileSync(paths.auditFile, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0]!, /"action":"auth"/)
    assert.match(lines[1]!, /"action":"add-key"/)
    assert.equal(statSync(paths.auditFile).mode & 0o777, 0o600)
  })

  it('modo inseguro pré-existente é corrigido e verificado no descritor', () => {
    const paths = makeStore()
    writeFileSync(paths.auditFile, '', { mode: 0o644 })
    appendAudit(paths, { action: 'auth', outcome: 'permit' })
    assert.equal(statSync(paths.auditFile).mode & 0o777, 0o600)
  })

  it('uma troca por symlink falha alto (O_NOFOLLOW) e não escreve no alvo', () => {
    const paths = makeStore()
    const outside = join(paths.dir, 'victim.log')
    writeFileSync(outside, 'precioso\n')
    symlinkSync(outside, paths.auditFile)

    assert.throws(() => appendAudit(paths, { action: 'auth', outcome: 'deny' }))
    assert.equal(readFileSync(outside, 'utf8'), 'precioso\n')
  })
})
