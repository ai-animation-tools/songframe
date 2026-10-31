import { commonTexts } from './common';

/** Общие сообщения диагностики и жизненного цикла агента; протокол CLI и промпты остаются в main. */
export const agentsTexts = {
  checkTimeout: 'Агент не ответил вовремя. Проверьте его запуск в терминале и повторите проверку.',
  checkOutputLimit: 'Агент превысил допустимый объём ответа. Проверьте его запуск в терминале.',
  checkLaunchFailed: 'Не удалось запустить агента. Проверьте права файла и наличие зависимостей, например Node.js для npm-установки.',
  checkConnectionFailed: 'Агент сообщил об ошибке соединения. Проверьте сеть и повторите проверку.',
  authorizationUnknown: 'Не удалось определить вход по ответу агента. Проверьте статус в терминале; может потребоваться обновление агента.',
  chooseAgent: commonTexts.agent.choose,
  invalidInput: 'Неверные параметры задания.',
  inputRequired: 'Укажите проект, задачу и промпт.',
  invalidInputSize: 'Неверный путь или слишком большой текст задания.',
  restartInterrupted: 'Приложение завершилось до получения результата. Автоматический повтор не выполнялся; для нового запуска подготовьте запрос заново.',
  invalidCandidateDirectory: 'Папка кандидатов не принадлежит заданиям изображений.',
  applicationStopping: commonTexts.runtime.applicationStopping,
  projectNotFound: commonTexts.project.notFound,
  projectManifestMissing: commonTexts.project.manifestMissing,
  projectBusy: 'Для этого проекта уже выполняется задание агента.',
  chooseAgentInSettings: 'Сначала выберите агента в настройках.',
  retryUnavailable: 'Исходное задание для повтора недоступно.',
  cancelled: 'Задание остановлено пользователем.',
  jobNotFound: 'Задание не найдено.',
  shutdownInterrupted: 'Задание остановлено при закрытии приложения. Автоматический повтор не выполнялся.',
  jobTimeout: 'Превышено время задания. Автоматический повтор не выполнялся.',
  jobOutputLimit: 'Агент превысил допустимый объём вывода.',
  completionMissing: 'Агент завершился без подтверждения результата.',
  resultTooLarge: 'Ответ агента слишком велик.',
  jobSaveFailed: 'Не удалось обработать или сохранить задание агента. Проверьте каталог состояния.',
  unsupportedWriteMode: 'Выбранный агент не поддерживает штатный режим создания кандидатов.',
  unsupportedVersion: 'Эта версия агента не поддерживает подтверждённый контракт запуска. Обновите агента или выберите совместимую версию.',
  lineTooLarge: 'Строка ответа агента слишком велика.',
  invalidJsonLines: 'Агент вернул некорректный JSONL.',
  eventObjectRequired: 'Ожидался объект события агента.',
  notFound: ({ provider, windows = false }: { provider: string; windows?: boolean }) =>
    `${provider} не найден в ${windows ? 'PATH, %USERPROFILE%\\.local\\bin и %APPDATA%\\npm' : 'PATH, ~/.local/bin, /usr/local/bin и /usr/bin'}. Установите его по официальной инструкции и повторите проверку.`,
  versionCheckFailed: ({ provider }: { provider: string }) => `Команда версии завершилась с ошибкой. Проверьте ${provider} и его зависимости в терминале.`,
  checkVersionUnknown: ({ provider }: { provider: string }) => `${provider} запускается, но его версия не распознана. Обновите его до поддерживаемой версии.`,
  versionUnknown: ({ provider }: { provider: string }) => `Версия ${provider} не распознана. Обновите его до поддерживаемой версии.`,
  launchFailed: ({ provider }: { provider: string }) => `Не удалось запустить ${provider}. Проверьте его установку и зависимости.`,
  login: ({ command }: { command: string }) => `Выполните ${command} в терминале.`,
  authorizationFailed: ({ reason }: { reason: string }) =>
    `Агент сообщил об ошибке входа. Проверьте авторизацию в настройках.${reason ? ` Сообщение агента: «${reason}»` : ''}`,
  rateLimited: ({ reason }: { reason: string }) =>
    `Агент сообщил об ограничении использования. Проверьте лимиты аккаунта.${reason ? ` Сообщение агента: «${reason}»` : ''}`,
  taskFailed: ({ reason }: { reason: string }) =>
    `Агент сообщил об ошибке задания. Проверьте его настройки и доступность выбранной модели.${reason ? ` Сообщение агента: «${reason}»` : ''}`,
  phase: {
    restartInterrupted: 'Прервано перезапуском',
    checking: commonTexts.agent.checking,
    working: 'Агент выполняет задачу',
    receiving: 'Получение ответа',
    reading: 'Чтение проекта'
  },
  status: {
    completed: commonTexts.job.completed,
    failed: commonTexts.job.error,
    cancelled: commonTexts.job.cancelled,
    interrupted: commonTexts.job.interrupted,
    running: commonTexts.job.running
  }
} as const;
