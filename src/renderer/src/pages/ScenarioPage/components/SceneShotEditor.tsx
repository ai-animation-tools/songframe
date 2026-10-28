import type { ReactElement } from 'react';
import { Autocomplete, Box, Checkbox, FormControlLabel, Button, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import type { SceneShot, ScenesFile } from '@shared/types';
import { formatClock } from '../../../format';
import { FPS } from '@shared/video';
import type { EntityOption } from '../types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { countLabel } from '@shared/plural';

/** Редактирует постановку плана, референсы и границу с соседним планом. */
export function SceneShotEditor({
  shot,
  shotIndex,
  scenes,
  referenceOptions,
  updateShot,
  setBoundary,
  split,
  mergeNext
}: {
  shot: SceneShot;
  shotIndex: number;
  scenes: ScenesFile;
  referenceOptions: EntityOption[];
  updateShot(patch: Partial<SceneShot>): void;
  setBoundary(frames: number): void;
  split(): void;
  mergeNext(): void;
}): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1.5 }}>
        <Typography variant="h6">{shot.id}</Typography>
        <Typography variant="body2" color="text.secondary">
          {formatClock(shot.start_frame / FPS)}–{formatClock(shot.end_frame_exclusive / FPS)} ·{' '}
          {((shot.end_frame_exclusive - shot.start_frame) / FPS).toFixed(2)} с ·{' '}
          {countLabel(shot.end_frame_exclusive - shot.start_frame, 'кадр', 'кадра', 'кадров')}
        </Typography>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' }, '& > *': { minWidth: 0 }, gap: 1.5 }}>
        <TextField select size="small" label="Часть" value={shot.sequence} onChange={(e) => updateShot({ sequence: e.target.value })}>
          {scenes.sequences.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.title || s.id}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          type="number"
          label="Граница со следующим, с"
          value={(shot.end_frame_exclusive / FPS).toFixed(2)}
          onChange={(e) => setBoundary(Number(e.target.value) * FPS)}
          inputProps={{ step: 0.1 }}
          disabled={shotIndex >= scenes.scenes.length - 1}
          helperText="начало следующего плана двигается вместе"
        />
        <TextField size="small" label="Строки песни / оригинал" value={shot.original} onChange={(e) => updateShot({ original: e.target.value })} />
      </Box>
      <TextField
        fullWidth
        size="small"
        label="Камера"
        value={shot.camera}
        onChange={(e) => updateShot({ camera: e.target.value })}
        sx={{ mt: 1.5 }}
        placeholder="Средний план, статика; медленный наезд"
      />
      <TextField
        fullWidth
        multiline
        minRows={2}
        label="Действие"
        value={shot.action}
        onChange={(e) => updateShot({ action: e.target.value })}
        sx={{ mt: 1.5 }}
        placeholder="Что происходит в кадре за время плана"
      />
      <TextField
        fullWidth
        size="small"
        label="Непрерывность (стыки с соседями)"
        value={shot.continuity}
        onChange={(e) => updateShot({ continuity: e.target.value })}
        sx={{ mt: 1.5 }}
      />
      <TextField
        select
        fullWidth
        size="small"
        label="Собирается из плана"
        value={shot.derived_from?.shot ?? ''}
        onChange={(e) => updateShot({ derived_from: e.target.value ? { shot: e.target.value } : undefined })}
        sx={{ mt: 1.5 }}
        helperText="Стоп-кадр, повтор или замедление материала другого плана: описание, опоры и генерация для этого плана не нужны. Как именно используется материал, опишите в «Действии»."
      >
        <MenuItem value="">Нет — собственная генерация</MenuItem>
        {scenes.scenes
          .filter((item) => item.id !== shot.id)
          .map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {item.id}
              {item.title ? ` · ${item.title}` : ''}
              {item.derived_from ? ` (сам из ${item.derived_from.shot})` : ''}
            </MenuItem>
          ))}
      </TextField>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)' },
          '& > *': { minWidth: 0 },
          gap: 1.5,
          mt: 1.5,
          alignItems: 'center'
        }}
      >
        <Autocomplete
          multiple
          size="small"
          options={referenceOptions}
          getOptionLabel={(o) => o.label}
          value={referenceOptions.filter((o) => shot.references.includes(o.id))}
          onChange={(_e, value) => {
            const ids = value.map((v) => v.id);
            updateShot({
              references: ids.length ? ids : ['—'],
              card: {
                primary_reference: ids.includes(shot.card.primary_reference) ? shot.card.primary_reference : (ids[0] ?? shot.card.primary_reference)
              }
            });
          }}
          renderInput={(params) => <TextField {...params} label="В кадре (референсы)" />}
        />
        <TextField
          select
          size="small"
          label="Референс карточки"
          value={shot.card.primary_reference}
          onChange={(e) => updateShot({ card: { primary_reference: e.target.value } })}
        >
          {referenceOptions.map((o) => (
            <MenuItem key={o.id} value={o.id}>
              {o.label}
            </MenuItem>
          ))}
        </TextField>
        <FormControlLabel control={<Checkbox checked={shot.lipsync} onChange={(e) => updateShot({ lipsync: e.target.checked })} />} label="Липсинк" />
      </Box>
      {/* Парные действия границ плана стоят рядом внизу карточки; объединение явно подтверждает потерю отдельного плана. */}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
        <Button variant="outlined" size="small" startIcon={<CallSplitIcon />} onClick={split}>
          Разделить план пополам
        </Button>
        <DestructiveButton
          key={shot.id}
          label="Объединить со следующим"
          description={`Планы ${shot.id} и ${scenes.scenes[shotIndex + 1]?.id ?? 'следующий'} станут одним. Камера и действие останутся от ${shot.id}; отдельная запись следующего плана будет удалена. Изменение применяется к черновику.`}
          startIcon={<CallMergeIcon />}
          variant="outlined"
          size="small"
          disabled={shotIndex >= scenes.scenes.length - 1}
          disabledReason="Это последний план: объединять не с чем."
          confirmLabel="Объединить"
          onConfirm={mergeNext}
        />
      </Stack>
    </Paper>
  );
}
