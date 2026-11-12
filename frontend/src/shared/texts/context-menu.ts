/** Подписи контекстного меню полей ввода и выделенного текста; клавиши — подсказка, не отдельное действие. */
export const contextMenuTexts = {
  label: 'Действия с текстом',
  cut: 'Вырезать',
  copy: 'Копировать',
  paste: 'Вставить',
  selectAll: 'Выделить всё',
  searchGoogle: 'Искать в Google',
  cutKeys: 'Ctrl+X',
  copyKeys: 'Ctrl+C',
  pasteKeys: 'Ctrl+V',
  selectAllKeys: 'Ctrl+A',
  pasteFailed: ({ reason }: { reason: string }) => `Не удалось вставить из буфера обмена: ${reason}`,
  copyFailed: ({ reason }: { reason: string }) => `Не удалось скопировать в буфер обмена: ${reason}`,
  searchFailed: ({ reason }: { reason: string }) => `Не удалось открыть поиск в браузере: ${reason}`
};
