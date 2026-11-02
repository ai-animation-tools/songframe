/** Дополнительные модели ставятся явной кнопкой; повторное открытие продолжает наблюдение Jobs. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Stack } from '@mui/material';
import { Download, Refresh } from '@mui/icons-material';
import type { JobInfo } from '@shared/types';
import type { SongModelSetup as Setup } from '@shared/song-models';
import { SONG_MODEL_ID } from '@shared/song-models';
import { songTimingTexts as texts } from '@shared/texts/song-timing';
import { ActionButton } from '../../../components/ActionButton';
import { TimingJobProgress } from './TimingJobProgress';
import { useApp } from '../../../state';

interface Props {
  disabled?: boolean;
  managedProgress?: boolean;
  onReady(ready: boolean): void;
  onJob(job: JobInfo | null): void;
  onBusy?(busy: boolean): void;
}
export function SongModelSetup({ disabled = false, managedProgress = false, onReady, onJob, onBusy }: Props): ReactElement {
  const { describeError, online } = useApp();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(true);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onReady(false);
      onJob(null);
      onBusy?.(false);
    };
  }, [onReady, onJob, onBusy]);
  useEffect(() => {
    let active = true;
    setReading(true);
    onReady(false);
    if (typeof window.api.timing.songModelSetup !== 'function' || typeof window.api.timing.downloadSongModels !== 'function') {
      setError(texts.restart);
      setReading(false);
      return;
    }
    void Promise.all([window.api.timing.songModelSetup(), window.api.jobs.list()])
      .then(([value, jobs]) => {
        if (!active) return;
        setSetup(value);
        onReady(value.installed);
        // Терминальную ошибку сохраняем и после обновления/повторного открытия, пока комплект отсутствует.
        const current = jobs.find((item) => item.modelDownload?.model === SONG_MODEL_ID) ?? null;
        setJob(current);
        onJob(current);
        setError(
          !value.installed && current?.status === 'done'
            ? texts.modelsNotInstalled
            : !value.installed && (current?.status === 'failed' || current?.status === 'interrupted')
              ? current.error || texts.modelJobMissing
              : ''
        );
      })
      .catch((reason) => {
        if (active) setError(describeError(reason));
      })
      .finally(() => {
        if (active) setReading(false);
      });
    return () => {
      active = false;
    };
  }, [revision, describeError, onReady, onJob]);
  useEffect(() => {
    if (job?.status !== 'running') return;
    let active = true,
      polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void window.api.jobs
        .get(job.id)
        .then((next) => {
          if (!active) return;
          setJob(next);
          onJob(next);
          if (!next) setError(texts.modelJobMissing);
          else if (next.status === 'done') setRevision((value) => value + 1);
          else if (next.status === 'failed' || next.status === 'interrupted') setError(next.error || texts.modelJobMissing);
          else setError('');
        })
        .catch((reason) => {
          if (active) setError(describeError(reason));
        })
        .finally(() => {
          polling = false;
        });
    }, 750);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [job?.id, job?.status, describeError, onJob]);
  const download = async (): Promise<void> => {
    if (busy || reading || disabled) return;
    setBusy(true);
    onBusy?.(true);
    setError('');
    try {
      const next = await window.api.timing.downloadSongModels();
      if (!mounted.current) return;
      setJob(next);
      onJob(next);
      if (next.status !== 'running') setRevision((value) => value + 1);
    } catch (reason) {
      if (mounted.current) setError(describeError(reason));
    } finally {
      if (mounted.current) {
        setBusy(false);
        onBusy?.(false);
      }
    }
  };
  return (
    <Stack spacing={1}>
      <Alert severity={!reading && setup?.installed ? 'success' : 'info'}>
        {reading ? texts.checking : setup?.installed ? texts.installed : texts.installHelp}
      </Alert>
      {!setup?.installed && (
        <ActionButton
          startIcon={<Download />}
          variant="outlined"
          sx={{ alignSelf: 'flex-start' }}
          disabled={!online || busy || reading || disabled || job?.status === 'running' || !setup}
          disabledReason={!online ? texts.noNetwork : texts.operationPending}
          onClick={() => void download()}
        >
          {texts.install}
        </ActionButton>
      )}
      {job && !managedProgress && <TimingJobProgress key={job.id} job={job} label={texts.downloadingAlignment} name={texts.download} />}
      {error && <Alert severity="error">{error}</Alert>}
      {error && (
        <ActionButton
          startIcon={<Refresh />}
          disabled={busy || reading || disabled}
          disabledReason={texts.operationPending}
          sx={{ alignSelf: 'flex-start' }}
          onClick={() => setRevision((value) => value + 1)}
        >
          {texts.retryRead}
        </ActionButton>
      )}
    </Stack>
  );
}
