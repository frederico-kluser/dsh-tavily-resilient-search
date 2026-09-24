# Arquitetura

Tudo no DeepSeek Harness é plugin — incluindo o próprio `agent loop`. Não há
núcleo privilegiado monolítico: cada capacidade é um módulo Cordis desacoplado.
Este documento regista o que foi **medido** nos tarballs npm publicados (nunca
inferido de prosa) e como este plugin se encaixa nessa malha.

## 1. Composição espácio-temporal (Cordis v4)

- **Composição espacial** — um plugin declara `inject: string[]`; o Cordis
  protela a ativação até que os serviços injetados existam. Aqui:
  `inject = ['tools']` (o service `ToolRuntime`, medido em
  `@deepseek-ai/dsh-tools` via `super(ctx, "tools")` e a augmentation
  `declare module '@deepseek-ai/cordis' { interface Context { tools: ToolRuntime } }`).
- **Composição temporal** — todo efeito secundário é reversível: registos
  (`ctx.tools.register`) devolvem um *disposer* exato, entregue a
  `ctx.effect(...)`. Em hot-reload/unload o Cordis executa os destruidores em
  ordem **LIFO**, sem fugas nem escutas órfãs.
- **`ctx.logger(nome)`** é método direto do contexto (`LoggerService` estende
  `Record<LoggerType, LoggerMethod>`), **não** um service injetável — ver P-09
  abaixo.

## 2. Superfície de ferramentas (medida)

`defineTool` (`@deepseek-ai/dsh-tools/lib/types/schema.d.ts`) compila um DSL
tipado para JSON Schema padrão, que os adaptadores `ctx.llm` traduzem em tempo
real para Function Calling (OpenAI), Tool Use (Anthropic), esquemas DeepSeek ou
parametrização Ollama. Contratos usados:

- `DefineToolOptions<S, O>`: `name`, `description`, `parameters`
  (`ParameterSchemaSpec` — obrigatoriedade por `required?: true`), `output:
  { schema: O, render }`, `timeoutMs?`, `execute(args, exec: ToolRunContext)`.
- `output.schema` é um `ValueSchemaSpec`; objetos exigem
  `additionalProperties: boolean` explícito; `oneOf` infere a união dos ramos
  (`{type:'null'}` → `null`).
- `execute` devolve **apenas** o valor canónico (lossless JSON) declarado em
  `output.schema`; a projeção para o modelo é `render(args, value): ContentBlock[]`.
- `timeoutMs` é orçamento **cooperativo** (nunca vai para o modelo) e afirma que
  o corpo encaminha `exec.signal` até à quiescência.
- `isConcurrencySafe` foi deliberadamente **omitido**: o pool de chaves é estado
  mutável do dono; a classificação conservadora impede sobreposição de chamadas
  irmãs (contrato de execução paralela do registry).

Pipeline do host (por onde toda a chamada passa):
`tools/pre-execute` (política → `allow|deny|ask`) → *monotonic guards* (`ctx.tools.guard`,
invioláveis) → `tools/execute` (around-dispatch — é aqui que o corpo corre) →
`tools/post-execute` (normalização) → `tool/result` (registo imutável da sessão).

## 3. Ciclo de rotação atómica (núcleo do plugin)

A separação é total entre intenção semântica (a `query`) e despacho físico
(`fetch` + cabeçalhos). Algoritmo:

```
maxAttempts ← |pool| + 1                      # a +1 é a contingência keyless
repeat maxAttempts vezes:
    se exec.signal.aborted → lançar ABORTED    # cancelamento é a ÚNICA exceção
    key ← pool.getNextKey()                   # round-robin + reviver cooldowns
    se key = ∅ → cabeçalho X-Tavily-Access-Mode: keyless
    senão        → Authorization: Bearer <key>
    resposta ← fetch(payload INTACTO, timeout ∪ exec.signal)
    2xx   → normalizar + teto de 50 KB → devolver valor canónico
    400/403/outros 4xx → devolver erro estruturado (NÃO rotaciona)
    401   → markRevoked(key); continuar
    429   → markRateLimited(key, Retry-After); continuar
    432/433 → markQuotaExhausted(key); continuar
    5xx/rede/timeout → continuar (transiente)
devolver conclusão estruturada de indisponibilidade   # nunca uma exceção
```

Máquina de estados por credencial:

| Estado | Entrada | Saída | Temporização |
| --- | --- | --- | --- |
| `ACTIVE` | arranque / cooldown expirado | — | — |
| `RATE_LIMITED` | 429 | `ACTIVE` | `Retry-After` ou `min(60 s, 500 ms·2ᵏ) + δ`, `δ ∈ [0,500) ms` |
| `QUOTA_EXHAUSTED` | 432/433 | `ACTIVE` | meia-noite UTC do 1.º dia do mês seguinte |
| `REVOKED` | 401 | — (definitivo) | — |

As mutações são síncronas sobre propriedades (event loop), logo atómicas face ao
despacho. A recuperação é *lazy*: leituras (`getStatus`) não mutam; a expiração é
aplicada na seleção seguinte.

## 4. Fio HTTP Tavily

`POST https://api.tavily.com/search` com corpo
`{ query, search_depth, max_results, topic, include_answer, chunks_per_source }`
— `include_raw_content` é **nunca** enviado (explosão de contexto). Cabeçalhos:
`Authorization: Bearer <key>` (ou `X-Tavily-Access-Mode: keyless`),
`Content-Type: application/json`, `X-Project-ID` (opcional), `X-Session-Id`
(identidade opaca da chamada — correlação de tarefas encadeadas).
`X-Human-Id` é deliberadamente omitido: não existe, neste contexto, uma
identidade humana verificável para imputar.

Classificação discriminatória de estados: 2xx sucesso · 400 payload malformado ·
401 credencial irrecuperável · 403 acesso interdito · 429 saturação por minuto ·
432 cota mensal · 433 teto PAYGO · 5xx transiente.

## 5. Proveniência da API (Q-1)

Toda a superfície assumida está espelhada em `types/` (verbatim, com sha256 do
tarball) e travada por `test/contract/types-contract.test.ts` contra o pacote
instalado. `pnpm run check:upstream` reverifica pela rede (re-descarga + sha256 +
blocos) e `--write-mirrors` regenera os espelhos.

| Pacote | Versão | sha256 do tarball |
| --- | --- | --- |
| `@deepseek-ai/dsh-tools` | `0.1.7-rc.1` | `9549f080afb5be55013eeeca728b0658321182af909c18890d6e6f1a3996e31b` |
| `@deepseek-ai/cordis` | `4.0.4` | `99a5cdb344de37cb033cb4e3a1dcfd29585d46f7d3a9c64bca9991554927185c` |
| `@deepseek-ai/dsh-llm` | `0.1.7-rc.1` | `00ed0fd4bf4fc31b5656de7d53cb638b2b7128f6426a2fe321d34f618d6870ec` |

Drift medido `0.1.1-rc.1 → 0.1.7-rc.1` em `defineTool`: **apenas aditivo**
(`deferLoading?`, `projectContent?`) — a gama `^0.1.1-rc.1 || ^0.1.7-rc.1` é
suportada. Atenção: o dist-tag `latest` dos subpacotes `dsh-*` aponta para a
publicação mais antiga (`0.0.1-rc.1`); a linha viva é `next`.

## 6. Anti-patterns refutados por medição

| # | Afirmação morta | Realidade medida |
| --- | --- | --- |
| P-06 | `dsh.bundle: {}` ativa o plugin | só `dsh.bundle.patch` decide ativação |
| P-09 | `inject: ['logger']` funciona | `logger` não é Service — fiber `PENDING` para sempre; usar `ctx.logger(nome)` |
| — | `required: false` no DSL | opcional omite-se; `required?: true` é a única anotação de obrigatoriedade |
| — | `output.schema: {type:'object'}` chega | objetos exigem `additionalProperties: boolean` |
| P-01 | `ctx.httpServer` | `ctx.webServer` (desde 0.0.1-rc.3) |
| P-02/P-03 | `spawn(cmd, args, opts)` / `dsh-host-subprocess` | `ctx.subprocess.spawn(spec)` / `@deepseek-ai/dsh-subprocess` |
