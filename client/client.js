/**
 * Meio do cliente do plugin (bundle de browser) — painel de CRUD de chaves
 * Tavily como SECÇÃO NATIVA do layout de Definições do DSH.
 *
 * Contrato do bundle (medido em @deepseek-ai/dsh-client-ui-message-feedback
 * @0.1.7-rc.1 lib/client.js): uma factory registada em
 * `window.__ModuleLoader__.load({ id, factory: (require) => ... })` que exporta
 * `apply(ctx)` e `inject` (services do contexto de cliente). O `require` do
 * factory resolve os módulos especiais do host (react, primitives, store);
 * tudo o resto seria declarado em `dsh.client.inject`.
 *
 * Inscrição: `settings.section` (slot `list`/`root` — "uma página de
 * definições por entrada", com `id`/`order`/`label` do registrante), medido em
 * @deepseek-ai/dsh-client-ui-settings lib/types/client/contract/slots.d.ts.
 *
 * Estilo: variáveis de design `--dsw-alias-*` do próprio DSH — o painel fala o
 * layout da casa. Sem JSX: `react.createElement` à mão (sem build step).
 */
window.__ModuleLoader__.load({
	id: "dsh-tavily-resilient-search",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const API = "/__tavily-keys/api";
		const TOKEN_KEY = "dsh-tavily-token";
		const STYLE_ID = "dsh-tavily-keys-style";

		function installStyle() {
			if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
			const tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.dataset.plugin = "dsh-tavily-resilient-search";
			tag.textContent = [
				".dtk-wrap{display:flex;flex-direction:column;gap:16px;max-width:760px}",
				".dtk-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
				".dtk-table{width:100%;border-collapse:collapse}",
				".dtk-table th,.dtk-table td{text-align:left;padding:8px;border-bottom:1px solid var(--dsw-alias-border-l4);font-size:13px}",
				".dtk-input{flex:1;min-width:220px;padding:8px 10px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}",
				".dtk-btn{padding:7px 14px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}",
				".dtk-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".dtk-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}",
				".dtk-badge{padding:1px 8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l4);font-size:12px}",
				".dtk-msg{min-height:18px;font-size:12px;color:var(--dsw-alias-label-caption)}",
				".dtk-msg-error{color:#c0392b}",
				".dtk-muted{opacity:.7;font-size:12px}",
			].join("");
			document.head.appendChild(tag);
		}

		/** Chamada à API do painel com a credencial administrativa. */
		async function apiCall(token, method, path, body, nonce) {
			const headers = { authorization: "Bearer " + token };
			if (body !== undefined) headers["content-type"] = "application/json";
			if (nonce) headers["x-confirm-nonce"] = nonce;
			const res = await fetch(API + path, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			let data = {};
			try {
				data = await res.json();
			} catch {
				/* corpo não-JSON */
			}
			return { ok: res.ok, status: res.status, data };
		}

		/** Obtém um nonce de confirmação (uso único) para uma ação destrutiva. */
		async function confirmNonce(token, action, target) {
			const r = await apiCall(token, "POST", "/confirm", { action, target });
			return r.ok && r.data.nonce ? r.data.nonce : null;
		}

		function fmtCooldown(ms) {
			if (!ms || ms <= 0) return "—";
			const s = Math.ceil(ms / 1000);
			return s >= 90 ? Math.ceil(s / 60) + " min" : s + " s";
		}

		/**
		 * Secção CRUD de chaves: lista (R), adicionar (C), editar/substituir (U)
		 * e remover (D), mais "Testar" (valida contra a API, gasta 1 crédito).
		 */
		function TavilyKeysSection() {
			const h = react.createElement;
			const [token, setToken] = react.useState(() => {
				try {
					return sessionStorage.getItem(TOKEN_KEY) || "";
				} catch {
					return "";
				}
			});
			const [pool, setPool] = react.useState([]);
			const [total, setTotal] = react.useState(0);
			const [msg, setMsg] = react.useState(null);
			const [newKey, setNewKey] = react.useState("");
			const [persist, setPersist] = react.useState(true);
			const [editing, setEditing] = react.useState(null);

			const refresh = react.useCallback(
				async function () {
					const r = await apiCall(token, "GET", "/status");
					if (!r.ok) {
						setMsg({ text: r.status === 401 ? "autenticação recusada (ou orçamento de falhas esgotado)" : "falha " + r.status, error: true });
						return;
					}
					setPool(r.data.pool || []);
					setTotal(r.data.totalKeys || 0);
					setMsg(null);
				},
				[token],
			);

			react.useEffect(() => {
				if (token) void refresh();
			}, [token, refresh]);

			function say(text, error) {
				setMsg({ text, error: !!error });
			}

			async function doAdd() {
				if (!newKey.trim()) return say("chave vazia", true);
				const r = await apiCall(token, "POST", "/keys", { key: newKey.trim(), persist });
				if (!r.ok) return say("adição recusada: " + (r.data.error || r.status), true);
				setNewKey("");
				say("chave " + r.data.ref + " adicionada");
				await refresh();
			}

			async function doRemove(index, ref) {
				if (!confirm("Remover a chave " + ref + " do pool?")) return;
				const nonce = await confirmNonce(token, "remove-key", String(index));
				if (!nonce) return say("confirmação recusada", true);
				const r = await apiCall(token, "DELETE", "/keys/" + index, undefined, nonce);
				if (!r.ok) return say("remoção recusada: " + (r.data.error || r.status), true);
				say(r.data.message || "chave removida");
				setEditing(null);
				await refresh();
			}

			async function doReplace() {
				if (!editing) return;
				if (!editing.key.trim()) return say("chave vazia", true);
				const nonce = await confirmNonce(token, "replace-key", String(editing.index));
				if (!nonce) return say("confirmação recusada", true);
				const r = await apiCall(token, "PUT", "/keys/" + editing.index, { key: editing.key.trim(), persist: editing.persist }, nonce);
				if (!r.ok) return say("substituição recusada: " + (r.data.error || r.status), true);
				say("chave " + r.data.ref + " substituída");
				setEditing(null);
				await refresh();
			}

			async function doTest(index) {
				say("a testar (gasta 1 crédito)…");
				const r = await apiCall(token, "POST", "/keys/" + index + "/test");
				say(r.ok ? "teste: " + (r.data.message || r.data.outcome) : "teste falhou: " + r.status, !r.ok);
				await refresh();
			}

			function saveToken() {
				try {
					sessionStorage.setItem(TOKEN_KEY, token);
				} catch {
					/* armazenamento indisponível */
				}
				void refresh();
			}

			if (!token) {
				return h("div", { className: "dtk-wrap" },
					h("p", { className: "dtk-muted" },
						"Token administrativo do painel Tavily (gerado no primeiro arranque e impresso uma única vez no registo do DSH; recupere com DSH_TAVILY_ADMIN_RESET=1)."),
					h("div", { className: "dtk-row" },
						h("input", { className: "dtk-input", type: "password", placeholder: "token administrativo", value: token, onChange: (e) => setToken(e.target.value) }),
						h("button", { className: "dtk-btn dtk-btn-primary", onClick: saveToken }, "Ligar")));
			}

			return h("div", { className: "dtk-wrap" },
				h("table", { className: "dtk-table" },
					h("thead", null, h("tr", null,
						h("th", null, "#"), h("th", null, "ref"), h("th", null, "estado"),
						h("th", null, "cooldown"), h("th", null, "origem"), h("th", null, "pedidos"), h("th", null, ""))),
					h("tbody", null,
						pool.length === 0
							? h("tr", null, h("td", { colSpan: 7, className: "dtk-muted" }, total === 0 ? "pool vazio — a operar em modo keyless" : "—"))
							: pool.map((k) =>
									editing && editing.index === k.index
										? h("tr", { key: k.index },
												h("td", { colSpan: 7 }, h("div", { className: "dtk-row" },
													h("input", { className: "dtk-input", type: "password", placeholder: "nova chave tvly-…", value: editing.key, onChange: (e) => setEditing({ ...editing, key: e.target.value }) }),
													h("label", null, h("input", { type: "checkbox", checked: editing.persist, onChange: (e) => setEditing({ ...editing, persist: e.target.checked }) }), " persistir"),
													h("button", { className: "dtk-btn dtk-btn-primary", onClick: doReplace }, "Guardar"),
													h("button", { className: "dtk-btn", onClick: () => setEditing(null) }, "Cancelar"))))
										: h("tr", { key: k.index },
												h("td", null, String(k.index)),
												h("td", null, k.ref),
												h("td", null, h("span", { className: "dtk-badge" }, k.status)),
												h("td", null, fmtCooldown(k.cooldownRemainingMs)),
												h("td", null, k.source),
												h("td", null, String(k.totalRequests)),
												h("td", null, h("div", { className: "dtk-row" },
													h("button", { className: "dtk-btn", title: "envia uma pesquisa real (gasta 1 crédito)", onClick: () => doTest(k.index) }, "Testar"),
													h("button", { className: "dtk-btn", onClick: () => setEditing({ index: k.index, key: "", persist: k.source !== "env" }) }, "Editar"),
													h("button", { className: "dtk-btn", onClick: () => doRemove(k.index, k.ref) }, "Remover"))))))),				h("div", { className: "dtk-row" },
					h("input", { className: "dtk-input", type: "password", placeholder: "nova chave tvly-…", value: newKey, onChange: (e) => setNewKey(e.target.value) }),
					h("label", null, h("input", { type: "checkbox", checked: persist, onChange: (e) => setPersist(e.target.checked) }), " persistir (keys.json 0600)"),
					h("button", { className: "dtk-btn dtk-btn-primary", onClick: doAdd }, "Adicionar"),
					h("button", { className: "dtk-btn", onClick: refresh }, "Atualizar")),
				h("p", { className: "dtk-msg" + (msg && msg.error ? " dtk-msg-error" : "") }, msg ? msg.text : ""),
				h("p", { className: "dtk-muted" },
					"CRUD do pool Tavily — as chaves nunca são exibidas integralmente (máscara …últimos4). Operações destrutivas exigem nonce de confirmação."));
		}

		/** Body do plugin de cliente: a secção `settings.section` do painel. */
		function apply(ctx) {
			installStyle();
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "tavily-keys",
						order: 60,
						label: () => "Tavily Keys",
						registrant: "dsh-tavily-resilient-search",
					},
					TavilyKeysSection,
				),
			);
		}

		/** Services do contexto de cliente necessários (o registry de slots). */
		const inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
