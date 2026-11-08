import { type ReactElement, useState } from 'react';
import { MenuItem, Stack, TextField } from '@mui/material';
import { derivedShotTexts as texts } from '@shared/texts/derived-shot';
import { startForTrimEnd, trimEndFrame, type DerivedRecipeDraft } from '../derivedRecipeForm';

/** Рецепт задаётся кадрами, чтобы округление секунд не меняло точные входы сборки. */
export function DerivedRecipeFields({
  draft,
  disabled,
  sourceFrames,
  targetFrames,
  onChange
}: {
  draft: DerivedRecipeDraft;
  disabled: boolean;
  sourceFrames: number;
  targetFrames: number;
  onChange(draft: DerivedRecipeDraft): void;
}): ReactElement {
  // Длину обрезки задаёт план, поэтому конец — другая запись начала. Пока число набирается, оно
  // может быть меньше длины плана: текст живёт в поле, а начало меняется только на допустимом значении.
  const [typedEnd, setTypedEnd] = useState<string | null>(null);
  const trimEnd = trimEndFrame(draft, targetFrames);
  const endRejected = typedEnd !== null && startForTrimEnd(typedEnd, targetFrames) === null;
  return (
    <Stack spacing={1.5}>
      <TextField
        select
        label={texts.mode}
        value={draft.mode}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, mode: event.target.value as DerivedRecipeDraft['mode'] })}
      >
        <MenuItem value="" disabled>
          {texts.chooseMode}
        </MenuItem>
        {Object.entries(texts.modes).map(([mode, label]) => (
          <MenuItem key={mode} value={mode}>
            {label}
          </MenuItem>
        ))}
      </TextField>
      {draft.mode === 'still' ? (
        <TextField
          type="number"
          label={texts.frame}
          value={draft.frame}
          disabled={disabled}
          helperText={texts.frameHint}
          slotProps={{ htmlInput: { min: 0, max: Math.max(0, sourceFrames - 1), step: 1 } }}
          onChange={(event) => onChange({ ...draft, frame: event.target.value })}
        />
      ) : draft.mode ? (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <TextField
            fullWidth
            type="number"
            label={texts.start}
            value={draft.start}
            disabled={disabled}
            helperText={texts.frameHint}
            slotProps={{ htmlInput: { min: 0, max: Math.max(0, sourceFrames - 1), step: 1 } }}
            onChange={(event) => onChange({ ...draft, start: event.target.value })}
          />
          {draft.mode === 'fit' || draft.mode === 'repeat' ? (
            <TextField
              fullWidth
              type="number"
              label={texts.end}
              value={draft.end}
              disabled={disabled}
              helperText={texts.intervalHint}
              slotProps={{ htmlInput: { min: 1, max: sourceFrames, step: 1 } }}
              onChange={(event) => onChange({ ...draft, end: event.target.value })}
            />
          ) : (
            <TextField
              fullWidth
              type="number"
              label={texts.end}
              value={typedEnd ?? trimEnd}
              disabled={disabled}
              error={endRejected}
              helperText={endRejected ? texts.trimEndTooEarly({ frames: targetFrames }) : texts.trimEndHint({ frames: targetFrames })}
              slotProps={{ htmlInput: { min: targetFrames, max: sourceFrames, step: 1 } }}
              onBlur={() => setTypedEnd(null)}
              onChange={(event) => {
                const start = startForTrimEnd(event.target.value, targetFrames);
                setTypedEnd(event.target.value);
                if (start !== null) onChange({ ...draft, start: String(start) });
              }}
            />
          )}
        </Stack>
      ) : null}
    </Stack>
  );
}
