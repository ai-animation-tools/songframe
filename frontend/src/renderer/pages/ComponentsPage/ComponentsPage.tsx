import { useCallback, useEffect, useRef, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, LinearProgress, Paper, Snackbar, Stack, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import UndoIcon from '@mui/icons-material/Undo';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useLocation, useNavigate } from 'react-router-dom';
import type { ComponentsApi, InstallPackage, InstallSnapshot, Selection, Snapshot } from '@platform/components';
import { componentTexts as text } from '@shared/texts/components';
import { ActionButton } from '../../components/ActionButton';
import { PageActionBar } from '../../components/PageActionBar';
import { ComponentCard, componentNeedsDownload, formatBytes } from './components';

const activeStatuses = new Set(['downloading', 'verifying', 'extracting', 'installing']);
const describe = (error: unknown) => (error instanceof Error ? error.message : text.unknownError);

/** Ошибка действия отделяет короткое объяснение от раскрываемой диагностики, включая пути. */
interface ComponentProblem {
  message: string;
  details: string;
  source?: 'read' | 'action';
}

/** Страница только читает состояние автоматического менеджера: mount и polling не запускают probes.
 * Проверками при старте и после изменения компонентов владеет Go; уход со страницы их не отменяет.
 */
export function ComponentsPage({ api, defaultDirectory }: { api: ComponentsApi; defaultDirectory: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [packages, setPackages] = useState<InstallPackage[]>([]);
  const [installation, setInstallation] = useState<InstallSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ComponentProblem | null>(null);
  const [notice, setNotice] = useState('');
  const mounted = useRef(false),
    readSequence = useRef(0),
    actionSequence = useRef(0);
  const location = useLocation(),
    navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const operation = params.get('operation') ?? '';
  const returnTo = params.get('returnTo');
  const safeReturn = returnTo?.startsWith('/project/') && !returnTo.includes('://') ? returnTo : null;
  const active = activeStatuses.has(installation?.status ?? '');
  const blocked = busy || active || !!snapshot?.checking;
  const requested = snapshot?.operations.find((item) => item.id === operation);

  /** Чтение остаётся лёгким даже после remount; поздний poll не заменяет более новый снимок. */
  const read = useCallback(async () => {
    const sequence = ++readSequence.current;
    const [state, progress, catalog] = await Promise.all([api.state(), api.installation(), api.catalog()]);
    if (mounted.current && sequence === readSequence.current) {
      setSnapshot(state);
      setInstallation(progress);
      setPackages(catalog);
      setProblem((current) => (current?.source === 'read' ? null : current));
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    let reading = false;
    const update = () => {
      if (reading) return;
      reading = true;
      void read()
        .catch((reason: unknown) => {
          if (mounted.current) setProblem({ source: 'read', message: text.readFailed, details: describe(reason) });
        })
        .finally(() => {
          reading = false;
        });
    };
    update();
    const interval = setInterval(update, 750);
    return () => {
      mounted.current = false;
      readSequence.current++;
      actionSequence.current++;
      clearInterval(interval);
    };
  }, [read]);

  /** Успешное изменение запускает автоматическую проверку в сервисе, а UI лишь перечитывает состояние.
   * Ошибка остаётся в одном месте; отмена нативного выбора не считается выполненным действием.
   */
  async function run(action: () => Promise<unknown>, success?: string) {
    const sequence = ++actionSequence.current;
    setBusy(true);
    setProblem(null);
    setNotice('');
    try {
      const result = await action();
      if (mounted.current && sequence === actionSequence.current && result !== false && success) setNotice(success);
    } catch (reason) {
      if (mounted.current && sequence === actionSequence.current) setProblem({ source: 'action', message: text.actionFailed, details: describe(reason) });
    } finally {
      try {
        await read();
      } catch (reason) {
        if (mounted.current && sequence === actionSequence.current) setProblem({ source: 'read', message: text.readFailed, details: describe(reason) });
      }
      if (mounted.current && sequence === actionSequence.current) setBusy(false);
    }
  }
  /** Отмена не сбрасывает busy незавершённой установки и не выдаёт её за успешное скачивание. */
  async function stop(action: () => Promise<void>) {
    const sequence = actionSequence.current;
    try {
      await action();
      await read();
    } catch (reason) {
      if (mounted.current && sequence === actionSequence.current) setProblem({ message: text.cancelFailed, details: describe(reason) });
    }
  }
  /** Выбор меняет только настройки; принадлежавшие пользователю файлы не перемещаются и не удаляются. */
  async function configure(change: Partial<Selection>) {
    if (snapshot) await api.configure({ ...snapshot.selection, ...change });
  }
  /** Единый выбор принимает готовый файл или архив; определение содержимого принадлежит Go. */
  async function connect(component: string) {
    const result = await api.connect(component);
    if (!result) return false;
  }
  const visiblePackages = requested
    ? packages.filter(
        (item) => requested.requires.includes(item.component) && snapshot?.components.find((value) => value.id === item.component)?.status !== 'ready'
      )
    : packages;
  const downloadablePackages = visiblePackages.filter(
    (item) => item.supported && componentNeedsDownload(snapshot?.components.find((value) => value.id === item.component))
  );
  const displayedProblem = problem ?? (snapshot?.problem ? { message: text.profileProblem, details: snapshot.problem } : null);
  return (
    <Stack spacing={2}>
      <PageActionBar title={text.title}>
        {safeReturn && (
          <ActionButton startIcon={<ArrowBackIcon />} onClick={() => navigate(safeReturn)}>
            {text.return}
          </ActionButton>
        )}
      </PageActionBar>
      <Typography>{text.hint}</Typography>
      {safeReturn && <Alert severity="info">{text.returnHint}</Alert>}
      {snapshot?.checking && (
        <Alert severity="info">
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
            <Typography sx={{ flex: 1 }}>{text.checking}</Typography>
            <ActionButton startIcon={<StopCircleIcon />} onClick={() => void stop(() => api.cancel())}>
              {text.cancelCheck}
            </ActionButton>
          </Stack>
        </Alert>
      )}
      {requested && downloadablePackages.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1}>
            <Typography>
              {text.contextOperation}: {text.operations[operation] ?? operation}
            </Typography>
            <Typography variant="body2">{text.approximateSize(formatBytes(downloadablePackages.reduce((sum, item) => sum + item.bytes, 0)))}</Typography>
            <ActionButton
              variant="contained"
              startIcon={<DownloadIcon />}
              sx={{ alignSelf: 'flex-start' }}
              disabled={blocked || downloadablePackages.some((item) => !item.supported)}
              disabledReason={blocked ? text.working : text.unavailable}
              onClick={() => void run(() => api.download(downloadablePackages.map((item) => item.component)), text.installedNotice)}
            >
              {text.installMissing}
            </ActionButton>
          </Stack>
        </Paper>
      )}
      {displayedProblem && (
        <Alert severity="error" aria-label={text.result}>
          <Typography>{displayedProblem.message}</Typography>
          <Accordion disableGutters elevation={0} sx={{ bgcolor: 'transparent', '&:before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0 }}>
              <Typography variant="body2">{text.technicalDetails}</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 0 }}>
              <Box component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '0.8rem' }}>
                {displayedProblem.details}
              </Box>
            </AccordionDetails>
          </Accordion>
        </Alert>
      )}
      {!snapshot && (
        <Typography role="status" aria-label={text.loading}>
          {text.loading}
        </Typography>
      )}
      {installation && installation.status !== 'idle' && (
        <Paper component="section" variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1}>
            <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
              <Typography role="status" sx={{ flex: 1 }}>
                {text.statuses[installation.status] ?? installation.status}: {text.names[installation.component] ?? installation.component}
              </Typography>
              {active && (
                <ActionButton startIcon={<StopCircleIcon />} onClick={() => void stop(() => api.cancelInstall())}>
                  {text.cancelInstall}
                </ActionButton>
              )}
            </Stack>
            {active && (
              <LinearProgress
                aria-label={text.statuses[installation.status] ?? installation.status}
                variant={installation.totalBytes > 0 ? 'determinate' : 'indeterminate'}
                value={installation.totalBytes > 0 ? Math.min(100, (installation.completedBytes / installation.totalBytes) * 100) : undefined}
              />
            )}
            {active && installation.totalBytes > 0 && (
              <Typography variant="body2">
                {formatBytes(installation.completedBytes)} / {formatBytes(installation.totalBytes)}
              </Typography>
            )}
          </Stack>
        </Paper>
      )}
      {snapshot && visiblePackages.length === 0 && <Alert severity="info">{requested ? text.requiredReady : text.empty}</Alert>}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2, alignItems: 'start' }}>
        {visiblePackages.map((item) => (
          <ComponentCard
            key={item.component}
            item={item}
            state={snapshot?.components.find((value) => value.id === item.component)}
            busy={blocked}
            checking={!!snapshot?.checking}
            highlighted={requested?.requires.includes(item.component) ?? false}
            onDownload={() => void run(() => api.download([item.component]), text.installedNotice)}
            onConnect={() => void run(() => connect(item.component), text.connectedNotice)}
          />
        ))}
      </Box>
      {snapshot && (
        <Accordion elevation={0} sx={{ border: 1, borderColor: 'divider', '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography fontWeight={600}>{text.storageTitle}</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Stack spacing={1.5} sx={{ mt: 2 }}>
              <Typography>{text.storageHint}</Typography>
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {snapshot.selection.managedDirectory || defaultDirectory}
              </Typography>
              <Stack direction="row" gap={1} flexWrap="wrap">
                <ActionButton
                  startIcon={<FolderOpenIcon />}
                  disabled={blocked}
                  disabledReason={text.working}
                  onClick={() =>
                    void run(async () => {
                      const directory = await api.chooseDirectory();
                      if (!directory) return false;
                      await configure({ managedDirectory: directory });
                    }, text.selectionSaved)
                  }
                >
                  {text.changeStorage}
                </ActionButton>
                {snapshot.selection.managedDirectory && (
                  <ActionButton
                    startIcon={<UndoIcon />}
                    disabled={blocked}
                    disabledReason={text.working}
                    onClick={() => void run(() => configure({ managedDirectory: '' }), text.selectionSaved)}
                  >
                    {text.defaultFolder}
                  </ActionButton>
                )}
              </Stack>
            </Stack>
          </AccordionDetails>
        </Accordion>
      )}
      <Accordion elevation={0} sx={{ border: 1, borderColor: 'divider', '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography fontWeight={600}>{text.journalTitle}</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Box component="pre" sx={{ m: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '0.8rem' }}>
            {installation?.log.length ? installation.log.map((entry) => `${entry.time} ${entry.message}`).join('\n') : text.noLog}
          </Box>
        </AccordionDetails>
      </Accordion>
      <Snackbar
        open={!!notice}
        autoHideDuration={6000}
        onClose={(_, reason) => {
          if (reason !== 'clickaway') setNotice('');
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" onClose={() => setNotice('')}>
          {notice}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
