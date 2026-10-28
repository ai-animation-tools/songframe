/** Исполнитель опор определяется настройкой изображений; подготовка платного запроса ещё не разрешает отправку. */
import AddPhotoAlternateOutlinedIcon from '@mui/icons-material/AddPhotoAlternateOutlined';
import BuildIcon from '@mui/icons-material/Build';
import type { ReactElement } from 'react';
import { MEDIA_PROVIDERS, mediaProviderInfo, mediaProvidersFor } from '@shared/media-providers';
import { AiButton } from '../../../components/AiButton';
import { AgentButton } from '../../../components';
import { ActionButton } from '../../../components/ActionButton';

export function ProductionFrameGenerationButton({
  provider,
  disabled,
  disabledReason,
  title,
  onGenerate
}: {
  provider?: string;
  disabled: boolean;
  disabledReason?: string | null;
  /** Назначение кнопки для подсказки при наведении. */
  title?: string;
  onGenerate(): void;
}): ReactElement {
  const info = mediaProviderInfo(provider, 'image');
  // Знак на кнопке — программа-исполнитель провайдера, а не выбранный текстовый агент.
  // Все варианты — текстовые кнопки, как соседние «Подготовить описание» и «Продолжить подготовку» в ряду панели.
  if (info?.executor)
    return (
      <AgentButton aiKind="image" provider={info.executor} disabled={disabled} disabledReason={disabledReason} title={title} onClick={onGenerate}>
        Создать опоры в {info.title}
      </AgentButton>
    );
  if (info?.paid)
    return (
      <AiButton aiKind="image" startIcon={<BuildIcon />} disabled={disabled} disabledReason={disabledReason} title={title} onClick={onGenerate}>
        Подготовить запрос изображения ({info.title})
      </AiButton>
    );
  const titles = mediaProvidersFor('image').map((id) => MEDIA_PROVIDERS[id].title);
  const choices = titles.length > 1 ? `${titles.slice(0, -1).join(', ')} или ${titles.at(-1)}` : (titles[0] ?? 'провайдера');
  const problem = provider ? `Провайдер изображений «${provider}» не поддерживается.` : 'Провайдер изображений не задан.';
  return (
    <ActionButton
      startIcon={<AddPhotoAlternateOutlinedIcon />}
      title={title}
      disabled
      disabledReason={`${problem} Выберите ${choices} в настройках проекта.`}
      sx={{ alignSelf: 'start' }}
    >
      Создать опоры
    </ActionButton>
  );
}
