import type { ReactElement } from 'react';
import { Alert, Box, Chip, CircularProgress, Divider, Paper, Stack, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import MovieCreationIcon from '@mui/icons-material/MovieCreation';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckIcon from '@mui/icons-material/Check';
import { commonTexts } from '@shared/texts/common';
import { derivedShotTexts as texts } from '@shared/texts/derived-shot';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { JobStatus } from '../../../components/JobStatus';
import { LinkedText } from '../../../components/LinkedText';
import { useDerivedShot } from '../useDerivedShot';
import { recipeInfo } from '../derivedRecipeForm';
import { DerivedRecipeFields } from './DerivedRecipeFields';
import { DerivedShotPreview } from './DerivedShotPreview';

/** Отдельная локальная сборка заменяет подготовку нового платного запроса у производного плана. */
export function DerivedShotPanel({ project, shot, onApplied }: { project: string; shot: string; onApplied(): Promise<void> }): ReactElement {
  const form = useDerivedShot(project, shot, onApplied);
  const { view, reasons } = form;
  const error = form.error ? (
    <>
      <Alert severity="error">
        <LinkedText text={form.error} />
      </Alert>
      <Box>
        <ActionButton startIcon={<RefreshIcon />} disabled={form.busy} disabledReason={texts.busy} onClick={() => void form.retry()}>
          {texts.retry}
        </ActionButton>
      </Box>
    </>
  ) : null;
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
          <Typography variant="h6">{texts.heading}</Typography>
          {reasons?.dirty ? <Chip size="small" color="warning" label={texts.dirty} /> : null}
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {texts.explanation}
        </Typography>
        {!view && !form.error ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={18} aria-hidden />
            <Typography>{texts.loading}</Typography>
          </Stack>
        ) : null}
        {view && reasons ? (
          <>
            <Typography variant="subtitle2">{texts.source({ shot: view.sourceShot ?? '—', title: view.sourceTitle })}</Typography>
            <Typography variant="body2" color="text.secondary">
              {texts.sourceFrames({ frames: view.sourceFrames })}
            </Typography>
            {view.sourcePath ? (
              <Box
                component="video"
                controls
                preload="metadata"
                aria-label={texts.sourceVideo}
                key={view.sourcePath}
                src={window.api.shell.fileUrl(view.sourcePath)}
                sx={{ width: '100%', maxHeight: 300, borderRadius: 1, bgcolor: 'common.black' }}
              />
            ) : null}
            <Typography variant="subtitle2">{texts.targetFrames({ frames: view.targetFrames })}</Typography>
            {view.action ? (
              <Box>
                <Typography variant="subtitle2">{texts.action}</Typography>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {view.action}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {texts.actionHint}
                </Typography>
              </Box>
            ) : null}
            {view.problem ? (
              <Alert severity="warning">
                <LinkedText text={view.problem} />
              </Alert>
            ) : null}
            {view.toolsProblem ? (
              <Alert severity="info">
                <LinkedText text={view.toolsProblem} />
              </Alert>
            ) : null}
            <DerivedRecipeFields draft={form.draft} disabled={form.busy} sourceFrames={view.sourceFrames} onChange={form.change} />
            {reasons.shapeProblem && form.draft.mode ? <Alert severity="warning">{reasons.shapeProblem}</Alert> : null}
            {reasons.boundsProblem && !view.problem ? (
              <Alert severity="warning">
                <LinkedText text={reasons.boundsProblem} />
              </Alert>
            ) : null}
            {reasons.recipe && !reasons.boundsProblem ? <Typography variant="body2">{recipeInfo(reasons.recipe, view.targetFrames)}</Typography> : null}
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              <ActionButton
                startIcon={<SaveIcon />}
                variant="contained"
                disabled={!!reasons.save}
                disabledReason={reasons.save}
                onClick={() => void form.save()}
              >
                {commonTexts.save}
              </ActionButton>
              <ActionButton
                startIcon={<RestartAltIcon />}
                disabled={form.busy || !reasons.dirty}
                disabledReason={form.busy ? texts.busy : texts.noChanges}
                onClick={form.reset}
              >
                {commonTexts.resetChanges}
              </ActionButton>
              <ActionButton startIcon={<MovieCreationIcon />} disabled={!!reasons.build} disabledReason={reasons.build} onClick={() => void form.build()}>
                {view.preview ? texts.rebuild : texts.build}
              </ActionButton>
            </Stack>
            {error}
            <JobStatus job={view.job ?? undefined} running={form.pending} />
            {view.preview ? (
              <>
                <Divider />
                <DerivedShotPreview preview={view.preview} hasAsset={view.hasAsset} disabledReason={reasons.accept} onAccept={form.requestAccept} />
              </>
            ) : null}
          </>
        ) : null}
        {!view ? error : null}
      </Stack>
      <ConfirmationDialog
        open={form.replacement}
        title={texts.replaceTitle}
        description={texts.replaceDescription({ shot })}
        confirmLabel={texts.replace}
        confirmIcon={<CheckIcon />}
        confirmColor="error"
        confirmDisabled={!!reasons?.accept}
        confirmDisabledReason={reasons?.accept}
        cancelDisabled={form.pending}
        cancelDisabledReason={texts.busy}
        closeDisabled={form.pending}
        onClose={form.closeReplacement}
        onConfirm={() => void form.confirmReplacement()}
      />
    </Paper>
  );
}
