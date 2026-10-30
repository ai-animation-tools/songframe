import { montageTexts } from '@shared/texts/montage';
import { Sync } from '@mui/icons-material';
import type { ReactElement } from 'react';
import { Stack, TextField, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import type { MontageDraft } from '@shared/montage';
import { frameLabel, montageLength } from '../model';

/** Ручной ввод остаётся на сетке 30 FPS, выделение музыки не подгоняется под видео незаметно. */
export function MontageAudioRange({
  draft,
  trackFrames,
  onChange
}: {
  draft: MontageDraft;
  trackFrames: number | null;
  onChange: (draft: MontageDraft) => void;
}): ReactElement {
  const length = montageLength(draft.clips);
  const pastTrackEnd = trackFrames !== null && draft.audio.start_frame + length > trackFrames;
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
        <TextField
          key={`audio-start-${draft.audio.start_frame}`}
          size="small"
          type="number"
          label={montageTexts.audioStart}
          sx={{ width: 240, maxWidth: '100%', flexShrink: 0 }}
          defaultValue={draft.audio.start_frame}
          slotProps={{ htmlInput: { min: 0, max: draft.audio.end_frame_exclusive - 1, step: 1 } }}
          onBlur={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value))
              onChange({ ...draft, audio: { ...draft.audio, start_frame: Math.max(0, Math.min(draft.audio.end_frame_exclusive - 1, Math.round(value))) } });
          }}
        />
        <TextField
          key={`audio-end-${draft.audio.end_frame_exclusive}`}
          size="small"
          type="number"
          label={montageTexts.audioEnd}
          sx={{ width: 240, maxWidth: '100%', flexShrink: 0 }}
          defaultValue={draft.audio.end_frame_exclusive}
          slotProps={{ htmlInput: { min: draft.audio.start_frame + 1, max: trackFrames ?? undefined, step: 1 } }}
          onBlur={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value))
              onChange({
                ...draft,
                audio: { ...draft.audio, end_frame_exclusive: Math.max(draft.audio.start_frame + 1, Math.min(trackFrames ?? Infinity, Math.round(value))) }
              });
          }}
        />
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {montageTexts.audioRange({ start: frameLabel(draft.audio.start_frame), end: frameLabel(draft.audio.end_frame_exclusive) })}
      </Typography>
      <ActionButton
        startIcon={<Sync />}
        size="small"
        sx={{ alignSelf: 'flex-start' }}
        disabled={!length || pastTrackEnd}
        disabledReason={!length ? montageTexts.addClipsToTrack : montageTexts.videoPastTrack}
        onClick={() => onChange({ ...draft, audio: { ...draft.audio, end_frame_exclusive: draft.audio.start_frame + length } })}
      >
        {montageTexts.fitAudioToVideo}
      </ActionButton>
    </Stack>
  );
}
