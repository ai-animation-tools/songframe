import { ArrowBack, ArrowForward, DeleteOutline } from '@mui/icons-material';
import { memo, type ReactElement } from 'react';
import { Alert, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import type { MontageClip, MontageDraft } from '@shared/montage';
import { clipLength, frameLabel, rollCut, slipClip, trimClip } from '../model';

interface Props {
  draft: MontageDraft;
  clip: MontageClip | undefined;
  title?: string;
  onChange: (draft: MontageDraft) => void;
  onRequestRemove: () => void;
  disabled: boolean;
}

/** Точные значения дополняют перетаскивание: конец всегда исключающий, как в сохранённом черновике. */
export const MontageClipEditor = memo(function MontageClipEditor({ draft, clip, title, onChange, onRequestRemove, disabled }: Props): ReactElement {
  if (!clip)
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography color="text.secondary">Выберите фрагмент на видеодорожке для точной обрезки.</Typography>
      </Paper>
    );
  const change = (clips: MontageClip[]): void => onChange({ ...draft, clips });
  const next = draft.clips[draft.clips.findIndex((item) => item.id === clip.id) + 1];
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1">Выбранная сцена · {clip.scene}</Typography>
        {title ? <Typography variant="body2">{title}</Typography> : null}
        <Typography variant="caption" color="text.secondary">
          {clip.kind === 'card' ? 'Опора' : 'Видео'}
        </Typography>
        <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
          {clip.path}
        </Typography>
        <Typography variant="body2">
          В исходнике: {frameLabel(clip.source_start_frame)} — {frameLabel(clip.source_end_frame_exclusive)} · {clipLength(clip)} кадров
        </Typography>
        {clip.kind === 'video' && clip.source_frames === null ? (
          <Alert severity="info">Ожидаем метаданные длины исходника. Расширение конца станет доступно после загрузки видео.</Alert>
        ) : null}
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <TextField
            key={`start-${clip.id}-${clip.source_start_frame}`}
            size="small"
            type="number"
            label="Начало, кадр"
            sx={{ width: 240, maxWidth: '100%', flexShrink: 0 }}
            disabled={clip.kind === 'card'}
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
            label="Конец (исключая), кадр"
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
          Сдвиг участка внутри исходника меняет выбранный момент, сохраняя длительность фрагмента.
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
          <TextField
            key={`slip-${clip.id}-${clip.source_start_frame}`}
            size="small"
            type="number"
            label="Сдвиг участка, кадров"
            sx={{ width: 240, maxWidth: '100%', flexShrink: 0 }}
            disabled={clip.kind === 'card'}
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
            Общий стык {clip.scene} → {next.scene}: кадры переходят от одного плана другому, длина монтажа сохраняется.
          </Typography>
        ) : null}
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <Button startIcon={<ArrowBack />} size="small" disabled={clip.kind === 'card'} onClick={() => change(slipClip(draft.clips, clip.id, -1))}>
            Сдвиг −1 кадр
          </Button>
          <Button startIcon={<ArrowForward />} size="small" disabled={clip.kind === 'card'} onClick={() => change(slipClip(draft.clips, clip.id, 1))}>
            Сдвиг +1 кадр
          </Button>
          {next ? (
            <>
              <Button startIcon={<ArrowBack />} size="small" onClick={() => change(rollCut(draft.clips, clip.id, -1))}>
                Стык −1
              </Button>
              <Button startIcon={<ArrowForward />} size="small" onClick={() => change(rollCut(draft.clips, clip.id, 1))}>
                Стык +1
              </Button>
            </>
          ) : null}
          <Button startIcon={<DeleteOutline />} color="error" size="small" disabled={disabled} onClick={onRequestRemove}>
            Удалить с дорожки
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
});
