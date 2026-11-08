import { environmentTexts } from '@shared/texts/environment';
import type { ReactElement } from 'react';
import { SlottedText } from '../../../components/SlottedText';
import { Paper, Typography } from '@mui/material';
import type { AppState } from '@shared/types';

interface ApplicationResourcesProps {
  state: AppState | null;
}

/**
 * Ресурсы приложения. Шаблон, промпты и документы провайдеров встроены в бинарник Go,
 * поэтому страница сообщает о встроенных ресурсах и папке
 * локального состояния без выбора папки исходников.
 */
export function ApplicationResources({ state }: ApplicationResourcesProps): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        {environmentTexts.resourcesTitle}
      </Typography>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {state ? environmentTexts.resourcesEmbedded : environmentTexts.resourcesDetecting}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
        <SlottedText text={environmentTexts.localState} slots={{ path: state?.localDir }} />
      </Typography>
      {state?.packaged ? (
        <Typography variant="body2" color="text.secondary">
          {environmentTexts.packagedResources}
        </Typography>
      ) : null}
    </Paper>
  );
}
