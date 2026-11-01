/** Чтение опор не создаёт сессию и сохраняет порядок всех выбранных изображений. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { GenerationReferenceImage } from '@shared/cover-generation';
import type { ReferenceImageGenerationInput } from '@shared/reference-image-generation';
import { referenceGenerationMessages } from '@shared/texts/reference-images';
import { checkedCoverReferences } from './cover-reference-inputs';
import { imageDimensions, imageExtensionMatches } from './keyframe-images';

export function inspectReferenceImageInputs(input: ReferenceImageGenerationInput): GenerationReferenceImage[] {
  if (!input || typeof input !== 'object' || !Array.isArray(input.images)) throw new Error(referenceGenerationMessages.referenceInputsInvalid);
  const images = input.images.map((image) => {
    try {
      if (
        !image ||
        typeof image.path !== 'string' ||
        !isAbsolute(image.path) ||
        image.path.includes('\0') ||
        typeof image.label !== 'string' ||
        !image.label.trim() ||
        image.label.includes('\0') ||
        (image.sha256 !== undefined && (typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256)))
      )
        throw new Error(referenceGenerationMessages.referenceInputsInvalid);
      const bytes = readFileSync(image.path);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      // Видимые номера опор относятся к прочитанным байтам: изменение файла требует пересборки промпта.
      if (image.sha256 !== undefined && image.sha256 !== sha256) throw new Error(referenceGenerationMessages.referenceInputsChanged);
      if (!imageExtensionMatches(image.path) || !imageDimensions(image.path)) throw new Error(referenceGenerationMessages.referenceInputsInvalid);
      return { path: image.path, label: image.label.trim(), sha256, bytes: bytes.length };
    } catch (error) {
      if (error instanceof Error && error.message === referenceGenerationMessages.referenceInputsChanged) throw error;
      throw new Error(referenceGenerationMessages.referenceInputsInvalid, { cause: error });
    }
  });
  return checkedCoverReferences(images);
}

/** Сессия отправляет одни и те же байты один раз, объединяя только нейтральные подписи выбранных опор. */
export function referenceInputs(input?: ReferenceImageGenerationInput): GenerationReferenceImage[] {
  const images = new Map<string, GenerationReferenceImage>();
  for (const image of inspectReferenceImageInputs(input === undefined ? { images: [] } : input)) {
    const previous = images.get(image.sha256);
    if (previous) {
      if (!previous.label.split(' · ').includes(image.label)) previous.label += ` · ${image.label}`;
    } else images.set(image.sha256, image);
  }
  return [...images.values()];
}
