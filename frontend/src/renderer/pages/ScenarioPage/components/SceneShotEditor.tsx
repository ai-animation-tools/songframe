import { scenarioTexts } from '@shared/texts/scenario';
import type { ReactElement } from 'react';
import { Autocomplete, Box, Checkbox, FormControlLabel, Button, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import type { SceneShot, ScenesFile } from '@shared/types';
import { formatClock } from '../../../format';
import { FPS } from '@shared/video';
import type { EntityOption } from '../types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { ShotPageButton } from '../../../components/ShotPageButton';

/** Редактирует постановку плана, референсы и границу с соседним планом. */
export function SceneShotEditor({
  shot,
  shotIndex,
  scenes,
  referenceOptions,
  leaveReason,
  updateShot,
  setBoundary,
  split,
  mergeNext
}: {
  shot: SceneShot;
  shotIndex: number;
  scenes: ScenesFile;
  referenceOptions: EntityOption[];
  /** Уход на «Производство» сбросит несохранённые черновики страницы: тогда переход недоступен. */
  leaveReason: string | null;
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
          {scenarioTexts.shot.timing({
            start: formatClock(shot.start_frame / FPS),
            end: formatClock(shot.end_frame_exclusive / FPS),
            seconds: ((shot.end_frame_exclusive - shot.start_frame) / FPS).toFixed(2),
            frames: shot.end_frame_exclusive - shot.start_frame
          })}
        </Typography>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' }, '& > *': { minWidth: 0 }, gap: 1.5 }}>
        <TextField select size="small" label={scenarioTexts.fields.part} value={shot.sequence} onChange={(e) => updateShot({ sequence: e.target.value })}>
          {scenes.sequences.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.title || s.id}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          type="number"
          label={scenarioTexts.shot.nextBoundary}
          value={(shot.end_frame_exclusive / FPS).toFixed(2)}
          onChange={(e) => setBoundary(Number(e.target.value) * FPS)}
          inputProps={{ step: 0.1 }}
          disabled={shotIndex >= scenes.scenes.length - 1}
          helperText={scenarioTexts.shot.boundaryHint}
        />
        <TextField size="small" label={scenarioTexts.shot.original} value={shot.original} onChange={(e) => updateShot({ original: e.target.value })} />
      </Box>
      <TextField
        fullWidth
        size="small"
        label={scenarioTexts.fields.camera}
        value={shot.camera}
        onChange={(e) => updateShot({ camera: e.target.value })}
        sx={{ mt: 1.5 }}
        placeholder={scenarioTexts.shot.cameraPlaceholder}
      />
      <TextField
        fullWidth
        multiline
        minRows={2}
        label={scenarioTexts.fields.action}
        value={shot.action}
        onChange={(e) => updateShot({ action: e.target.value })}
        sx={{ mt: 1.5 }}
        placeholder={scenarioTexts.shot.actionPlaceholder}
      />
      <TextField
        fullWidth
        size="small"
        label={scenarioTexts.shot.continuity}
        value={shot.continuity}
        onChange={(e) => updateShot({ continuity: e.target.value })}
        sx={{ mt: 1.5 }}
      />
      <TextField
        select
        fullWidth
        size="small"
        label={scenarioTexts.fields.derivedFrom}
        value={shot.derived_from?.shot ?? ''}
        onChange={(e) => updateShot({ derived_from: e.target.value ? { shot: e.target.value } : undefined })}
        sx={{ mt: 1.5 }}
        helperText={scenarioTexts.shot.derivedHint}
      >
        <MenuItem value="">{scenarioTexts.shot.ownGeneration}</MenuItem>
        {scenes.scenes
          .filter((item) => item.id !== shot.id)
          .map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {scenarioTexts.shot.sourceOption({ id: item.id, title: item.title, derived: item.derived_from ? item.derived_from.shot : null })}
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
          renderInput={(params) => <TextField {...params} label={scenarioTexts.shot.references} />}
        />
        <TextField
          select
          size="small"
          label={scenarioTexts.shot.primaryReference}
          value={shot.card.primary_reference}
          onChange={(e) => updateShot({ card: { primary_reference: e.target.value } })}
        >
          {referenceOptions.map((o) => (
            <MenuItem key={o.id} value={o.id}>
              {o.label}
            </MenuItem>
          ))}
        </TextField>
        <FormControlLabel
          control={<Checkbox checked={shot.lipsync} onChange={(e) => updateShot({ lipsync: e.target.checked })} />}
          label={scenarioTexts.fields.lipsync}
        />
      </Box>
      {/* Парные действия границ плана стоят рядом внизу карточки; объединение явно подтверждает потерю отдельного плана. Последним — переход к производству плана. */}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
        <Button variant="outlined" size="small" startIcon={<CallSplitIcon />} onClick={split}>
          {scenarioTexts.shot.split}
        </Button>
        <DestructiveButton
          key={shot.id}
          label={scenarioTexts.shot.mergeNext}
          description={scenarioTexts.shot.mergeDescription({ shot: shot.id, next: scenes.scenes[shotIndex + 1]?.id })}
          startIcon={<CallMergeIcon />}
          variant="outlined"
          size="small"
          disabled={shotIndex >= scenes.scenes.length - 1}
          disabledReason={scenarioTexts.shot.mergeLastReason}
          confirmLabel={scenarioTexts.shot.mergeConfirm}
          onConfirm={mergeNext}
        />
        <ShotPageButton page="production" shot={shot.id} disabledReason={leaveReason} />
      </Stack>
    </Paper>
  );
}
