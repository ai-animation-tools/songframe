/** Пользовательская диагностика сбоев; формат служебных журналов и отчёта остаётся в main/diagnostics.ts. */
export const diagnosticsTexts = {
  crashTitle: 'SongFrame: ошибка программы',
  crashDetails: ({ details }: { details: string }) =>
    `${details}\n\nПодробности записаны в журнал сбоев. Отчёт для разработчика можно сохранить на странице «Журнал заданий».`
} as const;
