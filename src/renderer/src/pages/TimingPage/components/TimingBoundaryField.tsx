import { useState, type ReactElement } from 'react';
import { TextField } from '@mui/material';

/** Незаконченный числовой ввод не меняет область на волне; граница применяется после проверки. */
export function TimingBoundaryField({
  value,
  min,
  max,
  label,
  onCommit
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onCommit(value: number): void;
}): ReactElement {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState('');
  const commit = (): void => {
    const next = Number(text);
    if (!text.trim() || !Number.isFinite(next) || next < min || next > max) {
      setError(`От ${min.toFixed(2)}${Number.isFinite(max) ? ` до ${max.toFixed(2)}` : ''} с. Граница не изменена.`);
      setText(String(value));
      return;
    }
    setError('');
    if (next !== value) onCommit(next);
  };
  return (
    <TextField
      type="number"
      value={text}
      variant="standard"
      error={!!error}
      helperText={error}
      inputProps={{ 'aria-label': label, step: 0.05, min, max: Number.isFinite(max) ? max : undefined, style: { fontFamily: 'monospace' } }}
      onChange={(event) => {
        setText(event.target.value);
        setError('');
      }}
      onClick={(event) => event.stopPropagation()}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.querySelector('input')?.blur();
        }
      }}
    />
  );
}
