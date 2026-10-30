/** Единственная кнопка действий агента: знак всегда соответствует одному агенту, обычно сохранённому в настройках. */
import { componentsTexts } from '@shared/texts/components';
import type { ReactElement } from 'react';
import { Button, type ButtonProps } from '@mui/material';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { agentTitle, type AgentProvider } from '@shared/agent-providers';
import type { AiActionKind } from '@shared/ai-access';
import { useAiActionProblem } from '../hooks/useAiActionProblem';
import { buttonHint } from './buttonHint';
import { useApp } from '../state';
import { AgentIcon } from './AgentIcon';
import { DisabledHint } from './DisabledHint';

type Props = Omit<ButtonProps, 'startIcon'> & {
  /** Агент уже запущенного задания, формы настроек или программа-исполнитель провайдера медиа из реестра; иначе — сохранённый агент. */
  provider?: AgentProvider;
  aiKind?: AiActionKind;
  /** Только диагностика профиля в настройках: проверяет явный выбор формы до сохранения и установки CLI. */
  setup?: boolean;
  /** Причина собственной блокировки действия (props.disabled), чтобы выключенная кнопка объясняла, что сделать дальше. */
  disabledReason?: string | null;
};

export function AgentButton({ provider, aiKind = 'agent', setup = false, disabledReason, ...props }: Props): ReactElement {
  const { agentProvider } = useApp();
  const problem = useAiActionProblem(aiKind);
  const selected = provider ?? (setup ? undefined : (agentProvider ?? undefined));
  const ownReason = props.disabled ? (disabledReason ?? null) : null;
  const reason = setup ? (selected ? ownReason : componentsTexts.agent.chooseInSettings) : (problem ?? ownReason);
  const disabled = props.disabled || !!reason;
  // Подсказка при наведении: назначение кнопки и, если она недоступна, причина — вместо отдельных сводок рядом с кнопками.
  const hint = buttonHint(props.title, reason);
  const monochrome = props.variant === 'contained' || disabled;
  const button = (
    <Button
      {...props}
      disabled={disabled}
      title={hint ?? (selected ? agentTitle(selected) : componentsTexts.agent.notSelected)}
      // Без выбранного агента показываем нейтральный знак, а не оба логотипа.
      startIcon={selected ? <AgentIcon provider={selected} monochrome={monochrome} /> : <SmartToyOutlinedIcon />}
    />
  );
  return reason && hint ? (
    <DisabledHint hint={hint} fullWidth={props.fullWidth}>
      {button}
    </DisabledHint>
  ) : (
    button
  );
}
