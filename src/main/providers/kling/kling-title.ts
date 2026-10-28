/** Название сервиса в сообщениях берётся из реестра провайдеров. */
import { MEDIA_PROVIDERS } from '@shared/media-providers';

export const KLING_ID = 'kling';
export const KLING_TITLE = MEDIA_PROVIDERS[KLING_ID].title;
