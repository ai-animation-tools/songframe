/** Кнопка-иконка без текста: назначение всегда в подсказке, у выключенной по условию — ещё и причина. */
import type { ReactElement } from 'react';
import { IconButton, Tooltip, type IconButtonProps } from '@mui/material';
import { buttonHint } from './buttonHint';
import { DisabledHint } from './DisabledHint';

export type ActionIconButtonProps = Omit<IconButtonProps, 'aria-label' | 'title'> & {
  /** Доступное имя обязательно: у иконки нет видимого текста. */
  'aria-label': string;
  /** Назначение в подсказке, если оно длиннее доступного имени; по умолчанию — aria-label. */
  title?: string;
  /** Что мешает действию и что сделать; показывается, только когда кнопка выключена (props.disabled). */
  disabledReason?: string | null;
};

export function ActionIconButton({ disabledReason, title, ...props }: ActionIconButtonProps): ReactElement {
  const reason = props.disabled ? (disabledReason ?? null) : null;
  const hint = buttonHint(title ?? props['aria-label'], reason) ?? props['aria-label'];
  const button = <IconButton {...props} />;
  return props.disabled ? (
    <DisabledHint hint={hint} focusable={!!reason}>
      {button}
    </DisabledHint>
  ) : (
    <Tooltip title={hint}>{button}</Tooltip>
  );
}
