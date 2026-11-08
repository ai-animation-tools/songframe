/** Общая обвязка названий провайдеров; конкретные сведения принадлежат реестрам. */
export const providerTexts = {
  authCheckFailed: (title: string) => `Не удалось проверить вход в ${title}. Проверьте соединение и повторите проверку.`,
  loginIncomplete: (title: string) => `Вход в ${title} не завершён. Подтвердите вход в браузере и повторите при необходимости.`,
  loginCancelled: (title: string) => `Вход в ${title} отменён.`,
  bundledClient: 'Клиент SongFrame входит в поставку',
  alternativeSeparator: ' или ',
  generationProvider: 'провайдер генерации'
} as const;
