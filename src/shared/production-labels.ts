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

/** Роль опоры понятнее пользователю, а номер сохраняет различие между входами одного вида. */
export function productionInputLabel(input: { slot?: string; role?: string }): string {
  const role = input.role ? INPUT_ROLES[input.role] : undefined;
  const numbered = /^(image|video|audio)_(\d+)$/.exec(input.slot ?? '');
  const slot = numbered
    ? `${({ image: 'Изображение', video: 'Видео', audio: 'Аудио' } as Record<string, string>)[numbered[1]]} ${numbered[2]}`
    : input.slot === 'tail_image'
      ? 'Последний кадр'
      : input.slot;
  return role ? `${role}${slot ? ` (${slot})` : ''}` : (slot ?? input.role ?? 'Входной материал');
}
