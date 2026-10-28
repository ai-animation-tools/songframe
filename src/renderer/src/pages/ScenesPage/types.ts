import type { ShotProductionState } from '@shared/types';

export { SHOT_STATE_LABELS as STATE_LABELS } from '../../components/shotState';
export const MEDIA_LABELS = { video: 'анимация', card: 'карточка', keyframes: 'опоры' };
export type Filter = 'all' | ShotProductionState;
