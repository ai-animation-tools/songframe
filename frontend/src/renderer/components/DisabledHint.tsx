/** Подсказка выключенной кнопки: disabled-кнопка не получает событий мыши и фокуса, поэтому подсказку держит обёртка. */
import type { ReactElement } from 'react';
import { Tooltip } from '@mui/material';

interface Props {
  hint: string;
  /** Обёртка получает фокус с клавиатуры, чтобы причину блокировки можно было узнать без мыши. */
  focusable?: boolean;
  fullWidth?: boolean;
  children: ReactElement;
}

export function DisabledHint({ hint, focusable = true, fullWidth = false, children }: Props): ReactElement {
  return (
    <Tooltip title={hint}>
      <span tabIndex={focusable ? 0 : undefined} style={fullWidth ? { display: 'flex', width: '100%' } : { display: 'inline-flex', maxWidth: '100%' }}>
        {children}
      </span>
    </Tooltip>
  );
}
