import { useApp } from '../../../state';
import { songTimingTexts as texts } from '@shared/texts/song-timing';
import type { JobInfo } from '@shared/types';
import { TimingJobProgress } from './TimingJobProgress';
import { JobStatus } from '../../../components/JobStatus';
import { SongModelSetup } from './SongModelSetup';
import { VocalPreparation } from './VocalPreparation';
import { timingTexts } from '@shared/texts/timing';
import { commonTexts } from '@shared/texts/common';
import { CancelOutlined, PlayArrow, Stop, ExpandMore, Refresh } from '@mui/icons-material';
import { useState, useEffect, type ReactElement } from 'react';
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Alert,
  Box,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Radio,
  RadioGroup,
  FormControl,
  FormLabel,
  Stack,
  TextField
} from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import { WhisperModelSetup } from './WhisperModelSetup';
import { WhisperReadiness } from './WhisperReadiness';

interface TimingGenerateDialogProps {
  project: string;
  open: boolean;
  model: string;
  vocals: boolean;
  job: JobInfo | null;
  working: boolean;
  error: string | null;
  resultReady?: boolean;
  onReloadResult?: () => void;
  onVocalsChange(vocals: boolean): void;
  onStop(): Promise<boolean>;
  onCancelDownload(id: string): Promise<void>;
  device: 'auto' | 'cpu';
  resetAll: boolean;
  canGenerate: boolean;
  /** Почему запуск сейчас недоступен; показывается в подсказке кнопки. */
  generateBlockedReason: string | null;
  onClose: () => void;
  onModelChange: (model: string) => void;
  onDeviceChange: (device: 'auto' | 'cpu') => void;
  onResetChange: (reset: boolean) => void;
  onGenerate: () => void;
}

/** Модель настраивается отдельно; диалог собирает параметры локального распознавания. */
export function TimingGenerateDialog({
  project,
  open,
  model,
  vocals,
  job,
  working,
  error,
  resultReady = false,
  onReloadResult,
  onVocalsChange,
  onStop,
  onCancelDownload,
  device,
  resetAll,
  canGenerate,
  generateBlockedReason,
  onClose,
  onModelChange,
  onDeviceChange,
  onResetChange,
  onGenerate
}: TimingGenerateDialogProps): ReactElement {
  const { describeError } = useApp();
  const [closeError, setCloseError] = useState('');
  const [songReady, setSongReady] = useState(false);
  const [vocalReady, setVocalReady] = useState(false);
  const [whisperReady, setWhisperReady] = useState(false);
  const [vocalJob, setVocalJob] = useState<JobInfo | null>(null);
  const [vocalWorking, setVocalWorking] = useState(false);
  const [download, setDownload] = useState<JobInfo | null>(null);
  const [whisperDownload, setWhisperDownload] = useState<JobInfo | null>(null);
  const [whisperWorking, setWhisperWorking] = useState(false);
  const [closing, setClosing] = useState(false);
  const [downloadWorking, setDownloadWorking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (open) {
      setCloseError('');
      setSettingsOpen(false);
    }
  }, [open]);
  const running = job?.status === 'running';
  const activeJob = running ? job : [vocalJob, download, whisperDownload].find((item) => item?.status === 'running');
  const pending = working || closing || downloadWorking || vocalWorking || whisperWorking;
  const processing = !!activeJob || working || closing;
  const apiReady = typeof window.api.timing.start === 'function';
  const stop = async (closeAfter: boolean): Promise<void> => {
    if (pending) return;
    setCloseError('');
    setClosing(true);
    try {
      // Каждое отменённое задание должно действительно завершиться до закрытия окна.
      for (const current of [vocalJob, download, whisperDownload]) {
        if (current?.status === 'running') await onCancelDownload(current.id);
      }
      if (running && !(await onStop())) return;
      if (closeAfter) onClose();
    } catch (reason) {
      setCloseError(describeError(reason));
    } finally {
      setClosing(false);
    }
  };
  const progressLabel =
    activeJob === job
      ? vocals
        ? texts.running
        : texts.basicRunning
      : activeJob === vocalJob
        ? vocalJob?.kind === 'model_download'
          ? texts.downloadingVocal
          : texts.separating
        : activeJob === download
          ? texts.downloadingAlignment
          : texts.download;
  const generateReason = !apiReady
    ? texts.restart
    : pending || activeJob
      ? texts.operationPending
      : !whisperReady
        ? texts.whisperNotReady
        : vocals && (!songReady || !vocalReady)
          ? texts.missing
          : generateBlockedReason;
  return (
    <Dialog open={open} disableEscapeKeyDown maxWidth="sm" fullWidth>
      <DialogTitle>{timingTexts.generateTitle}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Alert severity="info">{texts.recognitionNotice}</Alert>
          {!apiReady && <Alert severity="warning">{texts.restart}</Alert>}
          {activeJob && <TimingJobProgress key={activeJob.id} job={activeJob} label={progressLabel} name={texts.progress} />}
          {working && !activeJob && (
            <Box role="status">
              <JobStatus running label={job?.status === 'done' ? texts.readingResult : texts.startingRecognition} />
            </Box>
          )}
          {job?.status === 'done' && resultReady && !error && <Alert severity="success">{texts.ready}</Alert>}
          {(job?.status === 'failed' || job?.status === 'interrupted') && (
            <Alert severity={job.error === texts.cancelled ? 'info' : 'error'}>{job.error || texts.noJob}</Alert>
          )}
          {!activeJob && job && <TimingJobProgress key={job.id} job={job} label={progressLabel} name={texts.progress} />}
          {error && <Alert severity="error">{error}</Alert>}
          {closeError && <Alert severity="error">{closeError}</Alert>}
          {/* Формы остаются смонтированы для наблюдения Jobs, но во время операции виден один рабочий статус. */}
          <Stack spacing={2} sx={{ display: processing ? 'none' : undefined }}>
            <FormControl disabled={pending}>
              <FormLabel id="timing-source-label">{texts.mode}</FormLabel>
              <RadioGroup
                aria-labelledby="timing-source-label"
                value={vocals ? 'vocals' : 'basic'}
                onChange={(event) => onVocalsChange(event.target.value === 'vocals')}
              >
                <FormControlLabel value="basic" control={<Radio />} label={texts.basic} />
                <FormControlLabel value="vocals" control={<Radio />} label={texts.vocals} />
              </RadioGroup>
            </FormControl>
            {open && (
              <WhisperReadiness
                path={model}
                disabled={pending || !!activeJob}
                onPathChange={onModelChange}
                onReady={setWhisperReady}
                onJob={setWhisperDownload}
                onBusy={setWhisperWorking}
              />
            )}
            {open && vocals && (
              <VocalPreparation
                key={project}
                project={project}
                disabled={working || running || closing}
                managedProgress
                onReady={setVocalReady}
                onJob={setVocalJob}
                onBusy={setVocalWorking}
              />
            )}
            {open && vocals && (
              <SongModelSetup disabled={pending || !!activeJob} managedProgress onReady={setSongReady} onJob={setDownload} onBusy={setDownloadWorking} />
            )}
            <Accordion expanded={settingsOpen} onChange={(_event, expanded) => setSettingsOpen(expanded)} disableGutters>
              <AccordionSummary expandIcon={<ExpandMore />}>{texts.whisperSettings}</AccordionSummary>
              <AccordionDetails>
                <Stack spacing={2} inert={pending || !!activeJob || undefined}>
                  {open && <WhisperModelSetup path={model} onPathChange={onModelChange} showDownload={false} />}
                  <TextField
                    select
                    label={timingTexts.processing}
                    value={device}
                    onChange={(event) => onDeviceChange(event.target.value as 'auto' | 'cpu')}
                    helperText={timingTexts.processingHint}
                  >
                    <MenuItem value="auto">{timingTexts.automaticDevice}</MenuItem>
                    <MenuItem value="cpu">{timingTexts.cpuOnly}</MenuItem>
                  </TextField>
                  <FormControlLabel
                    control={<Checkbox checked={resetAll} onChange={(event) => onResetChange(event.target.checked)} />}
                    label={timingTexts.resetAll}
                  />
                </Stack>
              </AccordionDetails>
            </Accordion>
            {resetAll && <Alert severity="warning">{texts.resetWarning}</Alert>}
            <Alert severity="warning">{texts.recalculateHint}</Alert>
          </Stack>
          {processing && <Alert severity="info">{texts.cancelHint}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ p: 2, gap: 1, flexWrap: 'wrap' }}>
        <ActionButton startIcon={<CancelOutlined />} disabled={pending} disabledReason={texts.operationPending} onClick={() => void stop(true)}>
          {commonTexts.cancel}
        </ActionButton>
        <Box sx={{ flexGrow: 1 }} />
        {activeJob && (
          <ActionButton startIcon={<Stop />} disabled={pending} disabledReason={texts.operationPending} onClick={() => void stop(false)}>
            {commonTexts.stop}
          </ActionButton>
        )}
        {job?.status === 'done' && error && onReloadResult && (
          <ActionButton startIcon={<Refresh />} disabled={pending} disabledReason={texts.operationPending} onClick={onReloadResult}>
            {texts.reloadResult}
          </ActionButton>
        )}
        <ActionButton
          startIcon={<PlayArrow />}
          variant="contained"
          color={resetAll ? 'error' : 'primary'}
          onClick={onGenerate}
          disabled={!canGenerate || !!generateReason}
          disabledReason={generateReason}
        >
          {commonTexts.run}
        </ActionButton>
      </DialogActions>
    </Dialog>
  );
}
