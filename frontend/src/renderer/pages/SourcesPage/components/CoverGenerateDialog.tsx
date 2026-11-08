import type { ReferenceImageOption } from '@shared/reference-image-generation';
import type { ReactElement } from 'react';
import { ImageGenerateDialog } from '../../../components/ImageGenerateDialog';

/** Обложка генерируется общим диалогом изображений: тот же порядок генерации и квадратное кадрирование. */
export function CoverGenerateDialog(props: {
  project: string;
  idea: string;
  referenceInput: { images: ReferenceImageOption[] };
  onAccepted: (result: { id: string; path: string }) => void;
  onClose: () => void;
}): ReactElement {
  return <ImageGenerateDialog {...props} />;
}
