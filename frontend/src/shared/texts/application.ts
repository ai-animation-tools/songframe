/**
 * Сообщения Go-сервисов, которые renderer показывает как есть. Строки провайдеров медиа и обложки
 * сверяют Go-тесты providers и covergen (TestTextsMatchFrontend); остальные используются историями
 * и тестами ссылок.
 */
export const applicationTexts = {
  imageAgentUnsupported: 'Выбранный провайдер изображений не рисует опоры программой-агентом.',
  imageExecutorMissing: 'Нет исполнителя опор для программы-агента этого задания.',
  paidExecutorMissing: 'Для провайдера не подключён исполнитель платного запроса.',
  coverCropFailed: 'Не удалось вырезать выбранную область обложки.',
  mediaKindUnknown: 'Неизвестный вид медиа.',
  providerUnsupported: 'Провайдер не поддерживается. Сохранённое значение оставлено без изменений.',
  scenarioReviewRequired: 'Кастинг, трактовка или исходники изменились: проверьте и утвердите актуальный сценарий на странице «Сценарий».',
  lyricsInvalid: ({ problems }: { problems: readonly string[] }) => `Исправьте текст песни на странице «Исходники»: ${problems.join(' ')}`
} as const;
