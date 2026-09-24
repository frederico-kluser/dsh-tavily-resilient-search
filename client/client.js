/**
 * Meio do cliente do plugin (bundle de browser) — CRUD de chaves Tavily como
 * SECÇÃO NATIVA de Definições do DSH (`settings.section`), com botão de
 * arranque (`settings.launcher`) que SÓ aparece quando não existe chave válida.
 *
 * Contrato do bundle (medido em @deepseek-ai/dsh-client-ui-message-feedback
 * @0.1.7-rc.1 lib/client.js): factory registada em
 * `window.__ModuleLoader__.load({ id, factory: (require) => ... })` exportando
 * `apply(ctx)` e `inject`. Estilo com as variáveis de design `--dsw-alias-*` do
 * próprio DSH. Sem JSX: `react.createElement` à mão (sem build step).
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
		const CTA_ID = "dsh-tavily-keys-cta";

		/* ---------------------------------------------------------------- */
		/* estado partilhado: "é preciso configurar?" (visibilidade do botão) */
		/* ---------------------------------------------------------------- */
		const setupState = { needed: null, listeners: new Set() };
		function setSetupNeeded(value) {
			setupState.needed = value;
			for (const listener of setupState.listeners) listener(value);
		}
		async function refreshSetupState() {
			try {
				const res = await fetch(API + "/health");
				const data = await res.json();
				setSetupNeeded(Boolean(data && data.needsSetup));
				return data;
			} catch {
				return null;
			}
		}

		/* ---------------------------------------------------------------- */
		/* transporte                                                        */
		/* ---------------------------------------------------------------- */
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

		async function confirmNonce(token, action, target) {
			const r = await apiCall(token, "POST", "/confirm", { action, target });
			return r.ok && r.data.nonce ? r.data.nonce : null;
		}

		/* ---------------------------------------------------------------- */
		/* utilidades                                                        */
		/* ---------------------------------------------------------------- */
		function fmtCooldown(ms) {
			if (!ms || ms <= 0) return "—";
			const s = Math.ceil(ms / 1000);
			return s >= 90 ? Math.ceil(s / 60) + " min" : s + " s";
		}

		function readStoredToken() {
			try {
				return window.localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";
			} catch {
				return "";
			}
		}

		function storeToken(token, remember) {
			try {
				if (remember) window.localStorage.setItem(TOKEN_KEY, token);
				else sessionStorage.setItem(TOKEN_KEY, token);
			} catch {
				/* armazenamento indisponível */
			}
		}

		/* ---------------------------------------------------------------- */
		/* abrir Definições (o shell detém o estado aberto/fechado)          */
		/* ---------------------------------------------------------------- */
		function focusTavilySection() {
			setTimeout(() => {
				const nodes = document.querySelectorAll("button, [role=button], a");
				for (const node of nodes) {
					if ((node.textContent || "").includes("Tavily Keys")) {
						node.click();
						return;
					}
				}
			}, 350);
		}

		function openSettingsBestEffort(open) {
			if (typeof open === "function") {
				open();
				focusTavilySection();
				return true;
			}
			const nodes = document.querySelectorAll("button, [role=button], a");
			for (const node of nodes) {
				const label = ((node.getAttribute && node.getAttribute("aria-label")) || node.textContent || "").trim().toLowerCase();
				if (label.length > 0 && label.length < 24 && /settings|defini|prefer/.test(label)) {
					node.click();
					focusTavilySection();
					return true;
				}
			}
			return false;
		}

		/* ---------------------------------------------------------------- */
		/* estilos (variáveis de design do próprio DSH)                      */
		/* ---------------------------------------------------------------- */
		function installStyle() {
			if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
			const tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.dataset.plugin = "dsh-tavily-resilient-search";
			tag.textContent = [
				".dtk-wrap{display:flex;flex-direction:column;gap:14px;max-width:720px}",
				".dtk-hint{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-caption);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;padding:10px 14px}",
				".dtk-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
				".dtk-input{flex:1 1 240px;min-width:0;padding:9px 12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}",
				".dtk-input:focus{outline:2px solid var(--dsw-alias-button-primary-fill);outline-offset:1px}",
				".dtk-btn{padding:8px 16px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;white-space:nowrap}",
				".dtk-btn:hover{border-color:var(--dsw-alias-border-l3)}",
				".dtk-btn:disabled{opacity:.55;cursor:default}",
				".dtk-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}",
				".dtk-key{display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:14px;padding:12px 16px}",
				".dtk-key-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
				".dtk-ref{font-family:ui-monospace,monospace;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
				".dtk-badge{padding:1px 10px;border-radius:99px;border:1px solid currentColor;font-size:11px;font-family:ui-monospace,monospace}",
				".dtk-badge-ACTIVE{color:var(--dsw-alias-semantic-success,#1e8e3e)}",
				".dtk-badge-RATE_LIMITED,.dtk-badge-QUOTA_EXHAUSTED{color:var(--dsw-alias-semantic-warning,#b26a00)}",
				".dtk-badge-REVOKED{color:var(--dsw-alias-semantic-error,#c0392b)}",
				".dtk-meta{font-size:11.5px;color:var(--dsw-alias-label-caption)}",
				".dtk-actions{margin-left:auto;display:flex;gap:6px}",
				".dtk-msg{min-height:20px;font-size:12.5px;display:flex;align-items:center;gap:8px}",
				".dtk-msg-ok{color:var(--dsw-alias-semantic-success,#1e8e3e)}",
				".dtk-msg-error{color:var(--dsw-alias-semantic-error,#c0392b)}",
				".dtk-spin{width:13px;height:13px;border-radius:99px;border:2px solid currentColor;border-top-color:transparent;animation:dtk-spin .7s linear infinite;display:inline-block}",
				"@keyframes dtk-spin{to{transform:rotate(360deg)}}",
				".dtk-links{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;align-items:center}",
				".dtk-links a{color:var(--dsw-alias-button-primary-fill)}",
				".dtk-cta{padding:8px 14px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}",
				".dtk-cta-float{position:fixed;right:18px;bottom:18px;z-index:2147483000;box-shadow:0 8px 24px rgba(0,0,0,.25)}",
				"@media (prefers-reduced-motion:reduce){.dtk-spin{animation:none}}",
			].join("");
			document.head.appendChild(tag);
		}

		/* ---------------------------------------------------------------- */
		/* botão de arranque — SÓ sem chave válida (regra do utilizador)     */
		/* ---------------------------------------------------------------- */
		function TavilyKeysLauncher(props) {
			const h = react.createElement;
			const [needed, setNeeded] = react.useState(setupState.needed === true);
			react.useEffect(() => {
				const listener = (value) => setNeeded(Boolean(value));
				setupState.listeners.add(listener);
				void refreshSetupState();
				return () => setupState.listeners.delete(listener);
			}, []);
			if (!needed) return null;
			return h(
				"button",
				{
					className: "dtk-cta",
					title: "Configurar chaves de pesquisa Tavily",
					onClick: () => openSettingsBestEffort(props && props.openSettings),
				},
				"🔑 Tavily Keys",
			);
		}

		/** Fallback DOM quando o launcher não existe na composição. */
		function installDomFallbackCta() {
			if (typeof document === "undefined") return;
			const sync = () => {
				const existing = document.getElementById(CTA_ID);
				if (setupState.needed === true) {
					if (!existing) {
						const btn = document.createElement("button");
						btn.id = CTA_ID;
						btn.className = "dtk-cta dtk-cta-float";
						btn.textContent = "🔑 Configurar chaves Tavily";
						btn.addEventListener("click", () => {
							if (!openSettingsBestEffort()) {
								window.alert("Abre Definições → Tavily Keys para configurar as chaves de pesquisa.");
							}
						});
						document.body.appendChild(btn);
					}
				} else if (existing) {
					existing.remove();
				}
			};
			setupState.listeners.add(sync);
			void refreshSetupState().then(sync);
		}

		/* ---------------------------------------------------------------- */
		/* linha de uma credencial (cartão)                                  */
		/* ---------------------------------------------------------------- */
		function KeyRow(props) {
			const h = react.createElement;
			const k = props.k;
			const busy = props.busy;
			return h(
				"div",
				{ className: "dtk-key" },
				h(
					"div",
					{ className: "dtk-key-top" },
					h("span", { className: "dtk-ref" }, k.ref),
					h("span", { className: "dtk-badge dtk-badge-" + k.status }, k.status),
					h("span", { className: "dtk-meta" }, "cooldown " + fmtCooldown(k.cooldownRemainingMs)),
					h(
						"div",
						{ className: "dtk-actions" },
						h("button", { className: "dtk-btn", disabled: Boolean(busy), title: "envia uma pesquisa real (gasta 1 crédito)", onClick: () => props.onTest(k.index) }, busy === "test" ? "…" : "Testar"),
						h("button", { className: "dtk-btn", disabled: Boolean(busy), onClick: () => props.onEdit(k) }, "Editar"),
						h("button", { className: "dtk-btn", disabled: Boolean(busy), onClick: () => props.onRemove(k) }, "Remover"),
					),
				),
				h("div", { className: "dtk-meta" }, "origem " + k.source + " · " + k.totalRequests + " pedidos"),
			);
		}

		/* ---------------------------------------------------------------- */
		/* secção de Definições — TODO o CRUD acontece aqui                  */
		/* ---------------------------------------------------------------- */
		function TavilyKeysSection() {
			const h = react.createElement;
			const [token, setToken] = react.useState(readStoredToken);
			const [tokenInput, setTokenInput] = react.useState("");
			const [remember, setRemember] = react.useState(true);
			const [pool, setPool] = react.useState([]);
			const [stateDir, setStateDir] = react.useState("");
			const [msg, setMsg] = react.useState(null);
			const [busy, setBusy] = react.useState(null);
			const [newKey, setNewKey] = react.useState("");
			const [persist, setPersist] = react.useState(true);
			const [editing, setEditing] = react.useState(null);

			const say = (text, kind) => setMsg({ text, kind: kind || "ok" });

			const refresh = react.useCallback(
				async function () {
					if (!token) return false;
					const r = await apiCall(token, "GET", "/status");
					if (!r.ok) {
						say(r.status === 401 ? "Token recusado — confirma o token (ver “Onde está o token?” abaixo)." : "Falha " + r.status + " ao ler o estado.", "error");
						return false;
					}
					setPool(r.data.pool || []);
					setStateDir(r.data.stateDir || "");
					void refreshSetupState();
					return true;
				},
				[token],
			);

			react.useEffect(() => {
				if (token) void refresh();
			}, [token, refresh]);

			async function doLogin() {
				const value = tokenInput.trim();
				if (!value) return say("Cola o token administrativo para ligar.", "error");
				setBusy("login");
				const r = await apiCall(value, "GET", "/status");
				setBusy(null);
				if (!r.ok) {
					say(
						"Token recusado (" + r.status + "). O token está em ~/.dsh/dsh-tavily-resilient-search/admin-token.txt ou no log do arranque. Sem nenhum: DSH_TAVILY_ADMIN_RESET=1.",
						"error",
					);
					return;
				}
				setToken(value);
				storeToken(value, remember);
				setTokenInput("");
				setPool(r.data.pool || []);
				setStateDir(r.data.stateDir || "");
				say("Ligado — " + (r.data.totalKeys || 0) + " credenciais no pool.", "ok");
				void refreshSetupState();
			}

			async function doAdd() {
				const key = newKey.trim();
				if (!key) return say("Chave vazia — cola uma chave tvly-… primeiro.", "error");
				setBusy("add");
				const r = await apiCall(token, "POST", "/keys", { key, persist });
				setBusy(null);
				if (!r.ok) {
					say("Adição recusada: " + (r.data.error || r.status), "error");
					return;
				}
				setNewKey("");
				say("Chave " + r.data.ref + " adicionada" + (r.data.persisted ? " e persistida." : "."), "ok");
				await refresh();
			}

			async function doRemove(k) {
				if (!window.confirm("Remover a chave " + k.ref + " do pool?")) return;
				setBusy("remove-" + k.index);
				const nonce = await confirmNonce(token, "remove-key", String(k.index));
				const r = nonce ? await apiCall(token, "DELETE", "/keys/" + k.index, undefined, nonce) : { ok: false, status: 428, data: {} };
				setBusy(null);
				if (!r.ok) return say("Remoção recusada: " + (r.data.error || r.status), "error");
				say(r.data.message || "Chave removida.", "ok");
				setEditing(null);
				await refresh();
			}

			async function doReplace() {
				if (!editing) return;
				const key = String(editing.value || "").trim();
				if (!key) return say("Cola a nova chave antes de guardar.", "error");
				setBusy("replace-" + editing.index);
				const nonce = await confirmNonce(token, "replace-key", String(editing.index));
				const r = nonce ? await apiCall(token, "PUT", "/keys/" + editing.index, { key, persist: editing.persist }, nonce) : { ok: false, status: 428, data: {} };
				setBusy(null);
				if (!r.ok) return say("Substituição recusada: " + (r.data.error || r.status), "error");
				say("Chave " + r.data.ref + " substituída — credencial nova com estado fresco.", "ok");
				setEditing(null);
				await refresh();
			}

			async function doTest(index) {
				setBusy("test-" + index);
				say("A testar a chave (gasta 1 crédito)…", "ok");
				const r = await apiCall(token, "POST", "/keys/" + index + "/test");
				setBusy(null);
				say(r.ok ? "Teste: " + (r.data.message || r.data.outcome) : "Teste falhou: " + r.status, r.ok ? "ok" : "error");
				await refresh();
			}

			function logout() {
				setToken("");
				try {
					window.localStorage.removeItem(TOKEN_KEY);
					sessionStorage.removeItem(TOKEN_KEY);
				} catch {
					/* ignore */
				}
			}

			/* ---------- portão de autenticação ---------- */
			if (!token) {
				return h(
					"div",
					{ className: "dtk-wrap" },
					h("div", { className: "dtk-hint" },
						"O painel exige o token administrativo (esta máquina apenas). ",
						h("br"), "Onde está: ",
						h("code", null, "~/.dsh/dsh-tavily-resilient-search/admin-token.txt"),
						" ou no log do arranque do DSH. ",
						h("br"), "Sem token nenhum? Recarrega o Harness com ",
						h("code", null, "DSH_TAVILY_ADMIN_RESET=1"),
						" — é gerado um novo."),
					h("div", { className: "dtk-row" },
						h("input", {
							className: "dtk-input", type: "password", placeholder: "token administrativo",
							value: tokenInput, autoFocus: true,
							onChange: (e) => setTokenInput(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") void doLogin(); },
						}),
						h("button", { className: "dtk-btn dtk-btn-primary", disabled: busy === "login", onClick: () => void doLogin() },
							busy === "login" ? h("span", { className: "dtk-spin" }) : "Ligar"),
					),
					h("label", { className: "dtk-meta" },
						h("input", { type: "checkbox", checked: remember, onChange: (e) => setRemember(e.target.checked) }),
						" lembrar neste browser"),
					h("div", { className: "dtk-msg " + (msg && msg.kind === "error" ? "dtk-msg-error" : "dtk-msg-ok") }, msg ? msg.text : ""),
				);
			}

			/* ---------- CRUD ---------- */
			const rows = pool.map((k) => {
				if (editing && editing.index === k.index) {
					return h(
						"div",
						{ key: k.index, className: "dtk-key" },
						h("div", { className: "dtk-key-top" }, h("span", { className: "dtk-ref" }, "Substituir " + k.ref)),
						h("div", { className: "dtk-row" },
							h("input", {
								className: "dtk-input", type: "password", placeholder: "nova chave tvly-…", autoFocus: true,
								value: editing.value,
								onChange: (e) => setEditing({ ...editing, value: e.target.value }),
								onKeyDown: (e) => {
									if (e.key === "Enter") void doReplace();
									if (e.key === "Escape") setEditing(null);
								},
							}),
							h("label", { className: "dtk-meta" },
								h("input", { type: "checkbox", checked: editing.persist, onChange: (e) => setEditing({ ...editing, persist: e.target.checked }) }),
								" persistir"),
							h("button", { className: "dtk-btn dtk-btn-primary", disabled: busy === "replace-" + k.index, onClick: () => void doReplace() },
								busy === "replace-" + k.index ? h("span", { className: "dtk-spin" }) : "Guardar"),
							h("button", { className: "dtk-btn", onClick: () => setEditing(null) }, "Cancelar"),
						),
					);
				}
				return h(KeyRow, {
					key: k.index, k,
					busy: busy && busy.endsWith("-" + k.index) ? busy.split("-")[0] : null,
					onTest: doTest,
					onEdit: (entry) => setEditing({ index: entry.index, value: "", persist: entry.source !== "env" }),
					onRemove: doRemove,
				});
			});

			return h(
				"div",
				{ className: "dtk-wrap" },
				h("div", { className: "dtk-msg " + (msg && msg.kind === "error" ? "dtk-msg-error" : "dtk-msg-ok") },
					msg ? (msg.kind === "error" ? "⚠ " : "✓ ") + msg.text : ""),
				h("div", { className: "dtk-row" },
					h("input", {
						className: "dtk-input", type: "password", placeholder: "nova chave tvly-… para adicionar ao pool",
						value: newKey,
						onChange: (e) => setNewKey(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") void doAdd(); },
					}),
					h("label", { className: "dtk-meta" },
						h("input", { type: "checkbox", checked: persist, onChange: (e) => setPersist(e.target.checked) }),
						" persistir"),
					h("button", { className: "dtk-btn dtk-btn-primary", disabled: busy === "add", onClick: () => void doAdd() },
						busy === "add" ? h("span", { className: "dtk-spin" }) : "Adicionar"),
				),
				pool.length === 0
					? h("div", { className: "dtk-hint" }, "Ainda sem credenciais — a pesquisa funciona em modo keyless (limites muito mais severos). Adiciona pelo menos uma chave tvly-…")
					: h("div", null, ...rows),
				h("div", { className: "dtk-links" },
					h("a", { href: "https://app.tavily.com", target: "_blank", rel: "noreferrer" }, "Obter chaves em app.tavily.com"),
					stateDir
						? h("a", { href: "#", onClick: (e) => { e.preventDefault(); window.alert("Token em: " + stateDir + "/admin-token.txt"); } }, "Onde está o token?")
						: null,
					h("a", { href: "https://github.com/frederico-kluser/dsh-tavily-resilient-search#readme", target: "_blank", rel: "noreferrer" }, "Documentação"),
					h("button", { className: "dtk-btn", onClick: logout }, "Desligar"),
				),
				h("div", { className: "dtk-meta" }, "Referências mascaradas (…últimos4) — as chaves nunca são exibidas integralmente. Ações destrutivas pedem confirmação."),
			);
		}

		/* ---------------------------------------------------------------- */
		/* arranque                                                          */
		/* ---------------------------------------------------------------- */
		function apply(ctx) {
			installStyle();
			// 1) TODO o CRUD vive em Definições → Tavily Keys.
			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{ name: "settings.section", id: "tavily-keys", order: 60, label: () => "Tavily Keys", registrant: "dsh-tavily-resilient-search" },
						TavilyKeysSection,
					),
				);
			} catch {
				/* composição sem o slot de secções */
			}
			// 2) botão na área lateral SÓ quando não existe chave válida.
			let launcherOk = false;
			try {
				ctx.slots.inject("settings.launcher", () =>
					ctx.slots.register(
						{ name: "settings.launcher", id: "tavily-keys-cta", order: 60, registrant: "dsh-tavily-resilient-search" },
						TavilyKeysLauncher,
					),
				);
				launcherOk = true;
			} catch {
				/* sem launcher disponível */
			}
			if (!launcherOk) installDomFallbackCta();
		}

		const inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
