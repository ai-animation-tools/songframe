import { montageTexts } from '@shared/texts/montage';
import { ArrowBack, ArrowForward, DeleteOutline } from '@mui/icons-material';
import { memo, type ReactElement } from 'react';
import { Alert, Paper, Stack, TextField, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import type { MontageClip, MontageDraft } from '@shared/montage';
import { clipLength, frameLabel, rollCut, slipClip, trimClip } from '../model';

interface Props {
  draft: MontageDraft;
  clip: MontageClip | undefined;
  title?: string;
  onChange: (draft: MontageDraft) => void;
  onRequestRemove: () => void;
  disabled: boolean;
  /** Почему правка недоступна, пока disabled. */
  disabledReason: string;
}

/** Точные значения дополняют перетаскивание: конец всегда исключающий, как в сохранённом черновике. */
export const MontageClipEditor = memo(function MontageClipEditor({
  draft,
  clip,
  title,
  onChange,
  onRequestRemove,
  disabled,
  disabledReason
}: Props): ReactElement {
  if (!clip)
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography color="text.secondary">{montageTexts.selectClipToTrim}</Typography>
      </Paper>
    );
  // Блокировка родителя через pointerEvents не останавливает клавиатуру и отложенный blur.
  // Поля и действия блокируются здесь; обработчик также сохраняет черновик при смене состояния.
  const change = (clips: MontageClip[]): void => {
    if (!disabled) onChange({ ...draft, clips });
  };
  const next = draft.clips[draft.clips.findIndex((item) => item.id === clip.id) + 1];
  const slipReason = disabled ? disabledReason : montageTexts.cardCannotSlip;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1">{montageTexts.selectedScene(clip.scene)}</Typography>
        {title ? <Typography variant="body2">{title}</Typography> : null}
        <Typography variant="caption" color="text.secondary">
          {clip.kind === 'card' ? montageTexts.cardSource : montageTexts.videoSource}
        </Typography>
        <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
          {clip.path}
        </Typography>
        <Typography variant="body2">
          {montageTexts.sourceRange({ start: frameLabel(clip.source_start_frame), end: frameLabel(clip.source_end_frame_exclusive), frames: clipLength(clip) })}
        </Typography>
        {clip.kind === 'video' && clip.source_frames === null ? <Alert severity="info">{montageTexts.awaitSourceMetadata}</Alert> : null}
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <TextField
            key={`start-${clip.id}-${clip.source_start_frame}`}
            size="small"
            type="number"
            label={montageTexts.sourceStart}
            sx={{ width: 240, maxWidth: '100%', flexShrink: 0 }}
            disabled={disabled || clip.kind === 'card'}
            defaultValue={clip.source_start_frame}
            slotProps={{ htmlInput: { min: 0, max: clip.source_end_frame_exclusive - 1, step: 1 } }}
            onBlur={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value)) change(trimClip(draft.clips, clip.id, 'start', value - clip.source_start_frame));
            }}
          />
          <TextField
            key={`end-${clip.id}-${clip.source_end_frame_exclusive}`}
            size="small"
            type="number"
            label={montageTexts.sourceEnd}
            disabled={disabled}
            sx={{ width: 240, maxWidth: '100%', flexShrink: 0 }}
            defaultValue={clip.source_end_frame_exclusive}
            slotProps={{
              htmlInput: {
                min: clip.source_start_frame + 1,
                max: clip.kind === 'card' ? undefined : (clip.source_frames ?? clip.source_end_frame_exclusive),
                step: 1
              }
            }}
            onBlur={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value)) change(trimClip(draft.clips, clip.id, 'end', value - clip.source_end_frame_exclusive));
            }}
          />
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {montageTexts.slipHint}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
          <TextField
            key={`slip-${clip.id}-${clip.source_start_frame}`}
            size="small"
            type="number"
            label={montageTexts.slipFrames}
            sx={{ width: 240, maxWidth: '100%', flexShrink: 0 }}
            disabled={disabled || clip.kind === 'card'}
            defaultValue={0}
            slotProps={{ htmlInput: { step: 1 } }}
            onBlur={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && value) change(slipClip(draft.clips, clip.id, value));
              event.target.value = '0';
            }}
          />
        </Stack>
        {next ? (
          <Typography variant="caption" color="text.secondary">
            {montageTexts.sharedCut({ scene: clip.scene, next: next.scene })}
          </Typography>
        ) : null}
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <ActionButton
            startIcon={<ArrowBack />}
            size="small"
            disabled={disabled || clip.kind === 'card'}
            disabledReason={slipReason}
            onClick={() => change(slipClip(draft.clips, clip.id, -1))}
          >
            {montageTexts.slipBackward}
          </ActionButton>
          <ActionButton
            startIcon={<ArrowForward />}
            size="small"
            disabled={disabled || clip.kind === 'card'}
            disabledReason={slipReason}
            onClick={() => change(slipClip(draft.clips, clip.id, 1))}
          >
            {montageTexts.slipForward}
          </ActionButton>
          {next ? (
            <>
              <ActionButton
                startIcon={<ArrowBack />}
                size="small"
                disabled={disabled}
                disabledReason={disabledReason}
                onClick={() => change(rollCut(draft.clips, clip.id, -1))}
              >
                {montageTexts.cutBackward}
              </ActionButton>
              <ActionButton
                startIcon={<ArrowForward />}
                size="small"
                disabled={disabled}
                disabledReason={disabledReason}
                onClick={() => change(rollCut(draft.clips, clip.id, 1))}
              >
                {montageTexts.cutForward}
              </ActionButton>
            </>
          ) : null}
          <ActionButton startIcon={<DeleteOutline />} color="error" size="small" disabled={disabled} disabledReason={disabledReason} onClick={onRequestRemove}>
            {montageTexts.removeFromTrack}
          </ActionButton>
        </Stack>
      </Stack>
    </Paper>
  );
});
