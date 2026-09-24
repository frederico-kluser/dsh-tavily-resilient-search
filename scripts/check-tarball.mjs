#!/usr/bin/env node
/**
 * check-tarball — inspeciona o tarball REAL emitido por `npm pack` antes de
 * publicar (allowlist de ficheiros + entrypoints + ativação do bundle).
 *
 * Falha alto quando:
 *  - falta algum ficheiro de entrega (dist/, cordis.patch.yml, README, LICENSE,
 *    CHANGELOG);
 *  - entra lixo (src/, test/, types/, scripts/, node_modules/, *.ts.map? não —
 *    sourcemaps de declaração são legítimos em dist/);
 *  - `dsh.bundle.patch` aponta para um ficheiro AUSENTE do tarball — aí o
 *    plugin não ativaria nada (anti-pattern P-06, medido: só .patch ativa);
 *  - os entrypoints declarados (main/types/exports) não existem no tarball.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED = [
  'package/dist/index.js',
  'package/dist/index.d.ts',
  'package/client/client.js',
  'package/client/client.d.ts',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/LICENSE',
  'package/CHANGELOG.md',
]
const FORBIDDEN_PREFIXES = [
  'package/src/',
  'package/test/',
  'package/types/',
  'package/scripts/',
  'package/node_modules/',
  'package/.github/',
  'package/docs/',
]

const problems = []
const temp = mkdtempSync(join(tmpdir(), 'dsh-tavily-pack-'))

try {
  execFileSync('npm', ['pack', '--pack-destination', temp, '--silent'], { cwd: repoRoot, stdio: 'pipe' })
  const tarball = execFileSync('ls', [temp], { cwd: temp, encoding: 'utf8' }).trim().split('\n')[0]
  const tarballPath = join(temp, tarball)
  const entries = execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim())

  const entrySet = new Set(entries)

  for (const required of REQUIRED) {
    if (!entrySet.has(required)) problems.push(`falta no tarball: ${required}`)
  }
  for (const entry of entries) {
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (entry.startsWith(prefix)) problems.push(`não deveria estar no tarball: ${entry}`)
    }
  }

  const manifestText = execFileSync('tar', ['-xzOf', tarballPath, 'package/package.json'], { encoding: 'utf8' })
  const manifest = JSON.parse(manifestText)

  // P-06 (medido): só dsh.bundle.patch ativa o plugin.
  const patchTarget = manifest?.dsh?.bundle?.patch
  if (typeof patchTarget !== 'string' || patchTarget.length === 0) {
    problems.push('dsh.bundle.patch ausente — o plugin não ativaria nada (P-06)')
  } else {
    const normalized = `package/${patchTarget.replace(/^\.\//, '')}`
    if (!entrySet.has(normalized)) {
      problems.push(`dsh.bundle.patch aponta para ${patchTarget}, ausente do tarball`)
    }
  }

  // Entrypoints declarados têm de existir dentro do tarball.
  const targets = [manifest.main, manifest.types]
  for (const condition of Object.values(manifest.exports ?? {})) {
    if (typeof condition === 'string') targets.push(condition)
    else if (condition && typeof condition === 'object') targets.push(...Object.values(condition))
  }
  for (const target of targets) {
    if (typeof target !== 'string' || target === './package.json') continue
    const normalized = `package/${target.replace(/^\.\//, '')}`
    if (!entrySet.has(normalized)) problems.push(`entrypoint declarado ausente do tarball: ${target}`)
  }

  if (problems.length > 0) {
    console.error('[check-tarball] REPROVADO:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
  } else {
    console.log(`[check-tarball] OK — ${tarball}: ${entries.length} entradas, allowlist respeitada, bundle patch presente.`)
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
