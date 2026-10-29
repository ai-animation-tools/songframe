/** Общие подписи попыток для производства и подтверждения сохранённого запроса. */
export const ATTEMPT_LABELS: Record<string, string> = {
  prepared: 'попытка подготовлена',
  submitting: 'отправляется',
  submission_unknown: 'исход отправки неизвестен',
  submitted: 'отправлено',
  running: 'генерируется',
  watermark_free_pending: 'ждём версию без логотипа',
  outputs_pending: 'ждём результаты',
  download_pending: 'ждём скачивания',
  downloading: 'скачивается',
  downloaded: 'скачано',
  failed: 'сервис сообщил об ошибке'
};

const INPUT_ROLES: Record<string, string> = {
  first: 'Первый кадр',
  middle: 'Промежуточный кадр',
  last: 'Последний кадр',
  reference: 'Референс',
  audio: 'Аудио',
  video: 'Видео'
};

const INPUT_SLOTS: Record<string, string> = {
  first_image: 'Первый кадр',
  tail_image: 'Последний кадр',
  image: 'Изображение',
  audio: 'Аудио',
  video: 'Видео'
};

const NUMBERED_INPUT_SLOTS: Record<string, string> = { ...INPUT_SLOTS, keyframe: 'Ключевой кадр' };

/** Роль опоры понятнее пользователю, а номер сохраняет различие между входами одного вида. */
export function productionInputLabel(input: { slot?: string; role?: string }): string {
  const role = input.role ? INPUT_ROLES[input.role] : undefined;
  const numbered = /^(image|video|audio|keyframe|tail_image)_(\d+)$/.exec(input.slot ?? '');
  const slot = numbered ? `${NUMBERED_INPUT_SLOTS[numbered[1]]} ${numbered[2]}` : input.slot ? (INPUT_SLOTS[input.slot] ?? input.slot) : undefined;
  return role ? `${role}${slot && slot !== role ? ` (${slot})` : ''}` : (slot ?? input.role ?? 'Входной материал');
}

/** Пакет подготовлен по прежней постановке плана: общий текст для проблемы пакета и её показа в интерфейсе. */
export const SCENE_CHANGED =
  'Постановка или унаследованное состояние плана изменились после подготовки пакета: описание, опоры и промпт могут не соответствовать сценарию.';
