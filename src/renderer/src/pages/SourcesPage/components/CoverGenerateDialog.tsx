import type { ReactElement } from 'react';
import { ImageGenerateDialog } from '../../../components/ImageGenerateDialog';

/** Обложка сохраняет прежний сценарий генерации и квадратного кадрирования. */
export function CoverGenerateDialog(props: {
  project: string;
  idea: string;
  onAccepted: (result: { id: string; path: string }) => void;
  onClose: () => void;
}): ReactElement {
  return <ImageGenerateDialog {...props} />;
}
