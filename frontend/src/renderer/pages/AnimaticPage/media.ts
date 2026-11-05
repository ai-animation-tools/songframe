import { animaticTexts } from '@shared/texts/animatic';
import type { AnimaticShot } from '@shared/types';

// Подписи и цвета одинаковы у карточки плана и обеих полос навигации.
export const MEDIA_LABELS: Record<AnimaticShot['media'], string> = animaticTexts.media;
export const MEDIA_COLORS: Record<AnimaticShot['media'], string> = { video: 'success.main', card: 'grey.500', keyframes: 'warning.main' };
// Текст на цветной метке плана: contrastText палитры темы, а на сером фоне карточки — чёрный.
// Отличие от 634fd94: там текст был белым всегда, и в тёмной теме и на сером фоне контраст был ниже 4.5:1.
export const MEDIA_TEXT_COLORS: Record<AnimaticShot['media'], string> = {
  video: 'success.contrastText',
  card: 'common.black',
  keyframes: 'warning.contrastText'
};
