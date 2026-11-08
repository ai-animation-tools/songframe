import { timingTexts } from '@shared/texts/timing';
import { useEffect, useState, type ReactElement } from 'react';
import { TextField } from '@mui/material';

/** Ручной черновик хранит точную строку до сохранения, включая выход из ручного режима. */
export function TimingBoundaryField({
  value,
  min,
  max,
  label,
  onCommit,
  manualMode = false,
  draft,
  onDraftChange
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onCommit(value: number): void;
  manualMode?: boolean;
  draft?: string;
  onDraftChange?(text: string): void;
}): ReactElement {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState('');
  // Стабильный ключ сохраняет фокус; внешнее движение границы на волне обновляет только локальный числовой снимок.
  useEffect(() => {
    setText(String(value));
    setError('');
  }, [value]);
  // Выключение режима не превращает сохранённый сырой текст в number: браузер стёр бы нечисловой ввод.
  const keepRawDraft = manualMode || draft !== undefined;
  const rawValue = draft ?? (manualMode ? String(value) : text);
  const commit = (): void => {
    if (keepRawDraft) return;
    const next = Number(rawValue);
    if (!rawValue.trim() || !Number.isFinite(next) || next < min || next > max) {
      setError(timingTexts.invalidBoundary({ min, max }));
      setText(String(value));
      return;
    }
    setError('');
    if (next !== value) onCommit(next);
  };
  return (
    <TextField
      type={keepRawDraft ? 'text' : 'number'}
      value={rawValue}
      variant="standard"
      error={!keepRawDraft && !!error}
      helperText={keepRawDraft ? '' : error}
      inputProps={{
        'aria-label': label,
        ...(keepRawDraft ? { inputMode: 'decimal' } : { step: 0.05, min, max: Number.isFinite(max) ? max : undefined }),
        style: { fontFamily: 'monospace' }
      }}
      onChange={(event) => {
        const nextText = event.target.value;
        setText(nextText);
        setError('');
        // Обычный ввод без ручного черновика остаётся локальным и проверяется при commit.
        if (keepRawDraft) onDraftChange?.(nextText);
        // Полный ручной черновик передаётся через onDraftChange; простой родитель получает числовой снимок.
        if (manualMode && !onDraftChange) onCommit(nextText.trim() ? Number(nextText) : Number.NaN);
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
