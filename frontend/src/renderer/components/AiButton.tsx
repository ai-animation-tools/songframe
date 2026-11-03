/** Прямые AI-действия сохраняют предметный значок и общий запрет до выбора доступных исполнителей. */
import type { ReactElement } from 'react';
import type { AiActionKind } from '@shared/ai-access';
import { useAiActionProblem } from '../hooks/useAiActionProblem';
import { ActionButton, type ActionButtonProps } from './ActionButton';

type Props = ActionButtonProps & {
  aiKind: AiActionKind;
};

export function AiButton({ aiKind, disabledReason, ...props }: Props): ReactElement {
  const reason = useAiActionProblem(aiKind) ?? (props.disabled ? (disabledReason ?? null) : null);
  return <ActionButton {...props} disabled={props.disabled || !!reason} disabledReason={reason} />;
}
