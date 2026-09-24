/**
 * Camada CONTRACT — smoke de RENDERIZAÇÃO do bundle do cliente.
 *
 * `node --check` prova sintaxe; este teste prova a ÁRVORE e as REGRAS de
 * visibilidade: carrega o bundle num `vm` com um React falso com estado real
 * (useState/useEffect mínimos) e renderiza o portão de autenticação, o CRUD e o
 * botão de arranque — que só aparece quando NÃO existe chave válida.
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
  tag: unknown
  props: Record<string, unknown>
  children: unknown[]
}

interface Mount {
  values: unknown[]
  effects: Array<() => unknown>
  index: number
  comp: (props: Record<string, unknown>) => El | null
}

/* ---------------- mini-renderer com estado real ---------------- */
const mounts: Mount[] = []
let current: Mount | null = null

const reactShim = {
  createElement: (tag: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({
    tag,
    props: props ?? {},
    children,
  }),
  useState: <T,>(init: T | (() => T)): [T, (v: T) => void] => {
    const m = current!
    const i = m.index++
    if (m.values.length <= i) m.values.push(typeof init === 'function' ? (init as () => T)() : init)
    return [m.values[i] as T, (v: T) => void (m.values[i] = v)]
  },
  useEffect: (fn: () => unknown) => void current!.effects.push(fn),
  useCallback: <F,>(fn: F): F => fn,
}

interface Bundle {
  exports: { apply: (ctx: unknown) => void; inject: string[] }
  components: Map<string, (props: Record<string, unknown>) => El | null>
}

function loadBundle(options: { health: Record<string, unknown>; token?: string }): Bundle {
  const holder: { spec: { factory: (require: (m: string) => unknown) => unknown } | null } = { spec: null }
  const storage = { getItem: () => options.token ?? '', setItem: () => {}, removeItem: () => {} }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (spec: { factory: (require: (m: string) => unknown) => unknown }) => void (holder.spec = spec),
      },
      localStorage: storage,
      sessionStorage: storage,
      alert: () => {},
      confirm: () => true,
    },
    document: undefined,
    sessionStorage: storage,
    fetch: async () => new Response(JSON.stringify(options.health), { status: 200 }),
    setTimeout,
    clearTimeout,
  }
  runInNewContext(source, sandbox)
  const spec = holder.spec
  assert.ok(spec, 'o bundle não se registou em window.__ModuleLoader__')
  const modules: Record<string, unknown> = { react: reactShim }
  const exportsObj = spec.factory((name: string) => {
    assert.ok(name in modules, `require("${name}") sem módulo falso`)
    return modules[name]
  }) as Bundle['exports']

  const components = new Map<string, (props: Record<string, unknown>) => El | null>()
  const ctx = {
    slots: {
      inject: (_name: string, fn: () => void) => {
        fn()
        return () => {}
      },
      register: (options: { id?: string }, component: (props: Record<string, unknown>) => El | null) => {
        components.set(options.id ?? 'sem-id', component)
        return () => {}
      },
    },
  }
  exportsObj.apply(ctx)
  return { exports: exportsObj, components }
}

function mount(comp: (props: Record<string, unknown>) => El | null, props: Record<string, unknown> = {}) {
  const m: Mount = { values: [], effects: [], index: 0, comp }
  mounts.push(m)
  return {
    render(): El | null {
      m.index = 0
      m.effects = []
      current = m
      try {
        return comp(props)
      } finally {
        current = null
      }
    },
    flushEffects(): void {
      for (const fn of m.effects) fn()
      m.effects = []
    },
    setHook(index: number, value: unknown): void {
      m.values[index] = value
    },
  }
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('contract — renderização real do bundle do cliente', () => {
  it('exporta apply/inject e regista a secção E o launcher', () => {
    const bundle = loadBundle({ health: { needsSetup: false } })
    assert.equal(JSON.stringify(bundle.exports.inject), JSON.stringify(['slots']))
    assert.ok(bundle.components.has('tavily-keys'), 'secção settings.section em falta')
    assert.ok(bundle.components.has('tavily-keys-cta'), 'launcher settings.launcher em falta')
  })

  it('sem token: mostra o portão com instruções de recuperação do token (sem tabela)', () => {
    const bundle = loadBundle({ health: { needsSetup: true } })
    const tree = mount(bundle.components.get('tavily-keys')!).render()
    const text = JSON.stringify(tree)
    assert.ok(text.includes('admin-token.txt'), 'falta dizer onde está o token')
    assert.ok(text.includes('DSH_TAVILY_ADMIN_RESET=1'), 'falta o comando de recuperação')
    assert.ok(text.includes('Ligar'), 'falta o botão Ligar')
    assert.ok(!text.includes('Adicionar'), 'o CRUD não deve aparecer sem sessão')
  })

  it('com token: mostra o CRUD (adicionar/Enter) e as URLs úteis', () => {
    const bundle = loadBundle({ health: { needsSetup: true }, token: 'token-de-teste' })
    const tree = mount(bundle.components.get('tavily-keys')!).render()
    const text = JSON.stringify(tree)
    assert.ok(text.includes('Adicionar'), 'falta o formulário de criação')
    assert.ok(text.includes('nova chave tvly-'), 'falta o campo de nova chave')
    assert.ok(text.includes('app.tavily.com'), 'falta a URL para obter chaves')
    assert.ok(!text.includes('token-de-teste'), 'o token nunca entra na árvore')
    const nodes = flatten(tree)
    const inputs = nodes.filter((n) => n.tag === 'input' && n.props['type'] === 'password')
    assert.ok(inputs.length >= 1, 'campo de chave em falta')
  })

  it('o botão de arranque SÓ aparece quando não existe chave válida', async () => {
    // caso A: sem chave válida (needsSetup: true) → botão visível
    const bundleA = loadBundle({ health: { needsSetup: true } })
    const cta = bundleA.components.get('tavily-keys-cta')!
    const viewA = mount(cta)
    assert.equal(viewA.render(), null, 'sem efeitos corridos ainda não decide')
    viewA.flushEffects() // dispara o fetch de /api/health
    await tick()
    const treeA = viewA.render()
    assert.ok(treeA !== null, 'o botão devia aparecer sem chave válida')
    assert.ok(JSON.stringify(treeA).includes('Tavily Keys'))

    // caso B: já há chave válida (needsSetup: false) → nada (não atrapalha)
    const bundleB = loadBundle({ health: { needsSetup: false } })
    const viewB = mount(bundleB.components.get('tavily-keys-cta')!)
    viewB.render()
    viewB.flushEffects()
    await tick()
    assert.equal(viewB.render(), null, 'o botão NÃO pode aparecer com chave válida')
  })
})
