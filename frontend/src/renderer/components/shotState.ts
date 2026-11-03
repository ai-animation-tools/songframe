import { componentsTexts } from '@shared/texts/components';
import type { ShotProductionState } from '@shared/types';

/**
 * Подписи, цвета чипов и полосы карточек состояний плана: одни и те же на страницах «Сценарий», «Сцены» и «Производство».
 * stale отличается от «проблемы»: комплект цел, но принят по прежней постановке и ждёт нового производства.
 */
export const SHOT_STATE_LABELS: Record<ShotProductionState, { label: string; color: 'default' | 'warning' | 'success' | 'error' | 'info'; bar: string }> = {
  planned: { label: componentsTexts.shot.states.planned, color: 'default', bar: 'grey.400' },
  progress: { label: componentsTexts.shot.states.progress, color: 'warning', bar: 'warning.main' },
  completed: { label: componentsTexts.shot.states.completed, color: 'success', bar: 'success.main' },
  stale: { label: componentsTexts.shot.states.stale, color: 'info', bar: 'info.main' },
  unknown: { label: componentsTexts.shot.states.unknown, color: 'error', bar: 'error.main' }
};

const VIDEO_EXTENSION = /\.(?:mp4|webm|mov|m4v|ogv|ogg|avi|mkv)$/i;

/** Среди загрузок пакета видео отличается расширением; изображения и прочие файлы не подходят для предпросмотра. */
export function isVideoPath(path: string): boolean {
  return VIDEO_EXTENSION.test(path);
}
