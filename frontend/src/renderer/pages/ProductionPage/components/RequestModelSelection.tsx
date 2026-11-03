import { productionTexts } from '@shared/texts/production';
/** Причина выбора читается из замороженного запроса, поэтому согласование объясняет именно отправляемую попытку. */
import type { ReactElement } from 'react';
import { Alert } from '@mui/material';
import type { MediaModelSelection } from '@shared/media-providers';

export function RequestModelSelection({ selection }: { selection?: MediaModelSelection }): ReactElement | null {
  if (!selection) return null;
  const replaced = selection.preferredModel !== null && selection.preferredModel !== selection.selectedModel;
  return (
    <Alert severity={replaced ? 'warning' : 'info'}>
      {replaced
        ? productionTexts.requestModelSelection.replaced({
            preferredModel: selection.preferredModel,
            selectedModel: selection.selectedModel,
            reason: selection.reason
          })
        : productionTexts.requestModelSelection.selected({ selectedModel: selection.selectedModel, reason: selection.reason })}
    </Alert>
  );
}
