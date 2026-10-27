/** Редактор состояния одной сущности по словарю свойств: подписи, подсказки, типовые значения, свои ключи. */

import { type ReactElement, useState } from 'react';
import { Autocomplete, Box, IconButton, TextField, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ClearIcon from '@mui/icons-material/Clear';
import UndoIcon from '@mui/icons-material/Undo';
import type { CastProperty } from '@shared/types';
import { DestructiveButton } from './DestructiveButton';

interface Props {
  properties: CastProperty[];
  /** Текущие значения; null означает «снять свойство» (только в изменениях сцены). */
  value: Record<string, string | null>;
  onChange(next: Record<string, string | null>): void;
  /** Унаследованное значение: показывается как подсказка и не считается изменением. */
  baseline?: Record<string, string>;
  /** Разрешить значение null (удаление свойства из унаследованного состояния). */
  allowRemove?: boolean;
  compact?: boolean;
}

export function StateEditor({ properties, value, onChange, baseline = {}, allowRemove = false, compact = false }: Props): ReactElement {
  const [customKey, setCustomKey] = useState('');
  const known = new Set(properties.map((p) => p.key));
  const extraKeys = [...new Set([...Object.keys(value), ...Object.keys(baseline)])].filter((k) => !known.has(k));
  const rows: { key: string; label: string; hint?: string; values?: string[] }[] = [
    ...properties.map((p) => ({ key: p.key, label: p.label, hint: p.hint, values: p.values })),
    ...extraKeys.map((k) => ({ key: k, label: k.replace(/_/g, ' ') }))
  ];
  const set = (key: string, next: string | null | undefined): void => {
    const copy = { ...value };
    if (next === undefined || next === '') delete copy[key];
    else copy[key] = next;
    onChange(copy);
  };
  return (
    <Box
      sx={{ display: 'grid', gridTemplateColumns: compact ? 'minmax(0, 1fr)' : { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1, minWidth: 0 }}
    >
      {rows.map((row) => {
        const current = value[row.key];
        const inherited = baseline[row.key];
        const removed = current === null;
        return (
          <Box key={row.key} sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 34px', gap: 0.5, alignItems: 'start', minWidth: 0 }}>
            <Autocomplete
              freeSolo
              fullWidth
              size="small"
              sx={{ minWidth: 0 }}
              options={row.values ?? []}
              value={removed ? '' : (current ?? '')}
              inputValue={removed ? '' : (current ?? '')}
              onInputChange={(_e, text, reason) => {
                if (reason === 'reset' && !text) return;
                set(row.key, text);
              }}
              disabled={removed}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={row.label}
                  placeholder={removed ? 'снято' : inherited || row.hint}
                  helperText={!compact && inherited && current === undefined ? `унаследовано: ${inherited}` : removed ? 'свойство будет снято' : undefined}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
              )}
            />
            {/* Место действия сохраняется и без кнопки, чтобы все поля заканчивались на одной линии. */}
            <Box sx={{ minWidth: 0, mt: 0.5 }}>
              {allowRemove && (inherited || current !== undefined) ? (
                removed ? (
                  <Tooltip title="Вернуть унаследованное">
                    <IconButton size="small" aria-label={`Вернуть унаследованное свойство ${row.label}`} onClick={() => set(row.key, undefined)}>
                      <UndoIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                ) : (
                  <DestructiveButton
                    icon
                    label={`Снять свойство «${row.label}»`}
                    description="Свойство будет снято из состояния сущности в этой сцене, включая унаследованное значение."
                    confirmLabel="Снять"
                    onConfirm={() => set(row.key, null)}
                  >
                    <ClearIcon fontSize="small" />
                  </DestructiveButton>
                )
              ) : null}
            </Box>
          </Box>
        );
      })}
      {/* Добавление использует такую же колонку действий, как строки свойств. */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 34px', gap: 0.5, alignItems: 'start', minWidth: 0 }}>
        <TextField
          size="small"
          label="Своё свойство (код)"
          value={customKey}
          onChange={(e) => setCustomKey(e.target.value)}
          placeholder="helmet"
          sx={{ minWidth: 0 }}
        />
        <IconButton
          size="small"
          color="success"
          aria-label="Добавить своё свойство"
          title="Добавить своё свойство"
          sx={{ mt: 0.5 }}
          disabled={!/^[a-z][a-z0-9_]*$/.test(customKey) || customKey in value || known.has(customKey)}
          onClick={() => {
            set(customKey, ' ');
            setCustomKey('');
          }}
        >
          <AddIcon fontSize="small" />
        </IconButton>
      </Box>
      {!rows.length ? (
        <Typography variant="caption" color="text.secondary">
          У этого типа нет словаря свойств: добавьте свои ключи.
        </Typography>
      ) : null}
    </Box>
  );
}
