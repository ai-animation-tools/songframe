import { useState, type ReactElement } from 'react';
import { Alert, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { Check, DeleteOutline, Download, GraphicEq, Hearing, Refresh, Stop } from '@mui/icons-material';
import type { JobInfo } from '@shared/types';
import { vocalTexts } from '@shared/texts/vocals';
import { commonTexts } from '@shared/texts/common';
import { songTimingTexts as texts } from '@shared/texts/song-timing';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { DateTime } from '../../../components/DateTime';
import { useApp } from '../../../state';
import { TimingJobProgress } from './TimingJobProgress';
import { VocalComparison } from './VocalComparison';
import { useVocalPreparation } from './useVocalPreparation';

interface Props {
  project: string;
  disabled: boolean;
  /** Родитель уже показывает единый статус операции и закрытый журнал. */
  managedProgress?: boolean;
  onReady(ready: boolean): void;
  onJob(job: JobInfo | null): void;
  onBusy?(busy: boolean): void;
}

/** Новая подготовка использует Voc FT; сохранённые исторические WAV доступны без повторного выделения. */
export function VocalPreparation(props: Props): ReactElement {
  const { online } = useApp();
  const preparation = useVocalPreparation(props);
  const { view, job, error, busy, apiReady } = preparation;
  const [resultId, setResultId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const currentModel = view?.models.find((item) => item.id === 'voc-ft');
  const result =
    view?.results.find((item) => item.id === resultId) ??
    view?.results.find((item) => item.id === view.selectedId) ??
    view?.results
      .slice()
      .reverse()
      .find((item) => item.modelId === 'voc-ft') ??
    view?.results[0];
  const preview = view?.results.find((item) => item.id === previewId);
  const deletion = view?.results.find((item) => item.id === deleteId);
  const running = job?.status === 'running';
  const blocked = props.disabled || busy || running || !apiReady;
  const deleteReason = props.disabled ? texts.vocalInUse : texts.operationPending;
  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle1">{texts.vocalPreparation}</Typography>
      {running ? null : (
        <>
          <Typography variant="body2" color="text.secondary">
            {texts.vocalHelp}
          </Typography>
          <Typography variant="body2">
            {currentModel?.installed
              ? `Voc FT · ${texts.vocalModelInstalled}`
              : texts.vocalModelSize({ mib: Math.ceil((currentModel?.totalBytes ?? 0) / 1024 / 1024) })}
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {currentModel && !currentModel.installed && (
              <ActionButton
                startIcon={<Download />}
                disabled={blocked || !online}
                disabledReason={!online ? texts.noNetwork : texts.operationPending}
                onClick={() => void preparation.download('voc-ft')}
              >
                {texts.downloadVocal}
              </ActionButton>
            )}
            <ActionButton
              startIcon={<GraphicEq />}
              variant="outlined"
              disabled={blocked || !currentModel?.installed || !view?.sourceSha256}
              disabledReason={!view?.sourceSha256 ? texts.vocalSourceMissing : !currentModel?.installed ? vocalTexts.modelMissing : texts.operationPending}
              onClick={() => void preparation.separate('voc-ft')}
            >
              {result ? texts.separateAgain : texts.separateVocal}
            </ActionButton>
            {(!view || error) && (
              <ActionButton startIcon={<Refresh />} disabled={blocked} disabledReason={texts.operationPending} onClick={() => void preparation.refresh()}>
                {texts.retryRead}
              </ActionButton>
            )}
          </Stack>
          {result && (
            <>
              {view!.results.length > 1 && (
                <TextField
                  select
                  label={texts.vocalResult}
                  value={result.id}
                  disabled={blocked}
                  onChange={(event) => {
                    setResultId(event.target.value);
                    setPreviewId(null);
                  }}
                >
                  {view!.results.map((item, index) => (
                    <MenuItem key={item.id} value={item.id}>
                      {item.modelLabel} · {index + 1}
                    </MenuItem>
                  ))}
                </TextField>
              )}
              <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Typography variant="body2">
                  {result.modelLabel} · <DateTime value={result.createdAt} />
                </Typography>
                {view?.selectedId === result.id && <Chip size="small" icon={<Check />} color="primary" label={texts.vocalSelected} />}
              </Stack>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                <ActionButton
                  startIcon={<Hearing />}
                  disabled={props.disabled || busy}
                  disabledReason={texts.operationPending}
                  aria-label={`${texts.vocalPreview}: ${result.modelLabel}`}
                  onClick={() => setPreviewId(result.id)}
                >
                  {texts.vocalPreview}
                </ActionButton>
                <ActionButton
                  startIcon={<Check />}
                  disabled={blocked || view?.selectedId === result.id}
                  disabledReason={view?.selectedId === result.id ? texts.vocalReady : texts.operationPending}
                  aria-label={`${texts.vocalSelect}: ${result.modelLabel}`}
                  onClick={() => void preparation.select(result.id)}
                >
                  {texts.vocalSelect}
                </ActionButton>
                <ActionButton
                  startIcon={<DeleteOutline />}
                  color="error"
                  disabled={blocked}
                  disabledReason={deleteReason}
                  aria-label={`${commonTexts.delete}: ${result.modelLabel}`}
                  onClick={() => {
                    setPreviewId(null);
                    setDeleteId(result.id);
                  }}
                >
                  {commonTexts.delete}
                </ActionButton>
              </Stack>
              {preview && view?.sourcePath && (
                <VocalComparison
                  key={`${view.sourceSha256}:${preview.id}`}
                  sourcePath={view.sourcePath}
                  vocalPath={preview.path}
                  disabled={props.disabled || busy || running}
                  disabledReason={texts.operationPending}
                />
              )}
              <Typography variant="body2" color="text.secondary">
                {view?.selectedId ? texts.vocalReady : texts.vocalSelectRequired}
              </Typography>
            </>
          )}
        </>
      )}
      {running && !props.managedProgress && (
        <ActionButton
          startIcon={<Stop />}
          disabled={props.disabled || busy}
          disabledReason={texts.operationPending}
          onClick={() => void preparation.cancel()}
          sx={{ alignSelf: 'flex-start' }}
        >
          {texts.stopPreparation}
        </ActionButton>
      )}
      {job && !props.managedProgress && (
        <TimingJobProgress
          key={job.id}
          job={job}
          label={job.kind === 'model_download' ? texts.downloadingVocal : texts.separating}
          name={texts.vocalProgress}
        />
      )}
      {job && (job.status === 'failed' || job.status === 'interrupted') && !error && <Alert severity="info">{job.error || texts.vocalStopped}</Alert>}
      {error && !deletion && <Alert severity={error === texts.vocalStopped || error === vocalTexts.cancelled ? 'info' : 'error'}>{error}</Alert>}
      {view?.problems.map((problem) => (
        <Alert key={problem} severity="warning">
          {problem}
        </Alert>
      ))}
      <ConfirmationDialog
        open={!!deletion}
        title={texts.deleteVocalTitle}
        description={deletion ? texts.deleteVocalDescription({ model: deletion.modelLabel }) : undefined}
        confirmLabel={commonTexts.delete}
        confirmIcon={<DeleteOutline />}
        confirmColor="error"
        explicitCancelOnly
        closeDisabled={busy}
        cancelDisabled={busy}
        cancelDisabledReason={texts.operationPending}
        confirmDisabled={blocked}
        confirmDisabledReason={deleteReason}
        onClose={() => setDeleteId(null)}
        onConfirm={() => {
          if (deletion)
            void preparation.remove(deletion.id).then((success) => {
              if (success) {
                setDeleteId(null);
                setResultId(null);
              }
            });
        }}
      >
        {busy && <Typography role="status">{texts.deletingVocal}</Typography>}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </ConfirmationDialog>
    </Stack>
  );
}
