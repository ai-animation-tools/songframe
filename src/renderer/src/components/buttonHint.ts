/** Подсказка кнопки при наведении: назначение и, для недоступной кнопки, причина с подсказкой, что сделать. */

/** Причины приходят и из главного процесса в разном виде: предложение с заглавной буквы и с точкой на конце. */
function sentence(text: string): string {
  const value = text.trim();
  if (!value) return value;
  const capital = value[0].toLocaleUpperCase('ru-RU') + value.slice(1);
  return /[.!?…»)]$/.test(capital) ? capital : `${capital}.`;
}

export function buttonHint(purpose: unknown, reason: string | null | undefined): string | undefined {
  const text = typeof purpose === 'string' && purpose.trim() ? purpose.trim().replace(/[.]$/, '') : null;
  if (!reason) return text ?? undefined;
  return text ? `${text}. Недоступно: ${sentence(reason)}` : sentence(reason);
}
