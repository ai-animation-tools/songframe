/** textarea показывает CRLF и CR как LF; его индексы переводим обратно в исходную строку. */
function originalOffset(value: string, normalizedOffset: number): number {
  let offset = 0;
  for (let index = 0; index < normalizedOffset; index++) {
    if (value[offset] === '\r' && value[offset + 1] === '\n') offset++;
    offset++;
  }
  return offset;
}

/** Меняем только участок правки, сохраняя переводы строк нетронутых частей. Новые строки textarea приходят как LF. */
export function editInstructionText(previous: string, value: string): string {
  const normalized = previous.replace(/\r\n?/g, '\n');
  if (normalized === value) return previous;
  let prefix = 0;
  while (prefix < normalized.length && prefix < value.length && normalized[prefix] === value[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < normalized.length - prefix &&
    suffix < value.length - prefix &&
    normalized[normalized.length - suffix - 1] === value[value.length - suffix - 1]
  )
    suffix++;
  const before = previous.slice(0, originalOffset(previous, prefix));
  const after = value.slice(prefix, value.length - suffix) + previous.slice(originalOffset(previous, normalized.length - suffix));
  // Соседние одиночный CR и LF иначе сольются в один перенос при следующем отображении textarea.
  // Дополнительный LF завершает прежний CR и сохраняет отдельно вставленную или оставшуюся строку.
  return before + (before.endsWith('\r') && after.startsWith('\n') ? '\n' : '') + after;
}
