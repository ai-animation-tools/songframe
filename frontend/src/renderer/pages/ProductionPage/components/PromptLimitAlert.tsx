import { productionTexts } from '@shared/texts/production';
/** Видеопромпт длиннее предела провайдера: заметная ошибка над согласованием, утвердить его нельзя. */
import type { ReactElement } from 'react';
import { Alert, AlertTitle } from '@mui/material';
import { mediaProviderTitle } from '@shared/media-providers';
import type { PromptOverLimit } from '../promptLimit';

export function PromptLimitAlert({ over, videoProvider }: { over: PromptOverLimit; videoProvider?: string | null }): ReactElement {
  return (
    <Alert severity="error" data-testid="prompt-limit">
      <AlertTitle>{productionTexts.promptLimit.title}</AlertTitle>
      {productionTexts.promptLimit.description({ ...over, provider: mediaProviderTitle(videoProvider) })}
    </Alert>
  );
}
