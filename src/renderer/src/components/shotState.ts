import type { ShotProductionState } from '@shared/types';

/**
 * Подписи, цвета чипов и полосы карточек состояний плана: одни и те же на страницах «Сценарий», «Сцены» и «Производство».
 * stale отличается от «проблемы»: комплект цел, но принят по прежней постановке и ждёт нового производства.
 */
export const SHOT_STATE_LABELS: Record<ShotProductionState, { label: string; color: 'default' | 'warning' | 'success' | 'error' | 'info'; bar: string }> = {
  planned: { label: 'не начат', color: 'default', bar: 'grey.400' },
  progress: { label: 'в работе', color: 'warning', bar: 'warning.main' },
  completed: { label: 'принят', color: 'success', bar: 'success.main' },
  stale: { label: 'постановка изменена', color: 'info', bar: 'info.main' },
  unknown: { label: 'проблема', color: 'error', bar: 'error.main' }
};

const VIDEO_EXTENSION = /\.(?:mp4|webm|mov|m4v|ogv|ogg|avi|mkv)$/i;

/** Среди загрузок пакета видео отличается расширением; изображения и прочие файлы не подходят для предпросмотра. */
export function isVideoPath(path: string): boolean {
  return VIDEO_EXTENSION.test(path);
}
