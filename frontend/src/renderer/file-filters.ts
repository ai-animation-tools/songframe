/** Одинаковые ограничения типов файлов для диалога и перетаскивания. */
import { commonTexts } from '@shared/texts/common';
import { technicalTexts } from '@shared/texts/technical';
export const IMAGE_FILTER = [{ name: commonTexts.files.images, extensions: ['png', 'jpg', 'jpeg', 'webp'] }];
export const TEXT_FILTER = [{ name: commonTexts.files.text, extensions: ['md', 'txt'] }];
export const AUDIO_FILTER = [{ name: technicalTexts.files.mp3, extensions: ['mp3'] }];
