import { scenarioTexts } from '@shared/texts/scenario';
import { useState, type ReactElement } from 'react';
import { Alert, AlertTitle, Autocomplete, Box, Checkbox, FormControlLabel, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import type { LyricsLine, SceneShot, ScenesFile, TimingLine } from '@shared/types';
import { hasFillMarker, nextShotId, splitPlan, type SplitPlan } from '@shared/scene-editing';
import { formatClock } from '../../../format';
import type { EntityOption } from '../types';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { MergeShotsDialog } from './MergeShotsDialog';
import { ShotPageButton } from '../../../components/ShotPageButton';
import { ActionButton } from '../../../components/ActionButton';

/**
 * Редактирует постановку плана, референсы и границу с соседним планом. Принятый в производстве план
 * (locked) показывается только для чтения; граница и объединение закрыты и тогда, когда сдвигают
 * следующий принятый план (nextLocked). Деление и объединение подтверждаются окном с итогом: где режется план и какие
 * строки песни достаются половинам, какие коды исчезают и не длиннее ли объединённый план предела запроса видео.
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
  merge,
  lines = [],
  lyrics = [],
  acceptedShots = [],
  maxVideoSeconds = null
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
  split(plan: SplitPlan | null): void;
  merge(count: number): void;
  /** Разметка песни: деление идёт по началу строки внутри плана. */
  lines?: readonly TimingLine[];
  lyrics?: readonly LyricsLine[];
  /** Принятые планы: объединение заканчивается перед первым из них. */
  acceptedShots?: readonly string[];
  /** Предел одного запроса видео у провайдера проекта, секунды; null — не проверяется. */
  maxVideoSeconds?: number | null;
}): ReactElement {
  const [dialog, setDialog] = useState<'split' | 'merge' | null>(null);
  const plan = splitPlan(shot, lines, lyrics, scenes.fps);
  // Код новой половины тот же, что даст splitShot.
  const splitId = nextShotId(scenes.scenes, shot.id);
  const last = shotIndex >= scenes.scenes.length - 1;
  // Поле с пометкой ЗАПОЛНИТЬ подсвечивается ошибкой и объясняет, что сделать: так видно, что осталось свести после
  // объединения или деления.
  const marked = (value: string, hint?: string) =>
    hasFillMarker(value) ? { error: true, helperText: scenarioTexts.shot.fillMarker } : hint ? { helperText: hint } : {};
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
          {...marked(shot.original)}
          onChange={(e) => updateShot({ original: e.target.value })}
        />
      </Box>
      <TextField
        fullWidth
        size="small"
        disabled={locked}
        label={scenarioTexts.fields.camera}
        value={shot.camera}
        {...marked(shot.camera)}
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
        {...marked(shot.action)}
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
        {...marked(shot.continuity)}
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
      {/* Парные действия границ плана стоят рядом внизу карточки; оба подтверждаются окном с итогом. Последним — переход к производству плана. */}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
        <ActionButton
          variant="outlined"
          size="small"
          startIcon={<CallSplitIcon />}
          disabled={locked}
          disabledReason={scenarioTexts.accepted.lockedTitle({ shot: shot.id })}
          onClick={() => (plan ? setDialog('split') : split(null))}
        >
          {scenarioTexts.shot.split}
        </ActionButton>
        <ActionButton
          variant="outlined"
          size="small"
          color="warning"
          startIcon={<CallMergeIcon />}
          disabled={last || !!neighbourReason}
          disabledReason={
            last ? scenarioTexts.shot.mergeLastReason : locked ? neighbourReason : nextLocked ? scenarioTexts.accepted.mergeReason({ shot: nextLocked }) : null
          }
          onClick={() => setDialog('merge')}
        >
          {scenarioTexts.shot.mergeNext}
        </ActionButton>
        <ShotPageButton page="production" shot={shot.id} disabledReason={leaveReason} />
      </Stack>
      {plan ? (
        <ConfirmationDialog
          open={dialog === 'split'}
          title={scenarioTexts.shot.splitTitle({ shot: shot.id })}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            split(plan);
          }}
          confirmLabel={scenarioTexts.shot.splitConfirm}
          confirmIcon={<CallSplitIcon />}
        >
          <Stack spacing={1} sx={{ pt: 1 }}>
            <Typography variant="body2">
              {plan.byLine
                ? scenarioTexts.shot.splitByLine({ shot: shot.id, at: formatClock(plan.at / scenes.fps), id: splitId, first: plan.first, second: plan.second })
                : scenarioTexts.shot.splitMiddle({ shot: shot.id, at: formatClock(plan.at / scenes.fps), id: splitId })}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {scenarioTexts.shot.splitRest({ shot: shot.id, id: splitId })}
            </Typography>
          </Stack>
        </ConfirmationDialog>
      ) : null}
      {dialog === 'merge' ? (
        <MergeShotsDialog
          key={shot.id}
          open
          scenes={scenes}
          shotIndex={shotIndex}
          acceptedShots={acceptedShots}
          maxSeconds={maxVideoSeconds}
          onClose={() => setDialog(null)}
          onConfirm={(count) => {
            setDialog(null);
            merge(count);
          }}
        />
      ) : null}
    </Paper>
  );
}
