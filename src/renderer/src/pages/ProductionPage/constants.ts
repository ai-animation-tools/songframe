export const VERDICT_LABELS: Record<string, { label: string; color: 'primary' | 'warning' | 'success' | 'inherit' | 'error' }> = {
  approve: { label: 'Принять', color: 'success' },
  revise: { label: 'Вернуть с замечанием', color: 'warning' },
  send: { label: 'Отправить', color: 'primary' },
  park: { label: 'Сохранить в очередь', color: 'inherit' },
  accept: { label: 'Принять', color: 'success' },
  retry: { label: 'Повторить запрос', color: 'warning' },
  review: { label: 'Собрать пробу', color: 'inherit' }
};
/** Что произойдёт после ответа на вопрос пакета; показывается подсказкой у кнопки и списком под вопросом. */
export const VERDICT_HINTS: Record<string, string> = {
  approve: 'Подтверждает показанные материалы и открывает следующий этап.',
  revise: 'Сохраняет замечание для агента; доработку вы запускаете отдельно в блоке «Подготовка плана».',
  send: 'Открывает проверку стоимости и отдельное подтверждение платной отправки.',
  park: 'Сохраняет подготовленный запрос в очередь без отправки; вернуться к нему можно через «Очередь».',
  accept: 'Переносит результат в assets как принятый комплект сцены.',
  retry: 'Готовит новую попытку с теми же опорами и промптом; оплата подтверждается отдельно.',
  review: 'Открывает «Монтаж пробы» с соседними планами: выберите в материалах результат этой попытки. Вопрос остаётся открытым.'
};

export { SHOT_STATE_LABELS as STATE_LABELS } from '../../components/shotState';

export type ProductionFilter = 'all' | 'attention' | 'progress' | 'planned' | 'completed' | 'queued';

/** Подписи фильтра и пояснение пустого списка: одинаковое оформление для всех значений, как у очереди. */
export const FILTER_LABELS: Record<ProductionFilter, string> = {
  all: 'Все планы',
  attention: 'Ждут вашего действия',
  progress: 'В работе',
  planned: 'Не начатые',
  completed: 'Принятые',
  queued: 'Сохранённые в очередь'
};
export const FILTER_EMPTY_HINTS: Record<ProductionFilter, string> = {
  all: 'В реестре сцен нет планов. Создайте сценарий на странице «Сценарий».',
  attention:
    'Ни один пакет не ждёт вашего действия. Здесь появятся планы с открытым вопросом, подготовленным запросом, незапущенной доработкой или полученным результатом.',
  progress: 'Нет планов в работе. Они появятся после подготовки описания или повтора по сохранённому запросу.',
  planned: 'Нет не начатых планов: у каждого есть пакет или принятый комплект.',
  completed: 'Принятых планов ещё нет. Они появятся после приёмки результата в assets.',
  queued: 'Очередь пуста. Здесь появятся запросы после нажатия «Сохранить в очередь».'
};

/** Пользовательские названия этапов и состояний предложений; значения API сохраняются техническими. */
export const PRODUCTION_PASS_LABELS = { description: 'Описание', frames: 'Опорные кадры', prompt: 'Видеопромпт', request: 'Запрос' };
export const PRODUCTION_PROPOSAL_LABELS = {
  running: 'Агент готовит предложение',
  ready: 'Готово к просмотру',
  invalid: 'Результат требует исправления',
  failed: 'Задание завершилось с ошибкой',
  interrupted: 'Задание прервано',
  applied: 'Предложение применено'
};
