/**
 * Camada CONTRACT — o bundle do cliente tem de seguir o formato medido no
 * exemplo oficial (`window.__ModuleLoader__.load({ id, factory })` com
 * `exports.apply`/`exports.inject`) e a inscrição `settings.section` tem de
 * continuar a falar o SlotMap real. Divergência = alarme de drift do layout.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bundle = readFileSync(join(repoRoot, 'client', 'client.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  dsh?: { client?: { platform?: unknown; inject?: unknown } }
  exports?: Record<string, unknown>
}

/** Módulos especiais do host, medidos no `require` do exemplo oficial. */
const HOST_MODULES = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store'])

describe('contract — bundle do cliente (formato __ModuleLoader__)', () => {
  it('tem a forma da factory medida no exemplo oficial', () => {
    assert.match(bundle, /window\.__ModuleLoader__\.load\(\{/)
    assert.match(bundle, /factory: \(require\) => \{/)
    assert.match(bundle, /exports\.apply = apply;/)
    assert.match(bundle, /exports\.inject = inject;/)
    assert.match(bundle, /return module\.exports;/)
  })

  it('só require() módulos especiais do host (ou declaráveis em dsh.client)', () => {
    const required = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]!)
    assert.ok(required.length > 0, 'o bundle tem de usar o require do factory')
    for (const spec of required) {
      assert.ok(HOST_MODULES.has(spec), `require("${spec}") fora do conjunto de módulos especiais medidos`)
    }
  })

  it('inscreve-se em settings.section com identidade de nav completa (id/order/label)', () => {
    assert.match(bundle, /ctx\.slots\.inject\("settings\.section"/)
    assert.match(bundle, /name: "settings\.section"/)
    assert.match(bundle, /id: "tavily-keys"/)
    assert.match(bundle, /order: 60/)
    assert.match(bundle, /label: \(\) =>/)
  })

  it('expõe o CRUD completo (C/R/U/D) sobre a API do painel', () => {
    for (const verb of ['POST', 'PUT', 'DELETE']) {
      assert.ok(bundle.includes(`"${verb}"`) || bundle.includes(verb + ','), `falta o verbo ${verb}`)
    }
    assert.match(bundle, /"\/confirm"/)
    assert.match(bundle, /replace-key/, 'falta o U (substituir credencial)')
    assert.match(bundle, /remove-key/, 'falta o D (remover credencial)')
  })

  it('o manifesto declara o meio do cliente (dsh.client.platform) e o export ./client', () => {
    assert.equal(manifest.dsh?.client?.platform, 'web')
    assert.ok(manifest.exports?.['./client'], 'export ./client em falta')
  })
})
