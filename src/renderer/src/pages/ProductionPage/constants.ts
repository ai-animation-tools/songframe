import type { ShotProduction } from '@shared/types';

export const VERDICT_LABELS: Record<string, { label: string; color: 'primary' | 'warning' | 'success' | 'inherit' | 'error' }> = {
  approve: { label: 'Принять', color: 'success' },
  revise: { label: 'Вернуть с замечанием', color: 'warning' },
  send: { label: 'Отправить', color: 'primary' },
  park: { label: 'Сохранить в очередь', color: 'inherit' },
  accept: { label: 'Принять', color: 'success' },
  retry: { label: 'Исправить', color: 'warning' },
  review: { label: 'Собрать пробу', color: 'inherit' }
};
export const STATE_LABELS: Record<ShotProduction['state'], { label: string; color: 'default' | 'warning' | 'success' | 'error' }> = {
  planned: { label: 'не начат', color: 'default' },
  progress: { label: 'в работе', color: 'warning' },
  completed: { label: 'принят', color: 'success' },
  unknown: { label: 'проблема', color: 'error' }
};

export type ProductionFilter = 'all' | 'progress' | 'planned' | 'completed';

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
