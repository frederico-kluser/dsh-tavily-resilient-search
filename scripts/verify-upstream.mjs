#!/usr/bin/env node
/**
 * verify-upstream — reverifica a proveniência (Q-1) pela REDE: re-descarrega os
 * tarballs npm pinados em types/, confirma o sha256 registado e revalida que
 * cada bloco espelhado continua a existir VERBATIM no .d.ts publicado.
 *
 * Uso:
 *   node scripts/verify-upstream.mjs                 # verificação (requer rede)
 *   node scripts/verify-upstream.mjs --write-mirrors  # regenera types/ dos tarballs
 *
 * Os âncoras de extração são as mesmas que geraram os espelhos: se a API
 * publicada se mexer, a verificação falha alto e obriga a reavaliação consciente.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const mirrorDir = join(repoRoot, 'types')
const writeMirrors = process.argv.includes('--write-mirrors')

// —— âncoras de extração (mesmas do gerador original) ————————————————————————
function findLine(lines, regex, start = 0) {
  for (let i = start; i < lines.length; i++) if (regex.test(lines[i])) return i
  throw new Error(`ancora não encontrada: ${regex}`)
}
const blockSingle = (lines, re) => [lines[findLine(lines, re)]]
const blockIface = (lines, re) => {
  const s = findLine(lines, re)
  const e = findLine(lines, /^\}/, s)
  return lines.slice(s, e + 1)
}
const blockSchemaDsl = (lines) => {
  const s = findLine(lines, /^export interface ValueSchemaAnnotations \{/)
  const p = findLine(lines, /^export type ParameterSchemaSpec = \{/, s)
  const e = findLine(lines, /^\};$/, p)
  return lines.slice(s, e + 1)
}
const blockCordisAug = (lines) => {
  const s = findLine(lines, /^declare module '@deepseek-ai\/cordis' \{/)
  const ctx = findLine(lines, /^ {4}interface Context \{/, s)
  const e = findLine(lines, /^ {4}\}$/, ctx)
  return lines.slice(s, e + 1)
}
const blockContent = (lines) => {
  const s = findLine(lines, /^export interface TextBlock \{/)
  const e = findLine(lines, /^export type ContentBlock = ContentBlockMap\[ContentBlockType\];$/, s)
  return lines.slice(s, e + 1)
}

const PLAN = {
  'dsh-tools-schema.d.ts': {
    pkg: '@deepseek-ai/dsh-tools',
    inner: 'lib/types/schema.d.ts',
    blocks: (l) => [
      ['ValueSchemaAnnotations..ParameterSchemaSpec', blockSchemaDsl(l)],
      ['DefineToolOptions', blockIface(l, /^export interface DefineToolOptions/)],
      ['defineTool-declaration', blockSingle(l, /^export declare function defineTool/)],
    ],
  },
  'dsh-tools-runtime.d.ts': {
    pkg: '@deepseek-ai/dsh-tools',
    inner: 'lib/types/index.d.ts',
    blocks: (l) => [
      ['ToolOutputDefinition', blockIface(l, /^export interface ToolOutputDefinition \{/)],
      ['ToolDefinition', blockIface(l, /^export interface ToolDefinition extends ToolSchema \{/)],
      ['ToolExecutionInput', blockIface(l, /^export interface ToolExecutionInput \{/)],
      ['ToolRunContext', blockIface(l, /^export interface ToolRunContext extends ToolExecution \{/)],
      ['ToolGuard', blockSingle(l, /^export type ToolGuard = /)],
      ['cordis-augmentation-tools', blockCordisAug(l)],
      ['ToolRuntime-register', blockSingle(l, /^ {4}register\(definition: ToolDefinition\): \(\) => void;$/)],
      ['ToolRuntime-guard', blockSingle(l, /^ {4}guard\(guard: ToolGuard\): \(\) => void;$/)],
    ],
  },
  'cordis-context.d.ts': {
    pkg: '@deepseek-ai/cordis',
    inner: 'lib/types/context.d.ts',
    blocks: (l) => [['Context-interface', blockIface(l, /^export interface Context \{/)]],
  },
  'dsh-llm-content.d.ts': {
    pkg: '@deepseek-ai/dsh-llm',
    inner: 'lib/types/types.d.ts',
    blocks: (l) => [['ContentBlock-surface', blockContent(l)]],
  },
}

// —— proveniência existente (versão + sha256 pinados) ————————————————————————
function parseProvenance(text) {
  const line = text.split('\n').find((l) => l.startsWith('// #provenance '))
  if (!line) throw new Error('linha // #provenance em falta')
  const out = {}
  for (const pair of line.replace('// #provenance ', '').trim().split(/\s+/)) {
    const i = pair.indexOf('=')
    out[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return out
}

function extractBlocks(text) {
  const blocks = []
  let current = null
  for (const line of text.split('\n')) {
    const begin = line.match(/^\/\/ #mirror-begin (.+)$/)
    const end = line.match(/^\/\/ #mirror-end (.+)$/)
    if (begin) current = { label: begin[1], body: [] }
    else if (end) {
      blocks.push({ label: current.label, body: current.body.join('\n').trim() })
      current = null
    } else if (current) current.body.push(line)
  }
  return blocks
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const normalize = (t) => t.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()

const problems = []
const temp = mkdtempSync(join(tmpdir(), 'dsh-upstream-'))

try {
  for (const mirrorName of Object.keys(PLAN)) {
    const mirrorPath = join(mirrorDir, mirrorName)
    const plan = PLAN[mirrorName]
    const provenance = parseProvenance(readFileSync(mirrorPath, 'utf8'))
    if (provenance.package !== plan.pkg || provenance.file !== plan.inner) {
      problems.push(`${mirrorName}: proveniência divergente do plano de verificação`)
      continue
    }

    const spec = `${provenance.package}@${provenance.version}`
    console.log(`[verify-upstream] a descarregar ${spec} ...`)
    execFileSync('npm', ['pack', spec, '--pack-destination', temp, '--silent'], { stdio: 'pipe' })
    const entries = readdirSync(temp).filter((f) => f.endsWith('.tgz'))
    const tarballName = entries.find((f) => f.includes(provenance.package.replace('@deepseek-ai/', '')))
    const tarballPath = join(temp, tarballName)
    const digest = sha256(readFileSync(tarballPath))
    if (digest !== provenance['tarball-sha256']) {
      problems.push(
        `${mirrorName}: sha256 divergente para ${spec} (esperado ${provenance['tarball-sha256']}, obtido ${digest}) — tarball republicado?`,
      )
      continue
    }

    const extracted = join(temp, mirrorName.replace('.d.ts', ''))
    execFileSync('tar', ['-xzf', tarballPath, '-C', (() => { execFileSync('mkdir', ['-p', extracted]); return extracted })()])
    const upstreamPath = join(extracted, 'package', provenance.file)
    const upstream = readFileSync(upstreamPath, 'utf8')
    const upstreamLines = upstream.split('\n')

    if (writeMirrors) {
      const out = []
      out.push(readFileSync(mirrorPath, 'utf8').split('// #provenance')[0].trimEnd())
      out.push('')
      out.push(`// #provenance package=${provenance.package} version=${provenance.version} file=${provenance.file} tarball-sha256=${provenance['tarball-sha256']} retrieved=${new Date().toISOString().slice(0, 10)}`)
      out.push('')
      for (const [label, body] of plan.blocks(upstreamLines)) {
        out.push(`// #mirror-begin ${label}`)
        out.push(...body)
        out.push(`// #mirror-end ${label}`)
        out.push('')
      }
      writeFileSync(mirrorPath, out.join('\n') + '\n')
      console.log(`[verify-upstream] ${mirrorName} regenerado.`)
    } else {
      const blocks = extractBlocks(readFileSync(mirrorPath, 'utf8'))
      for (const block of blocks) {
        if (!normalize(upstream).includes(normalize(block.body))) {
          problems.push(`${mirrorName}: bloco "${block.label}" divergiu do .d.ts publicado de ${spec}`)
        }
      }
      console.log(`[verify-upstream] ${mirrorName}: ${blocks.length} blocos conferidos contra ${spec}.`)
    }
  }

  if (problems.length > 0) {
    console.error('[verify-upstream] REPROVADO:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
  } else {
    console.log(`[verify-upstream] OK — proveniência confirmada${writeMirrors ? ' e espelhos regenerados' : ''}.`)
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
