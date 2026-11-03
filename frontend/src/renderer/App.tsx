import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertTitle, Box, Snackbar, Stack, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import RefreshIcon from '@mui/icons-material/Refresh';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AppState } from '@shared/types';
import type { MediaFile, ProjectSnapshot } from '@shared/workspace';
import { shellTexts } from '@shared/texts/shell';
import { workspaceTexts as text } from '@shared/texts/workspace';
import { signalFrontendReady } from '@platform/api';
import { workspaceBridge, type WorkspaceBridge } from '@platform/workspace';
import { ActionButton } from './components/ActionButton';
import { ShellLayout } from './components/ShellLayout';
import { RenderBoundary } from './components/RenderBoundary';
import { ReadyContent } from './components/ReadyContent';
import { StartupProgress } from './components/StartupProgress';
import { ProjectsPage } from './pages';
import { TimingPage } from './pages/TimingPage';
import { PreviewPage } from './pages/PreviewPage';
import { NAV_PAGES } from './navigation';

const NativeCheckPage = lazy(() => import('./pages/NativeCheckPage').then((module) => ({ default: module.NativeCheckPage })));
export interface AppProps {
  /** Чтение Go-снимка; истории передают локальную модель вместо настоящего транспорта. */
  loadState?: () => Promise<AppState>;
  /** Подтверждение готовности оболочки отделено от отдельного окна и нативной медиапроверки. */
  onReady?: () => Promise<void>;
  /** Подменяется целиком в Storybook: реальный профиль, диалоги и Wails не запускаются. */
  bridge?: WorkspaceBridge;
}
const readState = () => window.api.app.state();
type Startup = { phase: 'loading' } | { phase: 'error'; error: string } | { phase: 'ready'; state: AppState };
const describe = (error: unknown) => (error instanceof Error ? error.message : text.unknownError);

/** Отдельные окна не запускают жизненный цикл главного окна и не подписываются на смену его проекта. */
export function App(props: AppProps) {
  const { pathname } = useLocation();
  const bridge = props.bridge ?? workspaceBridge;
  const report = useCallback(
    (error: unknown) => {
      void bridge
        .reportError({ kind: 'error', message: describe(error), source: pathname, stack: error instanceof Error ? error.stack : undefined })
        .catch((reason) => console.error(reason));
    },
    [bridge, pathname]
  );
  // Слушатели принадлежат каждому renderer, включая отдельный просмотр; смена маршрута не умножает их.
  useEffect(() => {
    const error = (event: ErrorEvent) => report(event.error ?? new Error(event.message));
    const rejection = (event: PromiseRejectionEvent) => {
      void bridge
        .reportError({
          kind: 'unhandledrejection',
          message: describe(event.reason),
          source: pathname,
          stack: event.reason instanceof Error ? event.reason.stack : undefined
        })
        .catch((reason) => console.error(reason));
    };
    window.addEventListener('error', error);
    window.addEventListener('unhandledrejection', rejection);
    return () => {
      window.removeEventListener('error', error);
      window.removeEventListener('unhandledrejection', rejection);
    };
  }, [bridge, pathname, report]);
  if (pathname === '/native-check')
    return (
      <Suspense fallback={<StartupProgress />}>
        <NativeCheckPage />
      </Suspense>
    );
  if (pathname === '/preview')
    return (
      <RenderBoundary onError={report}>
        <PreviewPage bridge={bridge} />
      </RenderBoundary>
    );
  return <Workspace {...props} />;
}

/** Владелец открытого read-only снимка. Номер запроса защищает от позднего ответа при смене проекта,
 * закрытии и unmount; переход из уведомления происходит только после успешного чтения его проекта.
 */
function Workspace({ loadState = readState, onReady = signalFrontendReady, bridge = workspaceBridge }: AppProps) {
  const [startup, setStartup] = useState<Startup>({ phase: 'loading' });
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [media, setMedia] = useState<MediaFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<{ path: string; name: string }[]>([]);
  const [notice, setNotice] = useState<{ message: string; severity: 'error' | 'success' | 'warning' } | null>(null);
  const startupSequence = useRef(0),
    projectSequence = useRef(0),
    mediaSequence = useRef(0);
  const location = useLocation(),
    navigate = useNavigate();
  const showError = useCallback((error: unknown) => setNotice({ message: describe(error), severity: 'error' }), []);
  const reportError = useCallback(
    (error: unknown) => {
      void bridge
        .reportError({ kind: 'error', message: describe(error), source: location.pathname, stack: error instanceof Error ? error.stack : undefined })
        .catch((reason) => console.error(reason));
    },
    [bridge, location.pathname]
  );
  const load = useCallback(() => {
    const id = ++startupSequence.current;
    setStartup({ phase: 'loading' });
    void Promise.resolve()
      .then(loadState)
      .then(
        (state) => {
          if (id === startupSequence.current) setStartup({ phase: 'ready', state });
        },
        (error) => {
          if (id === startupSequence.current) setStartup({ phase: 'error', error: describe(error) });
        }
      );
  }, [loadState]);
  useEffect(() => {
    load();
    return () => {
      startupSequence.current++;
      projectSequence.current++;
      mediaSequence.current++;
    };
  }, [load]);
  useEffect(() => {
    if (startup.phase !== 'ready') return;
    let disposed = false;
    void bridge.crashNotice().then(
      (value) => {
        if (!disposed && value?.crashed) setNotice({ message: text.previousCrash, severity: 'warning' });
      },
      (error) => {
        if (!disposed) showError(error);
      }
    );
    return () => {
      disposed = true;
    };
  }, [bridge, showError, startup.phase]);
  const openProject = useCallback(
    async (path: string, route = '/project/timing') => {
      const id = ++projectSequence.current;
      mediaSequence.current++;
      setBusy(true);
      try {
        const snapshot = await bridge.openProject(path);
        if (id !== projectSequence.current) return;
        // Чтение медиа из прежней страницы могло начаться уже во время ожидания нового проекта.
        mediaSequence.current++;
        setProject(snapshot);
        setMedia(snapshot.track);
        setRecent((previous) => [{ path: snapshot.path, name: snapshot.name }, ...previous.filter((item) => item.path !== snapshot.path)]);
        navigate(route);
        setNotice({ message: text.projectOpened(snapshot.name), severity: 'success' });
      } catch (error) {
        if (id === projectSequence.current) showError(error);
      } finally {
        if (id === projectSequence.current) setBusy(false);
      }
    },
    [bridge, navigate, showError]
  );
  const selectMedia = useCallback(
    async (path: string) => {
      const id = ++mediaSequence.current;
      try {
        const value = await bridge.media(path);
        if (id === mediaSequence.current) setMedia(value);
      } catch (error) {
        if (id === mediaSequence.current) showError(error);
      }
    },
    [bridge, showError]
  );
  useEffect(() => {
    const drop = bridge.onFilesDropped((event) => {
      if (event.paths.length !== 1) {
        showError(new Error(text.oneFile));
        return;
      }
      if (event.targetID === 'project-drop') void openProject(event.paths[0]);
      else if (event.targetID === 'media-drop') void selectMedia(event.paths[0]);
    }, showError);
    const notification = bridge.onNotification((target) => {
      void openProject(target.project, target.route);
    }, showError);
    return () => {
      drop();
      notification();
    };
  }, [bridge, openProject, selectMedia, showError]);
  async function pickProject() {
    try {
      const path = await bridge.pickFolder({ title: text.openFolder });
      if (path) await openProject(path);
    } catch (error) {
      showError(error);
    }
  }
  async function pickMedia() {
    try {
      const paths = await bridge.pickFiles({
        title: text.selectMedia,
        filters: [{ name: text.mediaFilter, extensions: ['wav', 'mp3', 'mp4', 'webm'] }],
        multiple: false
      });
      if (paths.length) await selectMedia(paths[0]);
    } catch (error) {
      showError(error);
    }
  }
  function closeProject() {
    projectSequence.current++;
    mediaSequence.current++;
    setProject(null);
    setMedia(null);
    setBusy(false);
    navigate('/projects');
  }
  async function saveReport() {
    try {
      const path = await bridge.saveReport();
      if (path) setNotice({ message: text.diagnosticsSaved(path), severity: 'success' });
    } catch (error) {
      showError(error);
    }
  }
  const readinessFailed = useCallback((error: unknown) => setStartup({ phase: 'error', error: describe(error) }), []);
  const page = NAV_PAGES.find((item) => item.to === location.pathname);
  const projects = location.pathname === '/projects' || location.pathname === '/';
  return (
    <ShellLayout projectName={project?.name}>
      <RenderBoundary onError={reportError}>
        {startup.phase === 'loading' && <StartupProgress />}
        {startup.phase === 'error' && (
          <Alert severity="error">
            <AlertTitle>{shellTexts.startupError}</AlertTitle>
            {startup.error}
            <Box sx={{ mt: 2 }}>
              <ActionButton variant="outlined" startIcon={<RefreshIcon />} onClick={load}>
                {shellTexts.retry}
              </ActionButton>
            </Box>
          </Alert>
        )}
        {startup.phase === 'ready' && (
          <ReadyContent onReady={onReady} onError={readinessFailed}>
            {projects ? (
              <ProjectsPage state={startup.state} busy={busy} recent={recent} onPick={() => void pickProject()} onOpen={(path) => void openProject(path)} />
            ) : location.pathname === '/project/timing' && project ? (
              <TimingPage
                key={project.path}
                snapshot={project}
                media={media}
                bridge={bridge}
                busy={busy}
                onRefresh={() => void openProject(project.path)}
                onClose={closeProject}
                onPickMedia={() => void pickMedia()}
              />
            ) : (
              <Stack spacing={2}>
                <Typography variant="h5" component="h1">
                  {page?.label ?? shellTexts.missingPage}
                </Typography>
                <Alert severity="info">{location.pathname === '/project/timing' ? text.projectRequired : shellTexts.unavailable}</Alert>
                <Box>
                  <ActionButton startIcon={<FolderOpenIcon />} onClick={() => navigate('/projects')}>
                    {shellTexts.returnProjects}
                  </ActionButton>
                </Box>
              </Stack>
            )}
            <Box sx={{ mt: 3 }}>
              <ActionButton startIcon={<DownloadIcon />} onClick={() => void saveReport()}>
                {text.diagnostics}
              </ActionButton>
            </Box>
          </ReadyContent>
        )}
      </RenderBoundary>
      <Snackbar
        open={!!notice}
        autoHideDuration={notice?.severity === 'success' ? 6000 : null}
        onClose={(_, reason) => {
          if (reason !== 'clickaway') setNotice(null);
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={notice?.severity ?? 'success'} onClose={() => setNotice(null)} sx={{ maxWidth: 900, overflowWrap: 'anywhere' }}>
          {notice?.message}
        </Alert>
      </Snackbar>
    </ShellLayout>
  );
}
