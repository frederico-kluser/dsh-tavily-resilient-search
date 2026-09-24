/**
 * Camada CONTRACT — os espelhos em types/ têm de corresponder VERBATIM às
 * declarações .d.ts publicadas nos pacotes instalados (Q-1: a API é o que os
 * tarballs dizem, não a prosa).
 *
 * Divergência = alarme de drift da API suportada. A verificação de rede
 * (re-descarga + sha256 dos tarballs) vive em scripts/verify-upstream.mjs.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const require = createRequire(import.meta.url)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const mirrorDir = join(repoRoot, 'types')

interface Provenance {
  package: string
  version: string
  file: string
  'tarball-sha256': string
}

function parseProvenance(text: string): Provenance {
  const line = text.split('\n').find((l) => l.startsWith('// #provenance '))
  assert.ok(line, 'faltou a linha // #provenance')
  const pairs = line.replace('// #provenance ', '').trim().split(/\s+/)
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const idx = pair.indexOf('=')
    out[pair.slice(0, idx)] = pair.slice(idx + 1)
  }
  for (const key of ['package', 'version', 'file', 'tarball-sha256']) {
    assert.ok(out[key], `proveniência sem ${key}`)
  }
  return out as unknown as Provenance
}

function extractBlocks(text: string): Array<{ label: string; body: string }> {
  const blocks: Array<{ label: string; body: string[] }> = []
  let current: { label: string; body: string[] } | null = null
  for (const line of text.split('\n')) {
    const begin = line.match(/^\/\/ #mirror-begin (.+)$/)
    const end = line.match(/^\/\/ #mirror-end (.+)$/)
    if (begin) {
      if (current !== null) throw new Error(`bloco ${current.label} não foi fechado antes de ${begin[1]}`)
      current = { label: begin[1]!, body: [] }
    } else if (end) {
      if (current === null) throw new Error(`#mirror-end ${end[1]} sem início`)
      if (current.label !== end[1]) throw new Error('marcadores begin/end com rótulos divergentes')
      blocks.push(current)
      current = null
    } else if (current) {
      current.body.push(line)
    }
  }
  assert.equal(current, null)
  return blocks.map((b) => ({ label: b.label, body: b.body.join('\n').trim() }))
}

function upstreamText(pkg: string, innerFile: string): string {
  const root = dirname(require.resolve(`${pkg}/package.json`))
  return readFileSync(join(root, innerFile), 'utf8')
}

function installedVersion(pkg: string): string {
  const root = dirname(require.resolve(`${pkg}/package.json`))
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  return manifest.version
}

const normalize = (text: string): string => text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()

describe('contract — espelhos types/ contra os .d.ts publicados', () => {
  const mirrors = readdirSync(mirrorDir).filter((f) => f.endsWith('.d.ts')).sort()
  assert.ok(mirrors.length >= 4, 'espelhos em falta em types/')

  for (const mirror of mirrors) {
    it(`${mirror}: proveniência + blocos verbatim`, () => {
      const text = readFileSync(join(mirrorDir, mirror), 'utf8')
      const provenance = parseProvenance(text)

      // a versão instalada tem de ser exatamente a pinada na proveniência
      assert.equal(
        installedVersion(provenance.package),
        provenance.version,
        `${provenance.package}: versão instalada diverge da pinada (drift não avaliado)`,
      )

      const upstream = normalize(upstreamText(provenance.package, provenance.file))
      const blocks = extractBlocks(text)
      assert.ok(blocks.length > 0, `${mirror} sem blocos espelhados`)

      for (const block of blocks) {
        assert.ok(
          upstream.includes(normalize(block.body)),
          `bloco "${block.label}" já não existe verbatim em ${provenance.package}@${provenance.version} ${provenance.file} — API pública divergiu; reavalie o plugin`,
        )
      }
    })
  }

  it('superfícies críticas continuam nomeadas como o plugin assume', () => {
    const runtime = readFileSync(join(mirrorDir, 'dsh-tools-runtime.d.ts'), 'utf8')
    // ctx.tools.register / ctx.tools.guard (não 'httpServer', não intercept de métodos)
    assert.match(runtime, /register\(definition: ToolDefinition\): \(\) => void;/)
    assert.match(runtime, /guard\(guard: ToolGuard\): \(\) => void;/)
    // augmentation que torna ctx.tools real
    assert.match(runtime, /interface Context \{\s*\n\s*tools: ToolRuntime;/)
  })
})
