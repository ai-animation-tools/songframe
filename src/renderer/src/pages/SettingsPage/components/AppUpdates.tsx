/** Обновление по кнопке: renderer видит только состояние, адрес пакета и путь к файлу остаются в main. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, LinearProgress, Link, Paper, Stack, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import InstallDesktopIcon from '@mui/icons-material/InstallDesktop';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import RefreshIcon from '@mui/icons-material/Refresh';
import { commonTexts } from '@shared/texts/common';
import { updatesTexts } from '@shared/texts/updates';
import type { UpdateView } from '@shared/updates';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { useApp } from '../../../state';

type Action = 'check' | 'download' | 'install';

export function AppUpdates(): ReactElement {
  const { online } = useApp();
  const [view, setView] = useState<UpdateView | null>(null);
  const [running, setRunning] = useState<Action | null>(null);
  const [confirm, setConfirm] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    // Состояние живёт в main: после перехода между страницами скачивание и найденная версия не теряются.
    void window.api.updates.view().then(setView);
    return () => clearInterval(poll.current);
  }, []);

  async function run(action: Action): Promise<void> {
    setRunning(action);
    if (action === 'download') poll.current = setInterval(() => void window.api.updates.view().then(setView), 500);
    try {
      setView(await window.api.updates[action]());
    } finally {
      clearInterval(poll.current);
      setRunning(null);
    }
  }

  const status = view?.status;
  const downloading = status === 'downloading' || running === 'download';
  const canDownload = !!view?.version && (status === 'available' || (status === 'error' && running === null));
  const busyReason = running || downloading ? commonTexts.waitForCurrentOperation : null;
  const networkReason = online ? busyReason : updatesTexts.offline;
  const percent = Math.floor((view?.progress ?? 0) * 100);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography fontWeight={600}>{updatesTexts.title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {updatesTexts.description}
        </Typography>
        {view && <Typography variant="body2">{updatesTexts.currentVersion({ version: view.currentVersion })}</Typography>}
        {view?.message && status !== 'downloading' && (
          <Alert severity={status === 'error' ? 'error' : status === 'current' ? 'success' : 'info'}>{view.message}</Alert>
        )}
        {view?.releaseUrl && status !== 'current' && (
          <Link
            href={view.releaseUrl}
            target="_blank"
            rel="noreferrer"
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, alignSelf: 'flex-start' }}
          >
            {updatesTexts.releaseNotes}
            <OpenInNewIcon fontSize="inherit" aria-hidden="true" />
          </Link>
        )}
        {downloading && (
          <Stack spacing={0.5}>
            <LinearProgress variant="determinate" value={percent} aria-label={updatesTexts.downloading} />
            <Typography variant="body2" color="text.secondary" role="status">
              {updatesTexts.progress({ percent })}
            </Typography>
          </Stack>
        )}
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <ActionButton
            variant={canDownload || status === 'ready' ? 'text' : 'contained'}
            startIcon={<RefreshIcon />}
            onClick={() => void run('check')}
            disabled={!online || !!running || downloading}
            disabledReason={networkReason}
          >
            {running === 'check' ? updatesTexts.checking : updatesTexts.check}
          </ActionButton>
          {(canDownload || downloading) && (
            <ActionButton
              variant="contained"
              startIcon={<DownloadIcon />}
              onClick={() => void run('download')}
              disabled={!online || !!running || downloading}
              disabledReason={networkReason}
            >
              {downloading ? updatesTexts.downloading : updatesTexts.download}
            </ActionButton>
          )}
          {status === 'ready' && (
            <ActionButton
              variant="contained"
              startIcon={view?.installable ? <InstallDesktopIcon /> : <FolderOpenIcon />}
              onClick={() => (view?.installable ? setConfirm(true) : void run('install'))}
              disabled={!!running}
              disabledReason={busyReason}
            >
              {view?.installable ? updatesTexts.install : updatesTexts.reveal}
            </ActionButton>
          )}
        </Stack>
      </Stack>
      <ConfirmationDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={updatesTexts.confirmTitle}
        onConfirm={() => {
          setConfirm(false);
          void run('install');
        }}
        confirmLabel={updatesTexts.install}
        confirmIcon={<InstallDesktopIcon />}
      >
        <Typography variant="body2">{updatesTexts.confirmText({ version: view?.version ?? '' })}</Typography>
      </ConfirmationDialog>
    </Paper>
  );
}
