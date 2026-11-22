/**
 * Шаг «Сборка» статичного кадра: опоры-состояния с кадрами смены, параметры сборки, предпросмотр и
 * его приёмка. Видео собирает Go (internal/staticshot) заданием; панель только показывает снимок
 * и черновик значений. Принять можно лишь свежий предпросмотр, замена принятого видео — через
 * отдельное подтверждение.
 */
import type { ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Chip, CircularProgress, Divider, Stack, TextField, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SaveIcon from '@mui/icons-material/Save';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import MovieCreationIcon from '@mui/icons-material/MovieCreation';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckIcon from '@mui/icons-material/Check';
import { commonTexts } from '@shared/texts/common';
import { productionTexts } from '@shared/texts/production';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { JobStatus } from '../../../components/JobStatus';
import { LinkedText } from '../../../components/LinkedText';
import { useStaticShot } from '../useStaticShot';
import { VideoPlayer } from '../../../components/VideoPlayer';

const texts = productionTexts.staticShot;
const seconds = productionTexts.productionSpeechPanel.seconds;

export function StaticShotPanel({
  project,
  packageDir,
  hasAsset,
  onApplied
}: {
  project: string;
  packageDir: string;
  /** У плана уже есть принятое видео: приёмка заменяет его после подтверждения. */
  hasAsset: boolean;
  onApplied(): Promise<void>;
}): ReactElement {
  const form = useStaticShot(project, packageDir, hasAsset, onApplied);
  const { view, draft, reasons } = form;
  if (!view)
    return form.error ? (
      <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
        <Alert severity="error">
          <LinkedText text={form.error} />
        </Alert>
        <ActionButton startIcon={<RefreshIcon />} onClick={() => void form.retry()}>
          {texts.retry}
        </ActionButton>
      </Stack>
    ) : (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <CircularProgress size={18} aria-hidden />
        <Typography>{texts.loading}</Typography>
      </Stack>
    );
  return (
    <Stack spacing={2} sx={{ minWidth: 0 }} data-testid="static-shot-panel">
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <Typography variant="subtitle1">{texts.heading}</Typography>
        {form.dirty ? <Chip size="small" color="warning" label={texts.dirty} /> : null}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {texts.explanation}
      </Typography>
      <Typography variant="body2">{texts.planLength({ frames: view.frames, seconds: seconds(view.frames / view.fps) })}</Typography>
      {view.problem ? (
        <Alert severity="warning">
          <LinkedText text={view.problem} />
        </Alert>
      ) : null}
      <Typography variant="subtitle2">{texts.states}</Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1.5 }}>
        {view.states.map((state, index) => {
          const value = draft.from[index] ?? '';
          const frame = Number(value);
          return (
            <Stack key={state.frame} spacing={1} sx={{ minWidth: 0 }}>
              {state.path ? (
                <Box
                  component="img"
                  src={window.api.shell.fileUrl(state.path)}
                  alt={`${state.frame}: ${index === 0 ? texts.base : texts.state({ index: index + 1 })}`}
                  sx={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 1, bgcolor: 'action.hover' }}
                />
              ) : null}
              <Typography variant="body2">
                {state.frame} · {index === 0 ? texts.base : texts.state({ index: index + 1 })}
              </Typography>
              <TextField
                size="small"
                type="number"
                label={texts.fromFrame}
                value={value}
                disabled={form.busy || index === 0}
                helperText={index === 0 ? texts.baseHint : Number.isInteger(frame) ? texts.fromHint({ seconds: seconds(frame / view.fps) }) : ' '}
                slotProps={{ htmlInput: { min: index === 0 ? 0 : 1, max: view.frames - 1, step: 1 } }}
                onChange={(event) => form.change({ ...draft, from: draft.from.map((item, position) => (position === index ? event.target.value : item)) })}
              />
            </Stack>
          );
        })}
      </Box>
      <Accordion variant="outlined" disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle2">{texts.params}</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={1.5}>
            <Typography variant="body2" color="text.secondary">
              {texts.paramsHint}
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 1.5 }}>
              {view.specs.map((spec) => (
                <TextField
                  key={spec.name}
                  size="small"
                  type="number"
                  label={spec.title}
                  value={draft.params[spec.name] ?? ''}
                  disabled={form.busy}
                  helperText={texts.range({ min: spec.min, max: spec.max })}
                  slotProps={{ htmlInput: { min: spec.min, max: spec.max, step: spec.step } }}
                  onChange={(event) => form.change({ ...draft, params: { ...draft.params, [spec.name]: event.target.value } })}
                />
              ))}
            </Box>
          </Stack>
        </AccordionDetails>
      </Accordion>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <ActionButton startIcon={<SaveIcon />} disabled={!!reasons.save} disabledReason={reasons.save ?? undefined} onClick={() => void form.save()}>
          {commonTexts.save}
        </ActionButton>
        <ActionButton
          startIcon={<RestartAltIcon />}
          disabled={form.busy || !form.dirty}
          disabledReason={form.busy ? texts.busy : texts.noChanges}
          onClick={form.reset}
        >
          {commonTexts.resetChanges}
        </ActionButton>
        <ActionButton
          variant={view.preview?.fresh && !form.dirty ? 'outlined' : 'contained'}
          startIcon={<MovieCreationIcon />}
          disabled={!!reasons.build}
          disabledReason={reasons.build ?? undefined}
          onClick={() => void form.build()}
        >
          {view.preview ? texts.rebuild : texts.build}
        </ActionButton>
      </Stack>
      {form.error ? (
        <Alert severity="error">
          <LinkedText text={form.error} />
        </Alert>
      ) : null}
      <JobStatus job={form.job ?? undefined} />
      {view.preview ? (
        <>
          <Divider />
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <Typography variant="subtitle2">{texts.preview}</Typography>
            {view.preview.fresh && !form.dirty ? (
              <Chip size="small" color="success" label={texts.fresh} />
            ) : (
              <Chip size="small" color="warning" label={texts.stale} />
            )}
          </Stack>
          <VideoPlayer path={view.preview.path} version={view.preview.version} label={texts.previewVideo} />
          <Box>
            <ActionButton
              variant="contained"
              startIcon={<CheckIcon />}
              title={texts.acceptHint}
              disabled={!!reasons.accept}
              disabledReason={reasons.accept ?? undefined}
              onClick={form.requestAccept}
            >
              {texts.accept}
            </ActionButton>
          </Box>
        </>
      ) : null}
      <ConfirmationDialog
        open={form.replacement}
        title={texts.replaceTitle}
        description={texts.replaceDescription({ shot: view.shot })}
        confirmLabel={texts.replace}
        confirmIcon={<CheckIcon />}
        confirmColor="error"
        confirmDisabled={!!reasons.accept}
        confirmDisabledReason={reasons.accept ?? undefined}
        cancelDisabled={form.busy}
        cancelDisabledReason={texts.busy}
        closeDisabled={form.busy}
        onClose={form.closeReplacement}
        onConfirm={() => void form.confirmReplacement()}
      />
    </Stack>
  );
}
