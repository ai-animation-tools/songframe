/** Единое обозначение действий агента; без явного provider используется сохранённый глобальный выбор. */
import type { ReactElement } from 'react';
import { Button, type ButtonProps } from '@mui/material';
import type { AgentSettings } from '@shared/agents';
import { useApp } from '../state';
import { AgentIcon } from './AgentIcon';

type Props = Omit<ButtonProps, 'startIcon'> & { provider?: AgentSettings['provider'] | null };

export function AgentButton({ provider, ...props }: Props): ReactElement {
  const { agentProvider } = useApp();
  const selected = provider === undefined ? agentProvider : provider;
  const title = selected === 'claude' ? 'Claude Code' : selected === 'codex' ? 'Codex' : 'Claude Code или Codex';
  return (
    <Button
      {...props}
      title={props.title ?? title}
      startIcon={<AgentIcon provider={selected} monochrome={props.variant === 'contained' || props.disabled} />}
    />
  );
}
