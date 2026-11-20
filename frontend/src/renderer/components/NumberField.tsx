import { useEffect, useState, type ReactElement } from 'react';
import { TextField, type SxProps, type Theme } from '@mui/material';

/**
 * Числовое поле с собственной строкой ввода: промежуточные «-» и «1.» не сбрасываются, число уходит наверх,
 * когда строка разбирается. optional — пустая строка означает «нет значения». Границы допустимых значений
 * проверяет владелец данных (Go при сохранении); min и step — только подсказка стрелкам поля.
 */
export function NumberField({
  label,
  value,
  onChange,
  optional = false,
  helperText,
  min,
  step = 0.1,
  sx
}: {
  label: string;
  value: number | undefined;
  onChange(value: number | undefined): void;
  optional?: boolean;
  helperText?: string;
  min?: number;
  step?: number;
  sx?: SxProps<Theme>;
}): ReactElement {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    setText((current) => (Number(current) === value && current !== '' ? current : value === undefined ? '' : String(value)));
  }, [value]);
  return (
    <TextField
      size="small"
      type="number"
      label={label}
      value={text}
      helperText={helperText}
      fullWidth
      sx={sx}
      slotProps={{ htmlInput: { step, min } }}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (next.trim() === '') {
          if (optional) onChange(undefined);
          return;
        }
        const number = Number(next);
        if (Number.isFinite(number)) onChange(number);
      }}
    />
  );
}
