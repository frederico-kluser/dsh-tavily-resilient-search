/**
 * Salvaguardas volumétricas de contexto.
 *
 * Conteúdo recuperado da rede é DADO NÃO-CONFIÁVEL e pode ser um documento-bomba
 * destinado a saturar a janela de inferência. Impõe-se um teto nominal de 50 KB
 * de texto por invocação, com truncagem que nunca divide pontos de código UTF-8.
 */

/** Teto nominal de texto devolvido por invocação: 50 KB. */
export const MAX_RESULT_TEXT_BYTES = 50 * 1024

const encoder = new TextEncoder()

/** Número de bytes UTF-8 de `text`. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length
}

/**
 * Trunca `text` para caber em `budgetBytes` bytes UTF-8, cortando num limite de
 * ponto de código (nunca a meio de um code point).
 */
export function truncateToBudget(text: string, budgetBytes: number): { text: string; truncated: boolean } {
  if (budgetBytes <= 0) return { text: '', truncated: text.length > 0 }
  if (utf8Bytes(text) <= budgetBytes) return { text, truncated: false }

  // `text` tem, no máximo, tantos bytes como caracteres; a procura binária sobre
  // limites de caracteres converge em O(log n) medições de byteLength.
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (utf8Bytes(text.slice(0, mid)) <= budgetBytes) low = mid
    else high = mid - 1
  }

  let cut = text.slice(0, low)
  // Nunca deixar uma surrogate alta órfã (par de code point dividido).
  if (cut.length > 0) {
    const last = cut.charCodeAt(cut.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  }
  return { text: cut, truncated: true }
}

/**
 * Aplica um orçamento PARTILHADO por várias partes de texto, pela ordem dada
 * (a resposta sumarizada primeiro, depois os snippets). Devolve as partes já
 * truncadas e se houve qualquer truncagem.
 */
export function applySharedBudget(
  parts: readonly string[],
  budgetBytes: number = MAX_RESULT_TEXT_BYTES,
): { parts: string[]; truncated: boolean } {
  let remaining = budgetBytes
  let truncated = false
  const out: string[] = []

  for (const part of parts) {
    const result = truncateToBudget(part, remaining)
    remaining -= utf8Bytes(result.text)
    if (result.truncated) truncated = true
    out.push(result.text)
  }

  return { parts: out, truncated }
}
