import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import { Refresh } from '@mui/icons-material';
import { ActionButton } from '../../../components/ActionButton';
import type { JobInfo } from '@shared/types';
import { WHISPER_MODELS, type WhisperSetup } from '@shared/whisper-models';
import { songTimingTexts as texts } from '@shared/texts/song-timing';
import { useApp } from '../../../state';
import { WhisperModelDownload } from './WhisperModelDownload';

interface Props {
  path: string;
  disabled: boolean;
  onPathChange(path: string): void;
  onReady(ready: boolean): void;
  onJob(job: JobInfo | null): void;
  onBusy(busy: boolean): void;
}

/** Готовность видна при свёрнутых настройках; после загрузки проверяем комплект файлов заново. */
export function WhisperReadiness({ path, disabled, onPathChange, onReady, onJob, onBusy }: Props): ReactElement {
  const { describeError } = useApp();
  const [setup, setSetup] = useState<WhisperSetup | null>(null);
  const [error, setError] = useState('');
  const [inspection, setInspection] = useState<{ installed: boolean; missing: string[] } | null>(null);
  const [checking, setChecking] = useState(true);
  const [revision, setRevision] = useState(0);
  const [downloadedPath, setDownloadedPath] = useState('');
  useEffect(() => {
    let active = true;
    const requestedPath = path.trim();
    onReady(false);
    setSetup(null);
    setInspection(null);
    setChecking(true);
    setError('');
    const read = async (): Promise<void> => {
      try {
        if (typeof window.api.timing.modelSetup !== 'function') throw new Error(texts.restart);
        const value = await window.api.timing.modelSetup();
        const checkedModel = WHISPER_MODELS.find((item) => value.directories[item.id] === requestedPath)?.id ?? (!requestedPath ? value.recommended : null);
        // Папка вне управляемого каталога проверяется по реальным файлам: непустого пути недостаточно.
        if (!checkedModel && typeof window.api.timing.inspectModel !== 'function') throw new Error(texts.restart);
        const checked = checkedModel ? { installed: value.installed[checkedModel], missing: [] } : await window.api.timing.inspectModel(requestedPath);
        if (!active) return;
        setSetup(value);
        setInspection(checked);
        onReady(checked.installed);
      } catch (reason) {
        if (active) setError(describeError(reason));
      } finally {
        if (active) setChecking(false);
      }
    };
    void read();
    return () => {
      active = false;
      onReady(false);
    };
  }, [revision, path, describeError, onReady]);
  const requestedPath = path.trim();
  const model = setup ? (WHISPER_MODELS.find((item) => setup.directories[item.id] === requestedPath)?.id ?? (!requestedPath ? setup.recommended : null)) : null;
  const installed = inspection?.installed === true;
  const downloaded = useCallback(
    (directory: string) => {
      setDownloadedPath(directory);
      onPathChange(directory);
      setRevision((value) => value + 1);
    },
    [onPathChange]
  );
  return (
    <Stack spacing={1}>
      <Typography variant="body2">
        {checking
          ? texts.checkingWhisper
          : model
            ? installed
              ? texts.whisperReady({ model })
              : texts.whisperMissing({ model })
            : installed
              ? texts.whisperCustomReady
              : texts.whisperCustomMissing}
      </Typography>
      {!checking && inspection && !model && !installed && (
        <Alert severity="warning">{texts.whisperMissingFiles({ files: inspection.missing.join(', ') })}</Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {(error || (!checking && !installed)) && (
        <ActionButton
          startIcon={<Refresh />}
          disabled={disabled}
          disabledReason={texts.operationPending}
          sx={{ alignSelf: 'flex-start' }}
          onClick={() => setRevision((value) => value + 1)}
        >
          {texts.retryRead}
        </ActionButton>
      )}
      {!checking && setup && !!downloadedPath && downloadedPath === requestedPath && !installed && <Alert severity="error">{texts.modelsNotInstalled}</Alert>}
      {setup && model && !installed && (
        <WhisperModelDownload key={model} model={model} onDownloaded={downloaded} disabled={disabled} managedProgress onJob={onJob} onBusy={onBusy} />
      )}
    </Stack>
  );
}
