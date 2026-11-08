/** Обычная кнопка действия: выключенная по условию кнопка объясняет причину в подсказке, а не текстом рядом. */
import type { ReactElement } from 'react';
import { Button, type ButtonProps } from '@mui/material';
import { buttonHint } from './buttonHint';
import { DisabledHint } from './DisabledHint';

export type ActionButtonProps = ButtonProps & {
  /** Что мешает действию и что сделать; показывается в подсказке, только когда кнопка выключена (props.disabled). */
  disabledReason?: string | null;
};

export function ActionButton({ disabledReason, ...props }: ActionButtonProps): ReactElement {
  const reason = props.disabled ? (disabledReason ?? null) : null;
  // title — назначение кнопки; у выключенной к нему добавляется причина.
  const hint = buttonHint(props.title, reason);
  const button = <Button {...props} title={hint} />;
  return reason && hint ? (
    <DisabledHint hint={hint} fullWidth={props.fullWidth}>
      {button}
    </DisabledHint>
  ) : (
    button
  );
}
