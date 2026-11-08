import { scenesTexts } from '@shared/texts/scenes';
import type { ShotProductionState } from '@shared/types';

export { SHOT_STATE_LABELS as STATE_LABELS } from '../../components/shotState';
export const MEDIA_LABELS = scenesTexts.media;
export type Filter = 'all' | ShotProductionState;
