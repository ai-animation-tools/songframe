import AddIcon from '@mui/icons-material/Add';
import BuildIcon from '@mui/icons-material/Build';
/** Исполнитель опор определяется настройкой изображений; подготовка платного запроса ещё не разрешает отправку. */
import type { ReactElement } from 'react';
import { Alert, Button, Stack } from '@mui/material';
import { MEDIA_PROVIDERS, mediaProviderInfo, mediaProvidersFor } from '@shared/media-providers';
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
  const info = mediaProviderInfo(provider, 'image');
  // Знак на кнопке — программа-исполнитель провайдера, а не выбранный текстовый агент.
  if (info?.executor)
    return (
      <AgentButton aiKind="image" provider={info.executor} disabled={disabled} onClick={onGenerate}>
        Создать опоры в {info.title}
      </AgentButton>
    );
  if (info?.paid)
    return (
      <AiButton aiKind="image" startIcon={<BuildIcon />} variant="outlined" disabled={disabled} onClick={onGenerate}>
        Подготовить запрос изображения ({info.title})
      </AiButton>
    );
  const titles = mediaProvidersFor('image').map((id) => MEDIA_PROVIDERS[id].title);
  const choices = titles.length > 1 ? `${titles.slice(0, -1).join(', ')} или ${titles.at(-1)}` : (titles[0] ?? 'провайдера');
  const problem = provider ? `Провайдер изображений «${provider}» не поддерживается.` : 'Провайдер изображений не задан.';
  return (
    <Stack spacing={1} sx={{ minWidth: 0 }}>
      <Button startIcon={<AddIcon />} color="success" variant="outlined" disabled>
        Создать опоры
      </Button>
      <Alert severity="warning">{`${problem} Выберите ${choices} в настройках проекта.`}</Alert>
    </Stack>
  );
}
