/** Готовые тексты уведомлений; названия проверок также сохраняют нынешнюю классификацию заданий по заголовку. */
export const notificationsTexts = {
  reviewOperation: 'Проба',
  reviewCheckOperation: 'Проверка пробы',
  animaticOperation: 'Аниматик',
  animaticCheckTitle: 'Проверка входов аниматика',
  animaticInputsChecked: 'Входы аниматика проверены',
  reviewChecked: 'Проба проверена',
  // Согласование дословно повторяет прежний результат; редактура формулировок выполняется отдельно от переноса.
  operationReady: (operation: string): string => (operation === notificationsTexts.reviewOperation ? `${operation} готова` : `${operation} готов`),
  jobFailed: (title: string): string => `Ошибка: ${title}`,
  agentCompleted: (provider: string): string => `Ответ ${provider} готов`,
  agentFailed: (provider: string): string => `Ошибка ${provider}`,
  backgroundJobFailed: ({ title, error }: { title: string; error?: string }) =>
    `${title}: не выполнено.${error ? ` ${error}` : ''} Подробности — в журнале заданий.`,
  // Каждая ветвь содержит целую фразу: название страницы остаётся параметром навигации.
  backgroundAgentCompleted: ({ page }: { page: string }) => `Агент закончил работу: предложение готово к просмотру. Откройте страницу «${page}».`,
  backgroundAgentCancelled: ({ page }: { page: string }) => `Задание агента остановлено. Откройте страницу «${page}».`,
  backgroundAgentFailed: ({ page }: { page: string }) => `Задание агента не выполнено. Подробности — в журнале заданий. Откройте страницу «${page}».`,
  timingCompletedTitle: 'Черновик разметки готов',
  timingFailedTitle: 'Ошибка разметки',
  timingCompletedBody: 'Откройте разметку для проверки черновика.',
  timingFailedBody: 'Не удалось подготовить черновик разметки. Вернитесь на страницу «Тайминги».'
} as const;
