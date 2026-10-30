/** Пользовательские ошибки локальных файлов и каталога состояния без зависимости от Node.js. */
export const localFilesTexts = {
  main: {
    objectExpected: 'ожидался JSON-объект',
    readFailed: ({ path, reason }: { path: string; reason: string }) =>
      `Не удалось прочитать ${path}: ${reason}. Файл сохранён; исправьте его или перенесите в резервную папку.`,
    writeFailed: ({ path, reason }: { path: string; reason: string }) => `Не удалось сохранить ${path}: ${reason}. Проверьте доступ на запись к папке.`,
    storageUnavailable: ({ path, reason }: { path: string; reason: string }) => `Не удалось подготовить локальное состояние (${path}): ${reason}`
  }
} as const;
