import type { ReactElement, ReactNode } from 'react';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { mediaProviderInfo } from '@shared/media-providers';
import { aiActionProblem } from '@shared/ai-access';
import { useApp } from '../state';
import { ActionButton } from './ActionButton';
import { AgentButton } from './AgentButton';

interface Props {
  children: ReactNode;
  onClick: () => void;
  /** Назначение кнопки в подсказке; у выключенной к нему добавляется причина. */
  title?: string;
  /** Собственная причина блокировки места вызова (например, несохранённая карточка). */
  disabledReason?: string | null;
}

/**
 * Кнопка генерации изображения провайдером изображений проекта (референс, обложка). Исполнителя
 * называет реестр провайдеров: у агентного провайдера — знак его исполнителя, а не выбранного
 * текстового агента; прямой запрос без исполнителя — обычная кнопка. Блокировка по настройкам
 * изображений общая для обоих видов.
 */
export function ImageGenerateButton({ children, onClick, title, disabledReason }: Props): ReactElement {
  const { aiAccess } = useApp();
  const executor = mediaProviderInfo(aiAccess?.image.provider, 'image')?.executor;
  const problem = aiActionProblem(aiAccess, 'image');
  return executor ? (
    <AgentButton aiKind="image" provider={executor} onClick={onClick} title={title} disabled={!!disabledReason} disabledReason={disabledReason}>
      {children}
    </AgentButton>
  ) : (
    <ActionButton
      startIcon={<AutoAwesomeIcon />}
      onClick={onClick}
      title={title}
      disabled={!!(disabledReason || problem)}
      disabledReason={disabledReason ?? problem}
    >
      {children}
    </ActionButton>
  );
}
