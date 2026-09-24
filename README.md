# dsh-tavily-resilient-search

Pesquisa web em tempo real para o **DeepSeek Harness** (DSH), através da API
[Tavily](https://tavily.com), com **rotação atómica e resiliente de um agrupamento
de credenciais** e contingência *keyless* — sem quebrar o `agent loop` quando as
chaves atingem limites de taxa (429), esgotam a cota mensal (432/433) ou são
revogadas (401).

Plugin **Cordis** autónomo: instala-se por manifesto, sem *forks* do código do
DSH, e sobrevive a hot-reload/unload sem fugas nem escutas órfãs.

---

## O problema que resolve

Numa implementação ingénua, um `HTTP 429` ou `432` é propagado como rejeição de
promessa à rotina de turnos: o turno termina abruptamente — ou o modelo conclui,
erradamente, que "a internet deixou de existir". Aqui, a intenção semântica
(pesquisar) está desacoplada da camada física (qual credencial despacha agora):

- erros de **saturação/faturação** mutam o estado da chave causadora e a chamada
  é **reemitida de imediato** com o payload intacto, pela próxima credencial
  desimpedida (round-robin);
- quando todo o pool está impedido, ativa-se a contingência **keyless**
  (`X-Tavily-Access-Mode: keyless`);
- só quando **todas** as alternativas de transporte se esgotam é que a ferramenta
  devolve uma conclusão estruturada de aviso — **nunca** uma exceção que ejetasse
  o processo hospedeiro.

## Instalação

```bash
dsh plugin --profile web add dsh-tavily-resilient-search
```

A ativação é automática: o pacote declara `dsh.bundle.patch` (apenas
`dsh.bundle.patch` ativa um plugin — um `bundle: {}` vazio não ativa nada) e o
manifesto `cordis.patch.yml` entra na camada **Bundle** da composição.

Defina as credenciais por variáveis de ambiente (nunca em texto simples):

```bash
export TAVILY_API_KEY_A="tvly-..."
export TAVILY_API_KEY_B="tvly-..."   # tantas quantas as contas disponíveis
export TAVILY_API_KEY_C="tvly-..."
export TAVILY_API_KEY_D="tvly-..."
```

Sem nenhuma chave o plugin **não rebenta o boot**: degrada para o modo
*keyless-only* (limites muito mais severos) e avisa em voz alta. Estado
legítimo documentado: "ainda não configurado".

## Gestão de chaves via interface

Para além das variáveis de ambiente, o plugin serve um **painel de gestão do
pool** no próprio webServer do DSH:

```
http://127.0.0.1:<porta-do-dsh>/__tavily-keys/
```

(um atalho 🔑 *Tavily Keys* é injetado na shell SPA via `tapIndex`). O painel
permite **adicionar** chaves (opcionalmente persistidas em `keys.json` 0600),
**remover** (com nonce de confirmação), **testar** uma chave (envia uma pesquisa
real — gasta 1 crédito) e ver o estado do pool em tempo real.

- **Autenticação**: token administrativo gerado por CSPRNG no primeiro arranque e
  mostrado **uma única vez** no registo do DSH (`logger 'tavily-pool'`); depois
  só o digest fica em `state.json` (0600). Perdeu? Recarregue com
  `DSH_TAVILY_ADMIN_RESET=1`. Também pode definir `DSH_TAVILY_ADMIN_TOKEN`.
- **Fronteira**: origem (socket + `Origin`) → `Host` → credencial, por esta
  ordem fixa; denegações byte-idênticas (sem oráculo). Predefinição: só
  loopback (`admin.trustedRemotes` / `admin.allowedHosts`).
- **Força bruta**: orçamento NIST SP 800-63B-4 (100 falhas → lockout com o
  mesmo 401).
- **Ações destrutivas** (remoção) exigem nonce de confirmação, de uso único.
- **Auditoria**: `audit.log` apensível (0600, `O_NOFOLLOW`) com todas as
  decisões mutáveis e denegações.
- Chaves removidas que vêm do **ambiente** regressam no próximo arranque (a
  remoção é volátil e o painel avisa); chaves persistidas/removidas pelo painel
  são definitivas.
- Sobre um bind público (`0.0.0.0`) o painel **recusa-se a subir** (fail-closed,
  ruidoso) até `admin.allowPublicBind: true` — a ferramenta de pesquisa continua
  a funcionar em qualquer caso.

## Configuração

Sobreponha qualquer campo na camada **Profile**
(`$DSH_HOME/profiles/<nome>/cordis.patch.yml`), **Home**
(`$DSH_HOME/cordis.patch.yml`) ou **CLI overlay** (`dsh --patch ./o.yml`). A
resolução é de **entrada inteira** (`whole-entry replace`), nunca *deep-merge*:
aponte sempre ao id do próprio plugin.

| Campo | Tipo | Predefinição | Função |
| --- | --- | --- | --- |
| `apiKeys` | `string[]` | `[]` | Agrupamento de credenciais (round-robin). Vazio = *keyless-only*. |
| `searchDepth` | `ultra-fast\|fast\|basic\|advanced` | `basic` | Profundidade predefinida quando o modelo não escolhe. |
| `maxResults` | `1..100` (clamp a 10) | `5` | Máximo de fontes qualificadas. |
| `includeAnswer` | `boolean` | `true` | Injeta a resposta preliminar sumarizada. |
| `timeoutMs` | `250..300000` | `15000` | Timeout **por tentativa** HTTP. |
| `callTimeoutMs` | `≥ timeoutMs` | `120000` | Orçamento cooperativo total da chamada (todas as rotações). |
| `projectId` | `string` | — | Segregação por projeto (`X-Project-ID`). |
| `admin.enabled` | `boolean` | `true` | Painel de gestão de chaves via interface. |
| `admin.trustedRemotes` | `string[]` | loopback | Origens de soquete admitidas no painel. |
| `admin.allowedHosts` | `string[]` | `127.0.0.1`, `localhost`, `::1` | Nomes de `Host` admitidos (anti DNS-rebinding). |
| `admin.stateDir` | `string` | `$DSH_HOME/dsh-tavily-resilient-search` | Diretório de estado (0700). |
| `admin.allowPublicBind` | `boolean` | `false` | Opt-out explícito da recusa de bind não-loopback. |
| `securityProfile` | `{sandbox, approval}` | **obrigatório** | Atestação do perfil de instalação (ver [Segurança](#segurança)). |

Exemplo (camada Bundle, já incluído no pacote):

```yaml
- insert:
    - id: dsh-tavily-resilient-search
      name: 'dsh-tavily-resilient-search'
      config:
        searchDepth: 'basic'
        maxResults: 5
        includeAnswer: true
        timeoutMs: 15000
        callTimeoutMs: 120000
        securityProfile:
          sandbox: 'workspace-write'
          approval: 'ask'
        apiKeys: !!js >
          (() => { try { return [process.env.TAVILY_API_KEY_A, process.env.TAVILY_API_KEY_B, process.env.TAVILY_API_KEY_C, process.env.TAVILY_API_KEY_D].filter(Boolean) } catch { return [] } })()
```

Regras medidas do manifesto (`@deepseek-ai/dsh` 0.1.x-rc): a ordem das linhas não
carrega semântica de carga (a ativação é dirigida por `inject`) e **um `!!js` que
lança na carga impede o boot do DSH para todos os instaladores** — a expressão
acima é defensiva e devolve `[]` em falha.

## Ferramenta exposta: `web_search`

| Parâmetro | Tipo | Obrig. | Descrição |
| --- | --- | --- | --- |
| `query` | `string` | sim | Termos objetivos (recomendado < 1500 caracteres; limite duro 4000). |
| `search_depth` | enum | não | `ultra-fast`/`fast` (< 800 ms) · `basic` · `advanced` (só documentação complexa). |
| `max_results` | `integer` | não | 1 a 10 (predefinição 5). |
| `topic` | enum | não | `general` \| `news`. |

Resultado canónico (forma total, `null` explícito quando não aplicável):
`ok`, `query`, `answer`, `sources[]` (`title`, `url`, `snippet`, `score`),
`responseTime`, `resultsTruncated`, `keylessFallbackUsed`, `error`, `detail`,
`suggestion`. A projeção para o modelo inclui sempre um **aviso de
não-confiança** sobre o conteúdo web (contenção de injeção indireta).

## Comportamento por código HTTP

| HTTP | Condição | Comportamento do plugin |
| --- | --- | --- |
| 200 | Sucesso | Descodifica, normaliza, aplica teto de 50 KB, devolve resultados. |
| 400 | Parâmetros malformados | **Não rotaciona** — devolve erro + sugestão de correção. |
| 401 | Chave inválida/revogada | Banida em definitivo (`REVOKED`) e avança já para a próxima. |
| 403 | Domínio/rota interdita | **Não rotaciona** — informa impossibilidade de acesso. |
| 429 | Limite de taxa | Lê `Retry-After` (segundos ou data HTTP), arrefece a chave e rotaciona. |
| 432 | Cota mensal esgotada | Suspende até à meia-noite UTC do mês seguinte e rotaciona. |
| 433 | Teto PAYGO atingido | Igual a 432 (suspensão temporizada). |
| 5xx | Instabilidade transiente | Nova tentativa com a alternativa; estado da chave não muda. |

### Máquina de estados do agrupamento

```
                ┌──────────────┐  401   ┌──────────┐
      ┌────────►│    ACTIVE    │───────►│ REVOKED  │ (definitivo)
      │         └──────┬───────┘        └──────────┘
      │  cooldown      │ 429
      │  expirado      ▼
┌─────┴────────┐  ┌──────────────┐
│ (round-robin)│◄─│ RATE_LIMITED │  T = Retry-After ou min(Tmax, T0·2^k) + δ
└──────────────┘  └──────────────┘
      ▲
      │ reposição mensal (1.º dia, UTC)
┌─────┴───────────┐
│ QUOTA_EXHAUSTED │  432/433 → suspensa até à meia-noite UTC do mês seguinte
└─────────────────┘
```

`T₀ = 500 ms`, `T_max = 60 s`, jitter `δ ∈ [0, 500) ms` contra ressaturação em
bloco. A recuperação é *lazy* (sem timers): a expiração é aplicada na seleção
seguinte, o que mantém leituras puras e o event loop limpo.

## Segurança

Resumo (completo em [docs/seguranca.md](docs/seguranca.md)):

- **A conjugação `sandbox: danger-full-access` + `approval: never` é recusada no
  load** (fail-loud, irrecuperável de propósito). O `securityProfile` é uma
  atestação obrigatória do operador — configuração ausente também falha alto.
- **Canário de segredos por valor**: material de credencial é redigido de todo o
  texto de saída e registos (um corpo de resposta malicioso que ecoasse a chave
  do `Authorization` nunca a propaga); identificação em logs apenas por máscara
  `…últimos4`.
- **Teto volumétrico de 50 KB** por invocação: documentos-bomba não saturam a
  janela de contexto (`include_raw_content` nunca é enviado).
- **Conteúdo web é dado não-confiável**: a projeção do modelo carrega aviso
  permanente contra injeção indireta de instruções.

| Sandbox \ Approval | `ask` | `never` |
| --- | --- | --- |
| `workspace-write` | Prudencial (padrão) | Automação controlada |
| `danger-full-access` | Alargado vigiado | **PROIBIDO — recusa de carga** |

## API validada por medição (nunca por prosa)

A superfície usada foi lida dos `.d.ts` dentro dos tarballs npm publicados
(sha256 registado em `types/`; reverificado por `pnpm run check:upstream`) e é
travada por um **contract test** que falha se a API pública divergir. Factos
medidos que corrigem documentação circulante:

| Afirmação morta | Comportamento real medido |
| --- | --- |
| `inject: ['tools', 'logger']` | `logger` **não** é Service do Cordis: a fiber ficaria `PENDING` para sempre. Usa-se `ctx.logger(nome)`; `inject` = `['tools']`. |
| `dsh.bundle: {}` ativa o plugin | Só `dsh.bundle.patch` ativa (medido em `@deepseek-ai/dsh` 0.1.0-rc.7+). |
| `required: false` nos parâmetros | O DSL marca obrigatoriedade com `required?: true` — opcional = **omitir** a chave. |
| `output: { schema: { type: 'object' } }` | Objetos exigem `additionalProperties: boolean` explícito. |
| `ctx.httpServer` / `spawn(cmd, args)` | `ctx.webServer` / `ctx.subprocess.spawn(spec)` (verificados na gama 0.1.x-rc). |

Linhas suportadas: `@deepseek-ai/dsh-tools` `^0.1.1-rc.1 || ^0.1.7-rc.1` (o
drift entre ambas é apenas aditivo) e `@deepseek-ai/cordis` `~4.0.4`. Nota: o
dist-tag `latest` dos subpacotes `dsh-*` aponta para a publicação mais antiga —
a linha viva é `next`.

## Desenvolvimento

```bash
pnpm install
pnpm run gate          # lint + typecheck + build + test + check:tarball
pnpm run check:upstream # reverifica tarballs/sha256 pela rede (Q-1)
```

Testes em quatro camadas (`node:test` + `tsx`, determinísticos — relógio e RNG
injetados, sem sleeps):

| Camada | Prova |
| --- | --- |
| `test/unit` | núcleo puro: máquina de estados, teto de bytes, validação fail-loud, token/nonce/lockout, persistência 0600 + auditoria à prova de symlink |
| `test/integration` | rotação atómica sobre um double de transporte e o router do painel sobre servidor HTTP real (porta 0) |
| `test/adversarial` | tenta brechar: canário de segredos, documento-bomba, injeção indireta, perfil YOLO, regressão P-09, boot-safety, CSRF/rebinding byte-idêntico, força bruta sem oráculo, nonce, recusa de bind público |
| `test/contract` | os espelhos `types/` correspondem verbatim aos `.d.ts` publicados |

## Empacotamento e publicação

Publica-se **pré-compilado** (`dist/`), sem scripts de build na instalação do
consumidor (risgo de cadeia de suprimentos). `files` é uma allowlist: `dist/`,
`cordis.patch.yml`, `README.md`, `LICENSE`, `CHANGELOG.md`. O gate de release é
`pnpm run gate && publint && attw --pack . && node scripts/check-tarball.mjs`
(este último inspeciona o tarball real). Notas de versão via
[changesets](https://github.com/changesets/changesets); em `0.x`, um **minor** é
breaking. Releases em CI usam *trusted publishing* (OIDC) — configurar uma vez
no console do npm para este repositório.

## Licença

[MIT](LICENSE)
