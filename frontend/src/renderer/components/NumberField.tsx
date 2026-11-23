import { useEffect, useState, type ReactElement } from 'react';
import { TextField, type SxProps, type Theme } from '@mui/material';

/**
 * Числовое поле с собственной строкой ввода: промежуточные «-» и «1.» не сбрасываются, число уходит наверх,
 * когда строка разбирается. optional — пустая строка означает «нет значения». Границы допустимых значений
 * проверяет владелец данных (Go при сохранении); min, max и step — подсказка стрелкам поля. Число вне
 * min…max поле подсвечивает ошибкой и наверх не отдаёт: владелец остаётся с последним допустимым значением.
 */
export function NumberField({
  label,
  value,
  onChange,
  optional = false,
  helperText,
  min,
  max,
  step = 0.1,
  disabled,
  sx
}: {
  label: string;
  value: number | undefined;
  onChange(value: number | undefined): void;
  optional?: boolean;
  helperText?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  sx?: SxProps<Theme>;
}): ReactElement {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    setText((current) => (Number(current) === value && current !== '' ? current : value === undefined ? '' : String(value)));
  }, [value]);
  const typed = text.trim() === '' ? undefined : Number(text);
  const outside = typed !== undefined && Number.isFinite(typed) && ((min !== undefined && typed < min) || (max !== undefined && typed > max));
  return (
    <TextField
      size="small"
      type="number"
      label={label}
      value={text}
      helperText={helperText}
      error={outside}
      disabled={disabled}
      fullWidth
      sx={sx}
      slotProps={{ htmlInput: { step, min, max } }}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (next.trim() === '') {
          if (optional) onChange(undefined);
          return;
        }
        const number = Number(next);
        if (!Number.isFinite(number)) return;
        if ((min !== undefined && number < min) || (max !== undefined && number > max)) return;
        onChange(number);
      }}
    />
  );
}
