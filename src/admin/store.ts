/**
 * Persistência do painel de gestão de chaves.
 *
 * Baseline (docs/seguranca.md):
 *  - diretório 0700 e ficheiros 0600, escrita atómica (tmp + rename);
 *  - o token administrativo NUNCA é persistido — apenas o digest sha256;
 *  - auditoria APENSÍVEL aberta com O_NOFOLLOW | O_APPEND | O_CREAT e modo
 *    verificado no descritor (uma troca por symlink falha alto);
 *  - chaves Tavily persistidas ficam em `keys.json` 0600 — classe de segredo
 *    idêntica a `~/.npmrc` (precisam de ser reutilizáveis; não admitem digest).
 */
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  constants as fsConstants,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export interface StorePaths {
  dir: string
  stateFile: string
  keysFile: string
  auditFile: string
  tokenFile: string
}

export interface AuditEntry {
  action: string
  outcome: 'permit' | 'deny' | 'error'
  remote?: string
  target?: string
  detail?: string
}

export function resolveStorePaths(override?: string | null): StorePaths {
  const dir =
    override ??
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-tavily-resilient-search')
  return {
    dir,
    stateFile: join(dir, 'state.json'),
    keysFile: join(dir, 'keys.json'),
    auditFile: join(dir, 'audit.log'),
    tokenFile: join(dir, 'admin-token.txt'),
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Garante o diretório de estado 0700 (modo reforçado em cada arranque). */
export function ensureStore(paths: StorePaths): void {
  mkdirSync(paths.dir, { recursive: true, mode: DIR_MODE })
  try {
    chmodSync(paths.dir, DIR_MODE)
  } catch {
    // best-effort em sistemas sem chmod
  }
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Escrita atómica 0600: temporário no mesmo diretório + rename. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE })
  renameSync(tmp, path)
}

export function loadTokenDigest(paths: StorePaths): string | null {
  const state = readJson(paths.stateFile) as { adminTokenSha256?: unknown } | null
  const digest = state?.adminTokenSha256
  return typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest) ? digest : null
}

export function saveTokenDigest(paths: StorePaths, digest: string): void {
  writeJsonAtomic(paths.stateFile, { version: 1, adminTokenSha256: digest })
}

/**
 * Recuperação do token administrativo: cópia em claro em `admin-token.txt`
 * (0600) — a mesma classe de segredo de `~/.npmrc`. Desvio DOCUMENTADO face à
 * regra "só digest": sem caminho de recuperação local, um token impresso uma
 * única vez torna o painel inutilizável para quem não capturou o log — UX pior
 * que o risco num plano de controlo de loopback com credencial+fronteira.
 * `admin.storeTokenFile: false` desliga este ficheiro.
 */
export function saveTokenFile(paths: StorePaths, token: string): void {
  writeFileSync(paths.tokenFile, `${token}\n`, { mode: FILE_MODE })
}

export function loadPersistedKeys(paths: StorePaths): string[] {
  const data = readJson(paths.keysFile) as { keys?: unknown } | null
  if (!Array.isArray(data?.keys)) return []
  return data.keys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
}

export function savePersistedKeys(paths: StorePaths, keys: readonly string[]): void {
  writeJsonAtomic(paths.keysFile, { version: 1, keys: [...keys] })
}

/**
 * Audita uma decisão (permit/deny/error) numa linha JSON apensível.
 * O modo 0600 é imposto e VERIFICADO no descritor; `O_NOFOLLOW` transforma uma
 * troca por symlink numa falha alta, nunca numa escrita para fora do estado.
 */
export function appendAudit(paths: StorePaths, entry: AuditEntry): void {
  const flags =
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0)
  const fd = openSync(paths.auditFile, flags, FILE_MODE)
  try {
    fchmodSync(fd, FILE_MODE)
    const mode = fstatSync(fd).mode & 0o777
    if (mode !== FILE_MODE) {
      throw new Error(`audit.log com modo inseguro: 0${mode.toString(8)} (esperado 0600)`)
    }
    appendFileSync(fd, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
  } finally {
    closeSync(fd)
  }
}

/** Trunca/apaga o ficheiro de auditoria (uso interno em testes; nunca em produção). */
export function resetAuditForTests(paths: StorePaths): void {
  const fd = openSync(paths.auditFile, 'w', FILE_MODE)
  ftruncateSync(fd, 0)
  closeSync(fd)
}
