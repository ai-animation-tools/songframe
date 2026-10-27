import AddIcon from '@mui/icons-material/Add';
import BuildIcon from '@mui/icons-material/Build';
/** Исполнитель опор определяется настройкой изображений; подготовка Kling ещё не разрешает платную отправку. */
import type { ReactElement } from 'react';
import { Alert, Button, Stack } from '@mui/material';
import { AiButton } from '../../../components/AiButton';
import { AgentButton } from '../../../components';

export function ProductionFrameGenerationButton({
  provider,
  disabled,
  onGenerate
}: {
  provider?: string;
  disabled: boolean;
  onGenerate(): void;
}): ReactElement {
  if (provider === 'codex')
    return (
      <AgentButton aiKind="image" provider="codex" disabled={disabled} onClick={onGenerate}>
        Создать опоры в Codex
      </AgentButton>
    );
  if (provider === 'kling')
    return (
      <AiButton aiKind="image" startIcon={<BuildIcon />} variant="outlined" disabled={disabled} onClick={onGenerate}>
        Подготовить запрос изображения (Kling)
      </AiButton>
    );
  return (
    <Stack spacing={1} sx={{ minWidth: 0 }}>
      <Button startIcon={<AddIcon />} color="success" variant="outlined" disabled>
        Создать опоры
      </Button>
      <Alert severity="warning">
        {provider ? `Провайдер изображений «${provider}» не поддерживается.` : 'Провайдер изображений не задан.'} Выберите Codex или Kling в настройках проекта.
      </Alert>
    </Stack>
  );
}
