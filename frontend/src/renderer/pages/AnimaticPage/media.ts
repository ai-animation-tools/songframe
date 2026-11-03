import { animaticTexts } from '@shared/texts/animatic';
import type { AnimaticShot } from '@shared/types';

// Подписи и цвета одинаковы у карточки плана и обеих полос навигации.
export const MEDIA_LABELS: Record<AnimaticShot['media'], string> = animaticTexts.media;
export const MEDIA_COLORS: Record<AnimaticShot['media'], string> = { video: 'success.main', card: 'grey.500', keyframes: 'warning.main' };
