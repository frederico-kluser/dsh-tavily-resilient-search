# Segurança

Dar capacidades de navegação web a um agente de software expande a superfície
de ataque da estação de trabalho. Este documento trata o modelo de ameaças, o
que é **imposto tecnicamente**, o que é **atestado pelo operador**, e o que um
sandbox **não** protege.

## 1. Modelo de ameaças

| # | Ameaça | Vetor | Contenção |
| --- | --- | --- | --- |
| T-1 | **Injeção indireta de instruções** | Páginas com diretivas ocultas ("exfiltra o `.env`", "corre `rm -rf`") entram via `snippet`/`answer` | Aviso permanente de não-confiança na projeção do modelo; conteúdo confinado a campos de dado; perfil de execução proibido em modo YOLO |
| T-2 | **Exfiltração de credenciais** | Corpo de resposta malicioso ecoa a chave recebida no `Authorization`; logs imprudentes | Redação **por valor** de todo o material de chave em saída e registos (`[REDACTED]`); identificação apenas por máscara `…últimos4` |
| T-3 | **Exaustão de contexto** | Documento-bomba (MB de texto) satura a janela de inferência | Teto forçado de **50 KB** de texto por invocação, com truncagem em limites de ponto de código UTF-8; `include_raw_content` nunca enviado |
| T-4 | **Ejeção do agent loop** | Exceções não tratadas em HTTP/rede | Todo o desfecho transitório vira conclusão estruturada VÁLIDA da ferramenta; a única exceção é o cancelamento legítimo (`exec.signal`) |
| T-5 | **Roubo do segredo em disco/repo** | Chaves em manifesto ou em texto simples | Chaves só via variáveis de ambiente; o `!!js` do manifesto nunca escreve valores |
| T-6 | **Replay/confused deputy** | Reexecução de ações por artefactos capturados | Sem superfície de controlo remoto neste plugin; ferramenta é só leitura (pesquisa) |

## 2. Perfil de execução: sandbox × approval

Os eixos de **isolamento de recursos** (sandbox) e **validação humana**
(approval) são independentes:

| Sandbox \ Approval | `ask` | `never` |
| --- | --- | --- |
| `workspace-write` | Prudencial (padrão): escrita só na pasta de trabalho; comandos externos pedem validação | Automação controlada |
| `danger-full-access` | Alargado vigiado: cada execução de terminal exige consentimento | **PROIBIDO** |

**Imposto pelo plugin:** a conjugação `danger-full-access + approval: never` faz
`apply()` lançar no load — a ferramenta nunca chega a registar-se. Um conteúdo
web envenenado que induza chamadas de terminal maliciosas ficaria sem caminho de
execução não escrutinado. A recusa é irrecuperável de propósito (explicit >
implicit): não há flag para a contornar.

**Atestado pelo operador:** `securityProfile` é obrigatório e descreve a
instalação real. É uma atestação — o plugin não consegue inspecionar de forma
verificável o modo global do host a partir do seu contrato de injeção; por isso
falha **alto** perante configuração ausente ou insegura em vez de assumir o
melhor caso. Configurar `securityProfile` com valores diferentes da realidade é
má-fé do operador, não falha do plugin.

## 3. Controles de implementação

- **Redação por valor (canário de segredos)** — `redactSecrets` remove qualquer
  ocorrência de material de credencial de todos os campos de texto do valor
  canónico e de todas as linhas de log dinâmicas. Teste adversarial A-1 injeta
  um eco de chave num corpo de resposta e prova a ausência por valor.
- **Máscara de identificação** — logs referem credenciais como `…c2e9`
  (últimos 4). Prefixos são material de segredo e não entram em registos.
- **Teto volumétrico** — `MAX_RESULT_TEXT_BYTES = 50·1024`, orçamento
  partilhado por `answer` + `snippets`, truncagem sem divisão de code points
  (sem U+FFFD, sem surrogate órfã). Teste A-2 com documento-bomba de ~4,5 MB.
- **Validação fail-loud** — enum desconhecido, limites inválidos ou perfil
  proibido lançam no `apply()`. Nunca *fallback* silencioso para defaults
  permissivos.
- **Cancelamento cooperativo** — `exec.signal` é encaminhado para cada `fetch`
  (união com o timeout por tentativa); o descarte é LIFO via `ctx.effect`.
- **Sem estado persistido** — as credenciais vivem só em memória volátil da
  sessão; nada é escrito em disco por este plugin.

## 4. O que um sandbox NÃO protege

Um sandbox DSH (`workspace-write` via `bwrap`) é uma **cerca espacial**, não uma
fronteira de autenticação:

- existe documentação pública de **escape do `bwrap`** por remontagem do
  filesystem (`mount -o remount,rw /` dentro do namespace);
- o próprio plano de controlo já foi demonstrado vulnerável a **RCE** com
  injeção de permissões (`/permission danger-full-access`).

Conclusão operacional: nunca tratar "está em sandbox" como "nada mais me atinge".
A segurança real é defesa em profundidade — perfil de execução prudente
(`workspace-write` + `ask`), redação de segredos, tetos de contexto, e revisão
humana das ações destrutivas.

## 5. Suíte adversarial

`test/adversarial/security.test.ts` tenta ativamente brechar as defesas:

| Teste | Prova |
| --- | --- |
| A-1 | canário de segredos por valor: logs e saída nunca contêm material de chave |
| A-2 | documento-bomba colapsa dentro do teto de 50 KB |
| A-3 | texto hostil permanece dado canónico (JSON estrito) + aviso de não-confiança presente |
| A-4 | perfil YOLO → *throw* no load, zero registos |
| A-5 | guarda de regressão P-09: `inject` nunca contém `logger` |
| A-6 | boot-safety: sem chaves degrada (não rebenta); config inválida falha alto |

A suíte adversarial é a **prova** de segurança; a cobertura de linhas não é.
