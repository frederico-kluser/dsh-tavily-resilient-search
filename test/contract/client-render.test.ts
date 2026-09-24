/**
 * Camada CONTRACT — smoke de RENDERIZAÇÃO do bundle do cliente.
 *
 * `node --check` prova sintaxe; este teste prova a ÁRVORE: carrega o bundle num
 * `vm` com um React falso (createElement registado) e um `__ModuleLoader__`
 * falso, executa `apply(ctx)` contra um registry de slots falso e renderiza a
 * secção — desequilíbrios de parênteses num `h(...)` escrito à mão aparecem
 * aqui como árvore torta, nunca silenciosamente.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, it } from 'node:test'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = readFileSync(join(repoRoot, 'client', 'client.js'), 'utf8')

interface El {
  tag: string
  props: Record<string, unknown>
  children: unknown[]
}

function fakeReact() {
  return {
    createElement: (tag: string, props: Record<string, unknown> | null, ...children: unknown[]): El => ({
      tag,
      props: props ?? {},
      children,
    }),
    useState: <T,>(init: T | (() => T)): [T, (v: T) => void] => [
      typeof init === 'function' ? (init as () => T)() : init,
      () => {},
    ],
    useEffect: () => {},
    useCallback: <F,>(fn: F): F => fn,
  }
}

function loadBundle(): { exports: { apply: (ctx: unknown) => void; inject: string[] }; comp: () => El } {
  // holder por propriedade: a atribuição acontece dentro do callback do loader
  // e o CFA do TS estreitaria uma `let` local a `never`.
  const holder: { spec: { factory: (require: (m: string) => unknown) => unknown } | null } = { spec: null }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (spec: { factory: (require: (m: string) => unknown) => unknown }) => void (holder.spec = spec),
      },
    },
    document: undefined,
    sessionStorage: { getItem: () => 'token-de-teste', setItem: () => {} },
    fetch: async () => new Response('{}', { status: 200 }),
    confirm: () => true,
    prompt: () => null,
    setTimeout,
    clearTimeout,
  }
  runInNewContext(source, sandbox)
  const spec = holder.spec
  assert.ok(spec, 'o bundle não se registou em window.__ModuleLoader__')
  const modules: Record<string, unknown> = { react: fakeReact() }
  const exportsObj = spec.factory((name: string) => {
    assert.ok(name in modules, `require("${name}") sem módulo falso — acrescente ao conjunto`)
    return modules[name]
  }) as { apply: (ctx: unknown) => void; inject: string[] }

  let comp: (() => El) | null = null
  const ctx = {
    slots: {
      inject: (_name: string, fn: () => void) => {
        fn()
        return () => {}
      },
      register: (_options: unknown, component: () => El) => {
        comp = component
        return () => {}
      },
    },
  }
  exportsObj.apply(ctx)
  assert.ok(comp, 'apply() não registou componente em slots.register')
  return { exports: exportsObj, comp: comp! }
}

function flatten(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
  } else if (node && typeof node === 'object' && 'tag' in (node as El)) {
    const el = node as El
    out.push(el)
    flatten(el.children, out)
  }
  return out
}

describe('contract — renderização real do bundle do cliente', () => {
  it('exporta apply/inject e regista a secção no slot', () => {
    const { exports } = loadBundle()
    // JSON em vez de deepEqual: o array vem de OUTRO realm (node:vm)
    assert.equal(JSON.stringify(exports.inject), JSON.stringify(['slots']))
  })

  it('a árvore renderizada é a secção CRUD (tabela + formulário) — não uma sopa de elementos', () => {
    const { comp } = loadBundle()
    const tree = comp()
    const nodes = flatten(tree)
    const tags = nodes.map((n) => n.tag)

    assert.equal(tree.tag, 'div')
    assert.equal(tree.props['className'], 'dtk-wrap')
    assert.ok(tags.includes('table'), 'falta a tabela do pool')
    assert.equal(tags.filter((t) => t === 'thead').length, 1, 'exactamente um cabeçalho')
    assert.equal(tags.filter((t) => t === 'tbody').length, 1, 'exactamente um corpo de tabela')

    // a tabela é FILHA direta do wrapper (parênteses equilibrados = árvore certa)
    const table = nodes.find((n) => n.tag === 'table')!
    assert.deepEqual(table.children.map((c) => (c as El).tag), ['thead', 'tbody'])

    // formulário de criação + rodapé com o aviso de máscara
    const texts = JSON.stringify(tree)
    assert.ok(texts.includes('Adicionar'), 'falta o formulário de criação (C)')
    assert.ok(texts.includes('Atualizar'))
    assert.ok(texts.includes('pool vazio'), 'estado vazio legível')
    assert.ok(texts.includes('nunca são exibidas integralmente'), 'aviso de máscara presente')
    assert.ok(!texts.includes('token-de-teste'), 'o token nunca entra na árvore renderizada')
  })
})
