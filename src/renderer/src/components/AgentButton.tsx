/** Единое обозначение действий агента; явный значок не заменяет глобальный выбор и проверку доступности. */
import type { ReactElement } from 'react';
import { Button, Tooltip, type ButtonProps } from '@mui/material';
import { agentTitle, type AgentProvider } from '@shared/agent-providers';
import { aiActionProblem, type AiActionKind } from '@shared/ai-access';
import { useApp } from '../state';
import { AgentIcon } from './AgentIcon';

type Props = Omit<ButtonProps, 'startIcon'> & {
  provider?: AgentProvider | null;
  aiKind?: AiActionKind;
  /** Только диагностика профиля в настройках: проверяет явный выбор формы до сохранения и установки CLI. */
  setup?: boolean;
};

export function AgentButton({ provider, aiKind = 'agent', setup = false, ...props }: Props): ReactElement {
  const { agentProvider, aiAccess } = useApp();
  const selected = provider === undefined ? agentProvider : provider;
  const reason = setup
    ? selected
      ? null
      : 'Выберите агента в форме настроек.'
    : !agentProvider
      ? 'Сначала выберите агента в настройках приложения.'
      : aiActionProblem(aiAccess, aiKind);
  const disabled = props.disabled || !!reason;
  const title = agentTitle(selected);
  const button = (
    <Button
      {...props}
      disabled={disabled}
      title={reason ?? props.title ?? title}
      startIcon={<AgentIcon provider={selected} monochrome={props.variant === 'contained' || disabled} />}
    />
  );
  // Disabled-кнопка не получает события мыши и фокус; обёртка сохраняет подсказку также с клавиатуры.
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
