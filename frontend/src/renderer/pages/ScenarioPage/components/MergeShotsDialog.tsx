import { scenarioTexts } from '@shared/texts/scenario';
import { useState, type ReactElement } from 'react';
import { Alert, MenuItem, Stack, TextField, Typography } from '@mui/material';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import type { ScenesFile } from '@shared/types';
import { formatClock } from '../../../format';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

/**
 * Подтверждение объединения плана с одним или несколькими следующими. Выбор ограничен подряд идущими непринятыми
 * планами: принятый план менять нельзя. Окно показывает итоговое окно, исчезающие коды и предупреждения о длине
 * больше предела одного запроса видео (maxSeconds) и о смешении частей песни; решение остаётся за пользователем.
 */
export function MergeShotsDialog({
  open,
  scenes,
  shotIndex,
  acceptedShots,
  maxSeconds,
  onClose,
  onConfirm
}: {
  open: boolean;
  scenes: ScenesFile;
  shotIndex: number;
  acceptedShots: readonly string[];
  /** Предел одного запроса видео у провайдера проекта, секунды; null — не проверяется. */
  maxSeconds: number | null;
  onClose(): void;
  /** count — сколько следующих планов войдёт в объединённый. */
  onConfirm(count: number): void;
}): ReactElement {
  const [count, setCount] = useState(1);
  const shot = scenes.scenes[shotIndex];
  const following: string[] = [];
  let stop: string | null = null;
  for (const next of scenes.scenes.slice(shotIndex + 1)) {
    if (acceptedShots.includes(next.id)) {
      stop = next.id;
      break;
    }
    following.push(next.id);
  }
  const chosen = Math.min(Math.max(count, 1), Math.max(following.length, 1));
  const group = scenes.scenes.slice(shotIndex, shotIndex + chosen + 1);
  const last = group[group.length - 1];
  const seconds = (frames: number): string => (frames / scenes.fps).toFixed(1);
  const length = (last.end_frame_exclusive - shot.start_frame) / scenes.fps;
  const parts = [...new Set(group.map((item) => item.sequence))];
  const partTitle = (id: string): string => scenes.sequences.find((sequence) => sequence.id === id)?.title || id;
  return (
    <ConfirmationDialog
      open={open}
      title={scenarioTexts.shot.mergeTitle({ shot: shot.id })}
      onClose={onClose}
      onConfirm={() => onConfirm(chosen)}
      confirmLabel={scenarioTexts.shot.mergeConfirm}
      confirmIcon={<CallMergeIcon />}
      confirmColor="warning"
    >
      <Stack spacing={1.5} sx={{ pt: 1 }}>
        <TextField
          select
          size="small"
          label={scenarioTexts.shot.mergeUntil}
          value={chosen}
          onChange={(event) => setCount(Number(event.target.value))}
          helperText={stop ? scenarioTexts.shot.mergeAcceptedStop({ shot: stop }) : undefined}
        >
          {following.map((id, index) => (
            <MenuItem key={id} value={index + 1}>
              {scenarioTexts.shot.mergeOption({ id, seconds: seconds(scenes.scenes[shotIndex + index + 1].end_frame_exclusive - shot.start_frame) })}
            </MenuItem>
          ))}
        </TextField>
        <Typography variant="body2">
          {scenarioTexts.shot.mergeSummary({
            shot: shot.id,
            removed: group
              .slice(1)
              .map((item) => item.id)
              .join(', '),
            start: formatClock(shot.start_frame / scenes.fps),
            end: formatClock(last.end_frame_exclusive / scenes.fps),
            seconds: length.toFixed(1)
          })}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {scenarioTexts.shot.mergeTexts}
        </Typography>
        {maxSeconds !== null && length > maxSeconds + 1e-6 ? (
          <Alert severity="warning">{scenarioTexts.shot.mergeTooLong({ seconds: length.toFixed(1), max: maxSeconds })}</Alert>
        ) : null}
        {parts.length > 1 ? <Alert severity="warning">{scenarioTexts.shot.mergeParts({ parts: parts.map(partTitle).join(', ') })}</Alert> : null}
      </Stack>
    </ConfirmationDialog>
  );
}
