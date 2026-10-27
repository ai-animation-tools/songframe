import type { ShotProductionState } from '@shared/types';

export const STATE_LABELS: Record<ShotProductionState, { label: string; color: 'default' | 'warning' | 'success' | 'error'; bar: string }> = {
  planned: { label: 'не начат', color: 'default', bar: 'grey.400' },
  progress: { label: 'в работе', color: 'warning', bar: 'warning.main' },
  completed: { label: 'принят', color: 'success', bar: 'success.main' },
  unknown: { label: 'проблема', color: 'error', bar: 'error.main' }
};
export const MEDIA_LABELS = { video: 'анимация', card: 'карточка', keyframes: 'опоры' };
export type Filter = 'all' | ShotProductionState;
