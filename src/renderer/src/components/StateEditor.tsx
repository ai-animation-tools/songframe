/** Поля отдельного состояния выбираются из каталога; выбор пустого поля не меняет документ. */
import { componentsTexts } from '@shared/texts/components';
import { type ReactElement, useRef, useState } from 'react';
import { Autocomplete, Box, MenuItem, TextField, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ClearIcon from '@mui/icons-material/Clear';
import UndoIcon from '@mui/icons-material/Undo';
import type { CastProperty } from '@shared/types';
import { ActionIconButton } from './ActionIconButton';
import { DestructiveButton } from './DestructiveButton';
import { patchStateField, stateFieldRows } from './stateFields';

interface Props {
  properties: CastProperty[];
  /** null снимает свойство со сцены; отсутствие ключа сохраняет наследование. */
  value: Record<string, string | null>;
  onChange(next: Record<string, string | null>): void;
  baseline?: Record<string, string>;
  allowRemove?: boolean;
  compact?: boolean;
  /** Новый сохранённый снимок очищает только незаполненный локальный выбор, не текущие значения документа. */
  resetKey?: object | null;
}

export function StateEditor({ properties, value, onChange, baseline = {}, allowRemove = false, compact = false, resetKey }: Props): ReactElement {
  const texts = componentsTexts.stateEditor;
  const [customKey, setCustomKey] = useState('');
  const [propertyKey, setPropertyKey] = useState('');
  const [drafts, setDrafts] = useState<string[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState(resetKey);
  if (savedSnapshot !== resetKey) {
    setSavedSnapshot(resetKey);
    setDrafts([]);
    setCustomKey('');
    setPropertyKey('');
  }

  const customRef = useRef<HTMLInputElement | null>(null);
  const focusKey = useRef<string | null>(null);
  const rows = stateFieldRows(properties, value, baseline, drafts);
  const known = new Set(properties.map((property) => property.key));
  const active = new Set(rows.map((row) => row.key));
  const available = properties.filter((property) => !active.has(property.key));
  const selectedProperty = available.some((property) => property.key === propertyKey) ? propertyKey : '';
  const customProblem = !customKey
    ? texts.enterKey
    : !/^[a-z][a-z0-9_]*$/.test(customKey)
      ? texts.invalidKey
      : active.has(customKey)
        ? texts.duplicateKey
        : known.has(customKey)
          ? texts.useDictionary
          : null;
  const selectField = (key: string): void => {
    setDrafts((current) => [...new Set([...current, key])]);
    focusKey.current = key;
  };
  const set = (key: string, next: string | null | undefined): void => {
    // Очистка оставляет пустое поле в локальном черновике, пока пользователь явно не уберёт его.
    setDrafts((current) => [...new Set([...current, key])]);
    onChange(patchStateField(value, key, next));
  };
  const remove = (key: string): void => {
    setDrafts((current) => current.filter((item) => item !== key));
    onChange(patchStateField(value, key, undefined));
    requestAnimationFrame(() => customRef.current?.focus());
  };
  return (
    <Box
      sx={{ display: 'grid', gridTemplateColumns: compact ? 'minmax(0, 1fr)' : { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1, minWidth: 0 }}
    >
      {rows.map((row) => {
        const current = value[row.key];
        const inherited = baseline[row.key];
        const removed = current === null;
        const own = Object.hasOwn(value, row.key);
        return (
          <Box
            key={row.key}
            sx={{ display: 'grid', gridTemplateColumns: `minmax(0, 1fr) ${allowRemove ? 68 : 34}px`, gap: 0.5, alignItems: 'start', minWidth: 0 }}
          >
            <Autocomplete
              freeSolo
              fullWidth
              size="small"
              sx={{ minWidth: 0 }}
              options={row.values ?? []}
              value={removed ? '' : (current ?? '')}
              inputValue={removed ? '' : (current ?? '')}
              // Выбор готового варианта приходит через onChange, а reset текста при перерисовке не создаёт правку.
              onChange={(_event, text) => set(row.key, text ?? '')}
              onInputChange={(_event, text, reason) => {
                if (reason === 'reset') return;
                set(row.key, text);
              }}
              disabled={removed}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={row.label}
                  inputRef={(element: HTMLInputElement | null) => {
                    if (element && focusKey.current === row.key) {
                      element.focus();
                      focusKey.current = null;
                    }
                  }}
                  placeholder={removed ? texts.removed : (inherited ?? row.hint)}
                  helperText={removed ? texts.willRemove : inherited !== undefined && current === undefined ? texts.inherited({ value: inherited }) : undefined}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
              )}
            />
            <Box sx={{ display: 'flex', mt: 0.5, minWidth: 0 }}>
              {removed ? (
                <ActionIconButton size="small" aria-label={texts.restoreProperty({ label: row.label })} title={texts.restore} onClick={() => remove(row.key)}>
                  <UndoIcon fontSize="small" />
                </ActionIconButton>
              ) : (
                <>
                  {allowRemove && own ? (
                    <DestructiveButton
                      descriptionSeverity="warning"
                      icon
                      label={texts.undoProperty({ label: row.label })}
                      description={texts.undoDescription}
                      confirmLabel={texts.undo}
                      onConfirm={() => remove(row.key)}
                    >
                      <UndoIcon fontSize="small" />
                    </DestructiveButton>
                  ) : null}
                  {allowRemove && (own || inherited !== undefined) ? (
                    <DestructiveButton
                      descriptionSeverity="warning"
                      icon
                      label={texts.removeProperty({ label: row.label })}
                      description={texts.removeDescription}
                      confirmLabel={texts.remove}
                      onConfirm={() => set(row.key, null)}
                    >
                      <ClearIcon fontSize="small" />
                    </DestructiveButton>
                  ) : (
                    <DestructiveButton
                      descriptionSeverity="warning"
                      icon
                      label={texts.removeLocalProperty({ label: row.label })}
                      description={texts.removeLocalDescription}
                      confirmLabel={texts.removeLocal}
                      onConfirm={() => remove(row.key)}
                    >
                      <ClearIcon fontSize="small" />
                    </DestructiveButton>
                  )}
                </>
              )}
            </Box>
          </Box>
        );
      })}
      {!rows.length && (
        <Typography variant="body2" color="text.secondary" sx={{ gridColumn: '1 / -1' }}>
          {properties.length ? texts.emptyState : texts.noDictionary}
        </Typography>
      )}
      {available.length > 0 && (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 34px', gap: 0.5, alignItems: 'start', minWidth: 0, gridColumn: '1 / -1' }}>
          <TextField select size="small" label={texts.dictionaryProperty} value={selectedProperty} onChange={(event) => setPropertyKey(event.target.value)}>
            {available.map((property) => (
              <MenuItem key={property.key} value={property.key}>
                {property.label}
              </MenuItem>
            ))}
          </TextField>
          <ActionIconButton
            size="small"
            color="success"
            aria-label={texts.addDictionaryProperty}
            disabled={!selectedProperty}
            disabledReason={texts.chooseDictionaryProperty}
            onClick={() => {
              selectField(selectedProperty);
              setPropertyKey('');
            }}
          >
            <AddIcon fontSize="small" />
          </ActionIconButton>
        </Box>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 34px', gap: 0.5, alignItems: 'start', minWidth: 0, gridColumn: '1 / -1' }}>
        <TextField
          size="small"
          label={texts.customKey}
          value={customKey}
          inputRef={customRef}
          onChange={(event) => setCustomKey(event.target.value)}
          placeholder={texts.customKeyExample}
          helperText={texts.customKeyHint}
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ minWidth: 0 }}
        />
        <ActionIconButton
          size="small"
          color="success"
          aria-label={texts.addCustomProperty}
          sx={{ mt: 0.5 }}
          disabled={!!customProblem}
          disabledReason={customProblem}
          onClick={() => {
            selectField(customKey);
            setCustomKey('');
          }}
        >
          <AddIcon fontSize="small" />
        </ActionIconButton>
      </Box>
    </Box>
  );
}
