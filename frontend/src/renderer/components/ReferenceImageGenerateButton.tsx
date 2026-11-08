import type { ReactElement } from 'react';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { sourcesTexts } from '@shared/texts/sources';
import { mediaProviderInfo } from '@shared/media-providers';
import { aiActionProblem } from '@shared/ai-access';
import { useApp } from '../state';
import { ActionButton } from './ActionButton';
import { AgentButton } from './AgentButton';

/** Знак исполнителя показывается только агентному провайдеру; прямой запрос имеет обычную кнопку. */
export function ReferenceImageGenerateButton({ onClick, disabledReason }: { onClick: () => void; disabledReason?: string | null }): ReactElement {
  const { aiAccess } = useApp();
  const executor = mediaProviderInfo(aiAccess?.image.provider, 'image')?.executor;
  const problem = aiActionProblem(aiAccess, 'image');
  return executor ? (
    <AgentButton aiKind="image" provider={executor} onClick={onClick} disabled={!!disabledReason} disabledReason={disabledReason}>
      {sourcesTexts.generateReferenceImage}
    </AgentButton>
  ) : (
    <ActionButton startIcon={<AutoAwesomeIcon />} onClick={onClick} disabled={!!(disabledReason || problem)} disabledReason={disabledReason ?? problem}>
      {sourcesTexts.generateReferenceImage}
    </ActionButton>
  );
}
