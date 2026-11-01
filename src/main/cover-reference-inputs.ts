/** Проверка закреплённых копий опор перед передачей исполнителю; исходники объекта здесь не меняются. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { GenerationReferenceImage } from '@shared/cover-generation';
import { referenceGenerationMessages } from '@shared/texts/reference-images';
import { imageExtensionMatches, isImageFile } from './keyframe-images';

export function checkedCoverReferences(references: readonly GenerationReferenceImage[] = []): GenerationReferenceImage[] {
  return references.map((image) => {
    try {
      if (!lstatSync(image.path).isFile() || !isImageFile(image.path) || !imageExtensionMatches(image.path))
        throw new Error(referenceGenerationMessages.referenceInputsInvalid);
      const bytes = readFileSync(image.path);
      if (bytes.length !== image.bytes || createHash('sha256').update(bytes).digest('hex') !== image.sha256)
        throw new Error(referenceGenerationMessages.referenceInputsChanged);
      return { ...image };
    } catch (error) {
      if (error instanceof Error && error.message === referenceGenerationMessages.referenceInputsChanged) throw error;
      throw new Error(referenceGenerationMessages.referenceInputsInvalid, { cause: error });
    }
  });
}
