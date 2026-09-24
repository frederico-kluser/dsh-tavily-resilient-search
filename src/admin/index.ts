/**
 * Instalação do painel de gestão de chaves.
 *
 * O seat `webServer` é OPCIONAL (o DSH também corre headless): em vez de o
 * declarar em `inject` — o que deixaria a fiber PENDING e esconderia também a
 * ferramenta de pesquisa (anti-pattern P-09 da mesma família) — o painel é um
 * PLUGIN ANINHADO com `inject: ['webServer']`, que o Cordis ativa assim que o
 * service existir e desativa em conjunto (efeitos LIFO) com o plugin pai.
 */
import type { Context } from '@deepseek-ai/cordis'
// Import de tipos que ativa a augmentation `ctx.webServer` do próprio pacote.
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { TavilyKeyManager } from '../key-manager.js'
import type { LoggerLike, ResolvedConfig } from '../types.js'
import { AuthFailureTracker, NonceStore, digestToken, generateAdminToken } from './auth.js'
import { ADMIN_BASE_PATH, createAdminRouter } from './router.js'
import {
  appendAudit,
  ensureStore,
  loadPersistedKeys,
  loadTokenDigest,
  resolveStorePaths,
  saveTokenDigest,
} from './store.js'

export interface AdminInstallDeps {
  keyManager: TavilyKeyManager
  config: ResolvedConfig
  fetchFn: typeof fetch
  logger: LoggerLike
  now: () => number
}

const WIDGET_MARK = 'id="dsh-tavily-keys-widget"'

/** Chrome mínimo injetado na shell SPA via `tapIndex` (L3), idempotente. */
export function tapKeysWidget(html: string): string {
  if (html.includes(WIDGET_MARK)) return html
  const widget =
    `<a id="dsh-tavily-keys-widget" href="${ADMIN_BASE_PATH}/" ` +
    `style="position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:8px 12px;` +
    `border:1px solid #8884;border-radius:10px;background:#222c;color:#eee;text-decoration:none;` +
    `font:13px system-ui,sans-serif" title="Gestão de chaves Tavily">🔑 Tavily Keys</a>`
  const pos = html.lastIndexOf('</body>')
  return pos === -1 ? `${html}${widget}` : `${html.slice(0, pos)}${widget}${html.slice(pos)}`
}

/** Decisão de exposição do painel: bind não-loopback só com opt-out explícito. */
export function bindIsSafe(host: string, allowPublicBind: boolean): boolean {
  return host === '127.0.0.1' || allowPublicBind
}

export function installAdminPanel(ctx: Context, deps: AdminInstallDeps): void {
  const { keyManager, config, fetchFn, logger, now } = deps
  const paths = resolveStorePaths(config.admin.stateDir)
  ensureStore(paths)

  // Chaves persistidas entram no pool ao arranque (além das vindas do ambiente).
  const persistedKeys = new Set(loadPersistedKeys(paths))
  for (const key of persistedKeys) keyManager.addKey(key, 'store')

  // Credencial administrativa: gerada por CSPRNG, impressa UMA vez, só o digest
  // é persistido (0600). `DSH_TAVILY_ADMIN_TOKEN` traz a sua própria credencial;
  // `DSH_TAVILY_ADMIN_RESET=1` regenera (invalida a anterior).
  let expectedDigest: string
  const envToken = process.env.DSH_TAVILY_ADMIN_TOKEN?.trim()
  if (envToken && envToken.length > 0) {
    expectedDigest = digestToken(envToken)
  } else {
    const stored = loadTokenDigest(paths)
    const mustRegenerate = process.env.DSH_TAVILY_ADMIN_RESET === '1' || stored === null
    if (mustRegenerate) {
      const token = generateAdminToken()
      expectedDigest = digestToken(token)
      saveTokenDigest(paths, expectedDigest)
      logger.info(
        `[dsh-tavily-resilient-search] TOKEN ADMINISTRATIVO do painel de chaves (mostrado UMA única vez):\n\n    ${token}\n\n` +
          `Guarde-o agora. Perder-lo obriga a recarregar com DSH_TAVILY_ADMIN_RESET=1. ` +
          `Painel: ${ADMIN_BASE_PATH}/`,
      )
    } else {
      expectedDigest = stored
    }
  }

  const tracker = new AuthFailureTracker()
  const nonces = new NonceStore(now)

  ctx.plugin({
    name: 'dsh-tavily-resilient-search/admin',
    inject: ['webServer'],
    apply: (uiCtx: Context) => {
      const webServer: WebServer = uiCtx.webServer

      // Fail-closed: sobre um bind público o painel NÃO sobe (o utilitário de
      // pesquisa continua). A recusa é ruidosa — nunca um fallback silencioso.
      if (!bindIsSafe(webServer.host, config.admin.allowPublicBind)) {
        logger.error(
          `[dsh-tavily-resilient-search] painel de chaves NÃO montado: bind '${webServer.host}' não é loopback. ` +
            `Defina admin.allowPublicBind: true apenas se assumir a exposição (a credencial passa a ser a única barreira).`,
        )
        return
      }

      const router = createAdminRouter({
        keyManager,
        config,
        paths,
        persistedKeys,
        expectedTokenDigest: () => expectedDigest,
        tracker,
        nonces,
        fetchFn,
        logger,
        now,
        audit: (entry) => {
          try {
            appendAudit(paths, entry)
            return true
          } catch {
            return false
          }
        },
      })

      uiCtx.effect(() =>
        webServer.register({
          kind: 'prefix',
          path: ADMIN_BASE_PATH,
          handler: (req, res) => {
            void router(req, res).catch((error: unknown) => {
              logger.error('[dsh-tavily-resilient-search] falha no painel de chaves:', error)
              if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
              res.end('{"error":"internal"}\n')
            })
          },
        }),
      )

      uiCtx.effect(() => webServer.tapIndex(tapKeysWidget))

      logger.info(
        `[dsh-tavily-resilient-search] painel de gestão de chaves em ${ADMIN_BASE_PATH}/ ` +
          `(origem restrita a: ${config.admin.trustedRemotes.join(', ')})`,
      )
    },
  })
}
