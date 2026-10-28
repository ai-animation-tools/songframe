/** Единственная кнопка действий агента: знак всегда соответствует одному агенту, обычно сохранённому в настройках. */
import type { ReactElement } from 'react';
import { Button, Tooltip, type ButtonProps } from '@mui/material';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { agentTitle, type AgentProvider } from '@shared/agent-providers';
import { aiActionProblem, type AiActionKind } from '@shared/ai-access';
import { useApp } from '../state';
import { AgentIcon } from './AgentIcon';

type Props = Omit<ButtonProps, 'startIcon'> & {
  /** Только агент уже запущенного задания или формы настроек; иначе используется сохранённый агент. */
  provider?: AgentProvider;
  aiKind?: AiActionKind;
  /** Только диагностика профиля в настройках: проверяет явный выбор формы до сохранения и установки CLI. */
  setup?: boolean;
  /** Действие продолжит внешний агент вне приложения: доступность CLI в приложении не требуется. */
  external?: boolean;
};

export function AgentButton({ provider, aiKind = 'agent', setup = false, external = false, ...props }: Props): ReactElement {
  const { agentProvider, aiAccess } = useApp();
  const selected = provider ?? (setup ? undefined : (agentProvider ?? undefined));
  const reason = setup
    ? selected
      ? null
      : 'Выберите агента в форме настроек.'
    : external
      ? null
      : !agentProvider
        ? 'Сначала выберите агента в настройках приложения.'
        : aiActionProblem(aiAccess, aiKind);
  const disabled = props.disabled || !!reason;
  const monochrome = props.variant === 'contained' || disabled;
  const button = (
    <Button
      {...props}
      disabled={disabled}
      title={reason ?? props.title ?? (selected ? agentTitle(selected) : 'Агент не выбран')}
      // Без выбранного агента показываем нейтральный знак, а не оба логотипа.
      startIcon={selected ? <AgentIcon provider={selected} monochrome={monochrome} /> : <SmartToyOutlinedIcon />}
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
