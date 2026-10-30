import { timingTexts } from '@shared/texts/timing';
import { Download } from '@mui/icons-material';
/** Наблюдение за обычным заданием Jobs продолжается при повторном открытии диалога. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import type { JobInfo } from '@shared/types';
import type { WhisperModelId } from '@shared/whisper-models';
import { ActionButton, JobStatus } from '../../../components';
import { useApp } from '../../../state';
import { OFFLINE_MESSAGE } from '../../../network';

interface Props {
  model: WhisperModelId;
  onDownloaded(directory: string): void;
}

// Завершённое задание выбирает папку один раз за сессию, чтобы повторное открытие не отменяло ручной выбор модели.
const appliedJobs = new Set<string>();

export function WhisperModelDownload({ model, onDownloaded }: Props): ReactElement {
  const { describeError, online } = useApp();
  const [job, setJob] = useState<JobInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const jobId = job?.id;
  const running = job?.status === 'running';

  useEffect(() => {
    let active = true;
    mounted.current = true;
    window.api.jobs
      .list()
      .then((jobs) => {
        if (!active) return;
        setJob(
          jobs
            .filter((item) => item.kind === 'model_download' && item.modelDownload?.model === model)
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null
        );
      })
      .catch((reason: unknown) => {
        if (active) setError(describeError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [model, describeError]);

  useEffect(() => {
    if (!jobId || !running) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try {
        const next = await window.api.jobs.get(jobId);
        if (!active) return;
        setJob(next);
        setError(next ? '' : timingTexts.downloadNotFound);
        if (next?.status !== 'running') return;
      } catch (reason) {
        if (!active) return;
        setError(timingTexts.downloadRefreshFailed({ reason: describeError(reason) }));
      }
      if (active) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId, running, describeError]);

  useEffect(() => {
    if (job?.status !== 'done' || !job.modelDownload || appliedJobs.has(job.id)) return;
    // Успех выбирает фактическую папку задания и обновляет диагностику без повторного скачивания.
    appliedJobs.add(job.id);
    onDownloaded(job.modelDownload.directory);
  }, [job, onDownloaded]);

  const download = async (): Promise<void> => {
    setStarting(true);
    setError('');
    try {
      const next = await window.api.timing.downloadModel(model);
      if (mounted.current) setJob(next);
    } catch (reason) {
      if (mounted.current) setError(describeError(reason));
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  return (
    <Stack spacing={1}>
      <ActionButton
        variant="contained"
        startIcon={<Download />}
        onClick={download}
        disabled={!online || loading || starting || running}
        disabledReason={starting || running ? timingTexts.downloadPending : !online ? OFFLINE_MESSAGE : timingTexts.downloadCheckPending}
        sx={{ alignSelf: 'flex-start' }}
      >
        {loading ? timingTexts.checkingDownloads : starting || running ? timingTexts.downloading({ model }) : timingTexts.download({ model })}
      </ActionButton>
      <Typography variant="caption" color="text.secondary">
        {timingTexts.downloadHelp}
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {job?.status === 'failed' && <Alert severity="error">{timingTexts.downloadFailed}</Alert>}
      {job?.status === 'done' && <Alert severity="success">{timingTexts.downloadReady}</Alert>}
      {job && <JobStatus running={running} />}
    </Stack>
  );
}
