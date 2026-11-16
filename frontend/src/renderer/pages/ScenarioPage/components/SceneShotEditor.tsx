import { scenarioTexts } from '@shared/texts/scenario';
import type { ReactElement } from 'react';
import { Alert, AlertTitle, Autocomplete, Box, Checkbox, FormControlLabel, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import type { SceneShot, ScenesFile } from '@shared/types';
import { formatClock } from '../../../format';
import type { EntityOption } from '../types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { ShotPageButton } from '../../../components/ShotPageButton';
import { ActionButton } from '../../../components/ActionButton';

/**
 * Редактирует постановку плана, референсы и границу с соседним планом. Принятый в производстве план
 * (locked) показывается только для чтения; граница и объединение закрыты и тогда, когда сдвигают
 * следующий принятый план (nextLocked).
 */
export function SceneShotEditor({
  shot,
  shotIndex,
  scenes,
  referenceOptions,
  leaveReason,
  locked = false,
  nextLocked = null,
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
  /** План принят в производстве: постановка закрыта для правки. */
  locked?: boolean;
  /** ID следующего плана, если он принят: граница и объединение изменили бы его. */
  nextLocked?: string | null;
  updateShot(patch: Partial<SceneShot>): void;
  setBoundary(frames: number): void;
  split(): void;
  mergeNext(): void;
}): ReactElement {
  const last = shotIndex >= scenes.scenes.length - 1;
  // Что мешает менять границу и объединять со следующим: последний план, принятый этот или следующий.
  const neighbourReason = locked
    ? scenarioTexts.accepted.lockedTitle({ shot: shot.id })
    : nextLocked
      ? scenarioTexts.accepted.boundaryReason({ shot: nextLocked })
      : null;
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      {locked ? (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          <AlertTitle>{scenarioTexts.accepted.lockedTitle({ shot: shot.id })}</AlertTitle>
          {scenarioTexts.accepted.lockedHint}
        </Alert>
      ) : null}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1.5 }}>
        <Typography variant="h6">{shot.id}</Typography>
        <Typography variant="body2" color="text.secondary">
          {scenarioTexts.shot.timing({
            start: formatClock(shot.start_frame / scenes.fps),
            end: formatClock(shot.end_frame_exclusive / scenes.fps),
            seconds: ((shot.end_frame_exclusive - shot.start_frame) / scenes.fps).toFixed(2),
            frames: shot.end_frame_exclusive - shot.start_frame
          })}
        </Typography>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' }, '& > *': { minWidth: 0 }, gap: 1.5 }}>
        <TextField
          select
          size="small"
          disabled={locked}
          label={scenarioTexts.fields.part}
          value={shot.sequence}
          onChange={(e) => updateShot({ sequence: e.target.value })}
        >
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
          value={(shot.end_frame_exclusive / scenes.fps).toFixed(2)}
          onChange={(e) => setBoundary(Number(e.target.value) * scenes.fps)}
          inputProps={{ step: 0.1 }}
          disabled={last || !!neighbourReason}
          helperText={!last && neighbourReason ? neighbourReason : scenarioTexts.shot.boundaryHint}
          // Причина блокировки читается и у закрытого поля: приглушённый цвет disabled не проходит по контрасту.
          slotProps={{ formHelperText: { sx: { '&.Mui-disabled': { color: 'text.secondary' } } } }}
        />
        <TextField
          size="small"
          disabled={locked}
          label={scenarioTexts.shot.original}
          value={shot.original}
          onChange={(e) => updateShot({ original: e.target.value })}
        />
      </Box>
      <TextField
        fullWidth
        size="small"
        disabled={locked}
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
        disabled={locked}
        label={scenarioTexts.fields.action}
        value={shot.action}
        onChange={(e) => updateShot({ action: e.target.value })}
        sx={{ mt: 1.5 }}
        placeholder={scenarioTexts.shot.actionPlaceholder}
      />
      <TextField
        fullWidth
        size="small"
        disabled={locked}
        label={scenarioTexts.shot.continuity}
        value={shot.continuity}
        onChange={(e) => updateShot({ continuity: e.target.value })}
        sx={{ mt: 1.5 }}
      />
      <TextField
        select
        fullWidth
        size="small"
        disabled={locked}
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
          disabled={locked}
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
          disabled={locked}
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
          control={<Checkbox disabled={locked} checked={shot.lipsync} onChange={(e) => updateShot({ lipsync: e.target.checked })} />}
          label={scenarioTexts.fields.lipsync}
        />
      </Box>
      {/* Парные действия границ плана стоят рядом внизу карточки; объединение явно подтверждает потерю отдельного плана. Последним — переход к производству плана. */}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
        <ActionButton
          variant="outlined"
          size="small"
          startIcon={<CallSplitIcon />}
          disabled={locked}
          disabledReason={scenarioTexts.accepted.lockedTitle({ shot: shot.id })}
          onClick={split}
        >
          {scenarioTexts.shot.split}
        </ActionButton>
        <DestructiveButton
          key={shot.id}
          label={scenarioTexts.shot.mergeNext}
          description={scenarioTexts.shot.mergeDescription({ shot: shot.id, next: scenes.scenes[shotIndex + 1]?.id })}
          startIcon={<CallMergeIcon />}
          variant="outlined"
          size="small"
          disabled={last || !!neighbourReason}
          disabledReason={
            last ? scenarioTexts.shot.mergeLastReason : locked ? neighbourReason : nextLocked ? scenarioTexts.accepted.mergeReason({ shot: nextLocked }) : null
          }
          confirmLabel={scenarioTexts.shot.mergeConfirm}
          onConfirm={mergeNext}
        />
        <ShotPageButton page="production" shot={shot.id} disabledReason={leaveReason} />
      </Stack>
    </Paper>
  );
}
