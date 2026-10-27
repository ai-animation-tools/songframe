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
        ? `Предпочтительная модель ${selection.preferredModel} заменена на ${selection.selectedModel}. `
        : `Выбрана модель ${selection.selectedModel}. `}
      {selection.reason}
    </Alert>
  );
}
