---
'dsh-tavily-resilient-search': minor
---

Lançamento inicial: ferramenta `web_search` para o DeepSeek Harness via API
Tavily, com rotação atómica de um agrupamento de credenciais (429/432/433/401),
contingência keyless, teto volumétrico de 50 KB, redação de segredos por valor e
recusa fail-loud do perfil `danger-full-access + approval: never`.
