# Changelog

Todas as alterações notáveis deste projeto. Formato inspirado em
[Keep a Changelog](https://keepachangelog.com/pt-PT/1.1.0/); versionado segundo
[SemVer](https://semver.org/lang/pt-PT/) — em `0.x`, um **minor** é breaking.

## [0.1.1] — 2026-09-24

### Adicionado

- **Gestão de chaves VIA INTERFACE**: painel autossuficiente em
  `http://127.0.0.1:<porta-do-dsh>/__tavily-keys/` (L1: rotas próprias no
  `ctx.webServer` + L3: chrome `tapIndex` com atalho 🔑 na shell SPA). Faz
  **adicionar**, **remover**, **testar** (1 crédito) e observar o estado do pool
  (`ACTIVE`, `RATE_LIMITED`, `QUOTA_EXHAUSTED`, `REVOKED`) com referências
  mascaradas.
- Gestão do pool em tempo de execução: `TavilyKeyManager.addKey`,
  `removeKeyByIndex`, `getByIndex` e `snapshot()` mascarado (nunca material de
  segredo) + proveniência por chave (`env`/`store`/`ui`).
- Persistência em `$DSH_HOME/dsh-tavily-resilient-search/` (0700): `keys.json`
  (0600) para chaves adicionadas pelo painel e `state.json` (0600) com APENAS o
  digest do token administrativo.
- Baseline de segurança do painel (docs/seguranca.md §6):
  - ordem fixa de verificação **origem (socket + `Origin`) → `Host` →
    credencial**, com denegações 403 byte-idênticas entre si e 401
    byte-idênticos entre si (sem oráculo);
  - token administrativo CSPRNG (256 bits), impresso uma única vez, comparado
    por `timingSafeEqual` sobre digests sha256;
  - orçamento de falhas NIST SP 800-63B-4 (100 falhas → lockout com o MESMO
    401, nunca 429; sucesso reinicia o orçamento);
  - nonce de confirmação para remoções (uso único, com prazo, ligado a
    ação/alvo/origem) contra confused deputy/replay;
  - auditoria apensível (`audit.log` 0600, `O_NOFOLLOW`, modo verificado no
    descritor) de todas as decisões mutáveis e denegações;
  - CSP estrita por resposta com nonce de script; sem cookies (bearer em
    `sessionStorage`) — CSRF estruturalmente neutralizado;
  - **fail-closed** sobre bind não-loopback: o painel não sobe (ruidosamente)
    sem `admin.allowPublicBind: true`; a ferramenta de pesquisa continua.
- Seat `webServer` OPCIONAL via plugin aninhado (`inject: ['webServer']`): o modo
  headless continua a registar `web_search`.
- Espelho de tipos `types/dsh-host-webserver.d.ts` (+ contract test e
  reverificação de rede) para a superfície `register`/`tapIndex`/`WebServer.host`.
- Variáveis `DSH_TAVILY_ADMIN_TOKEN` (traz a própria credencial) e
  `DSH_TAVILY_ADMIN_RESET=1` (regenera e mostra uma única vez).

## [0.1.0] — 2026-09-24

### Adicionado

- Ferramenta `web_search` (endpoint `POST https://api.tavily.com/search`) para o
  DeepSeek Harness, registada via `defineTool` de `@deepseek-ai/dsh-tools` e
  ativada por `dsh.bundle.patch`.
- Gestor de agrupamento de credenciais (`TavilyKeyManager`): máquina de estados
  finita por chave (`ACTIVE`, `RATE_LIMITED`, `QUOTA_EXHAUSTED`, `REVOKED`) com
  distribuição round-robin e recuperação *lazy* de cooldowns.
- Rotação atómica de chaves com reemissão imediata do payload intacto em
  429/432/433/401/5xx; contingência `X-Tavily-Access-Mode: keyless` quando todo o
  pool está impedido; conclusão estruturada (nunca exceção) quando todas as
  alternativas se esgotam.
- Recuo exponencial truncado com jitter: `T = min(T_max, T₀·2ᵏ) + δ`
  (`T₀ = 500 ms`, `T_max = 60 s`, `δ ∈ [0, 500) ms`), ou `Retry-After` quando
  presente (segundos delta ou data HTTP).
- Suspensão de cota até à meia-noite UTC do primeiro dia do mês seguinte
  (reposição mensal determinística da Tavily).
- Salvaguardas de segurança: recusa fail-loud do perfil
  `danger-full-access + approval: never`; redação de segredos por valor em toda a
  saída e registos (máscara `…últimos4` para identificação); teto volumétrico de
  50 KB de texto por invocação; aviso permanente de não-confiança contra injeção
  indireta de instruções.
- Cancelamento cooperativo via `exec.signal` com mensagem contratada, e timeout
  por tentativa tratado como transiente.
- Suporte a cabeçalhos de telemetria: `X-Project-ID` (configurável) e
  `X-Session-Id` (derivado da identidade da chamada).
- Suíte de testes em quatro camadas (unit, integration, adversarial, contract)
  determinística, com espelhos `types/` dos `.d.ts` publicados (proveniência com
  sha256) e reverificação de rede (`scripts/verify-upstream.mjs`).
- Gates de pacote: `publint`, `attw --pack .` e inspeção do tarball real
  (`scripts/check-tarball.mjs`).

### Correções face ao briefing original (medidas, não assumidas)

- `inject: ['tools', 'logger']` → `inject: ['tools']` (`logger` não é Service do
  Cordis; a fiber ficaria `PENDING` para sempre).
- `required: false` no DSL de parâmetros → obrigatoriedade marcada com
  `required: true`; opcional omite a chave.
- `output.schema: { type: 'object' }` → `additionalProperties: false` explícito
  (exigido pelo DSL de esquemas).
- Identificação de credencial em logs: `key.slice(0, 8)` vazava prefixo de
  segredo → máscara `…últimos4`.
- Recuperação de `QUOTA_EXHAUSTED`: o código do briefing nunca reativava chaves
  com cota esgotada; a recuperação após a reposição mensal foi concretizada.
- `Date.now()`/`Math.random()` na lógica → relógio e jitter injetáveis
  (determinismo de testes).
