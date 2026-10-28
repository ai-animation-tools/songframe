/** Прямые AI-действия сохраняют предметный значок и общий запрет до выбора доступных исполнителей. */
import type { ReactElement } from 'react';
import { Button, Tooltip, type ButtonProps } from '@mui/material';
import { aiActionProblem, type AiActionKind } from '@shared/ai-access';
import { useApp } from '../state';

type Props = ButtonProps & { aiKind: AiActionKind };

export function AiButton({ aiKind, ...props }: Props): ReactElement {
  const { agentProvider, aiAccess } = useApp();
  const reason = aiKind === 'agent' && !agentProvider ? 'Сначала выберите агента в настройках приложения.' : aiActionProblem(aiAccess, aiKind);
  const button = <Button {...props} disabled={props.disabled || !!reason} title={reason ?? props.title} />;
  return reason ? (
    <Tooltip title={reason}>
      <span tabIndex={0} style={{ display: 'inline-flex', maxWidth: '100%' }}>
        {button}
      </span>
    </Tooltip>
  ) : (
    button
  );
}
