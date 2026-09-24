/**
 * Página autossuficiente do painel de gestão de chaves.
 *
 * Sem build step, sem assets externos: o script embutido recebe um NONCE por
 * render (`script-src 'nonce-…'`), comunica só com a própria origem
 * (`connect-src 'self'`) e guarda o token apenas em `sessionStorage`.
 */
export interface PageRenderOptions {
  /** Nonce CSP do script embutido (gerado por resposta). */
  scriptNonce: string
  /** Caminho base do painel (prefixo registado no webServer). */
  basePath: string
}

export function renderPage(options: PageRenderOptions): string {
  const { scriptNonce, basePath } = options
  return `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tavily Keys — dsh-tavily-resilient-search</title>
<style>
  :root { color-scheme: light dark; --bd: #8883; --danger: #c0392b; --ok: #1e8e3e; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 860px; padding: 24px; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin: 28px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--bd); }
  input[type=text], input[type=password] { width: 320px; max-width: 100%; padding: 6px; }
  button { padding: 6px 12px; margin-left: 6px; cursor: pointer; }
  .badge { padding: 1px 8px; border-radius: 9px; font-size: 12px; border: 1px solid var(--bd); }
  .ACTIVE { color: var(--ok); } .REVOKED { color: var(--danger); }
  .RATE_LIMITED, .QUOTA_EXHAUSTED { color: #b26a00; }
  #log { min-height: 20px; color: var(--danger); margin: 8px 0; }
  .muted { opacity: .7; font-size: 12px; }
</style>
</head>
<body>
<h1>🔑 Gestão de chaves Tavily</h1>
<p class="muted">Pool de credenciais de <code>${basePath}</code>. As chaves nunca são exibidas integralmente.</p>

<div id="auth-row">
  <h2>Autenticação</h2>
  <input id="token" type="password" placeholder="token administrativo" autocomplete="off">
  <button id="btn-auth">Ligar</button>
  <p class="muted">O token é gerado no primeiro arranque e mostrado uma única vez no registo do DSH
  (<code>logger 'tavily-pool'</code>). Só fica nesta aba (<code>sessionStorage</code>).</p>
</div>

<div id="panel" hidden>
  <h2>Pool</h2>
  <table id="pool">
    <thead><tr><th>#</th><th>ref</th><th>estado</th><th>cooldown</th><th>origem</th><th>pedidos</th><th></th></tr></thead>
    <tbody></tbody>
  </table>

  <h2>Adicionar chave</h2>
  <input id="new-key" type="password" placeholder="tvly-…" autocomplete="off">
  <label><input id="persist" type="checkbox" checked> persistir (keys.json 0600)</label>
  <button id="btn-add">Adicionar</button>

  <p id="log"></p>
  <button id="btn-refresh">Atualizar</button>
</div>

<script nonce="${scriptNonce}">
(function () {
  var BASE = ${JSON.stringify(basePath)};
  var token = sessionStorage.getItem('dsh-tavily-token') || '';
  var $ = function (id) { return document.getElementById(id); };

  function authHeaders(extra) {
    var h = Object.assign({ 'authorization': 'Bearer ' + token }, extra || {});
    return h;
  }
  function say(msg) { $('log').textContent = msg || ''; }
  function fmtCooldown(ms) {
    if (!ms || ms <= 0) return '—';
    var s = Math.ceil(ms / 1000);
    return s >= 90 ? Math.ceil(s / 60) + ' min' : s + ' s';
  }

  async function call(method, path, body, confirmNonce) {
    var headers = authHeaders(body ? { 'content-type': 'application/json' } : {});
    if (confirmNonce) headers['x-confirm-nonce'] = confirmNonce;
    var res = await fetch(BASE + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = {};
    try { data = await res.json(); } catch (e) { /* corpo não-JSON */ }
    return { ok: res.ok, status: res.status, data: data };
  }

  async function refresh() {
    var r = await call('GET', '/api/status');
    if (!r.ok) { say(r.status === 401 ? 'autenticação recusada (ou orçamento de falhas esgotado)' : 'falha ' + r.status); return; }
    say('');
    $('panel').hidden = false;
    var tbody = $('pool').querySelector('tbody');
    tbody.textContent = '';
    (r.data.pool || []).forEach(function (k) {
      var tr = document.createElement('tr');
      [String(k.index), k.ref,
       '<span class="badge ' + k.status + '">' + k.status + '</span>',
       fmtCooldown(k.cooldownRemainingMs), k.source, String(k.totalRequests)
      ].forEach(function (cell, i) {
        var td = document.createElement('td');
        if (i === 2) td.innerHTML = cell; else td.textContent = cell;
        tr.appendChild(td);
      });
      var td = document.createElement('td');
      var bTest = document.createElement('button');
      bTest.textContent = 'Testar';
      bTest.title = 'envia uma pesquisa real (gasta 1 crédito)';
      bTest.onclick = async function () {
        say('a testar (1 crédito)…');
        var t = await call('POST', '/api/keys/' + k.index + '/test');
        say(t.ok ? ('teste: ' + (t.data.message || t.data.outcome)) : ('teste falhou: ' + t.status));
        refresh();
      };
      var bEdit = document.createElement('button');
      bEdit.textContent = 'Editar';
      bEdit.onclick = async function () {
        var nova = prompt('Nova chave para ' + k.ref + ' (substitui a credencial):');
        if (!nova) return;
        var c = await call('POST', '/api/confirm', { action: 'replace-key', target: String(k.index) });
        if (!c.ok || !c.data.nonce) { say('confirmação recusada'); return; }
        var r = await call('PUT', '/api/keys/' + k.index, { key: nova.trim() }, c.data.nonce);
        say(r.ok ? ('chave substituída (' + r.data.ref + ')') : ('substituição recusada: ' + (r.data.error || r.status)));
        refresh();
      };
      var bDel = document.createElement('button');
      bDel.textContent = 'Remover';
      bDel.onclick = async function () {
        if (!confirm('Remover a chave ' + k.ref + ' do pool?')) return;
        var c = await call('POST', '/api/confirm', { action: 'remove-key', target: String(k.index) });
        if (!c.ok || !c.data.nonce) { say('confirmação recusada'); return; }
        var d = await call('DELETE', '/api/keys/' + k.index, undefined, c.data.nonce);
        say(d.ok ? 'chave removida' : ('remoção recusada: ' + d.status));
        refresh();
      };
      td.appendChild(bTest); td.appendChild(bEdit); td.appendChild(bDel);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
  }

  $('btn-auth').onclick = async function () {
    token = $('token').value.trim();
    sessionStorage.setItem('dsh-tavily-token', token);
    refresh();
  };
  $('btn-add').onclick = async function () {
    var key = $('new-key').value.trim();
    if (!key) { say('chave vazia'); return; }
    var r = await call('POST', '/api/keys', { key: key, persist: $('persist').checked });
    say(r.ok ? 'chave adicionada (' + r.data.ref + ')' : ('adição recusada: ' + r.status));
    $('new-key').value = '';
    refresh();
  };
  $('btn-refresh').onclick = refresh;
  if (token) refresh();
})();
</script>
</body>
</html>`
}
