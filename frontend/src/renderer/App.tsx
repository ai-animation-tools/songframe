import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertTitle, Box, Stack, Typography } from '@mui/material';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AppState } from '@shared/types';
import { shellTexts } from '@shared/texts/shell';
import { signalFrontendReady } from '@platform/api';
import { ActionButton } from './components/ActionButton';
import { ShellLayout } from './components/ShellLayout';
import { RenderBoundary } from './components/RenderBoundary';
import { ReadyContent } from './components/ReadyContent';
import { StartupProgress } from './components/StartupProgress';
import { ProjectsPage } from './pages';
import { NAV_PAGES } from './navigation';

export interface AppProps {
  /** Чтение Go-снимка; истории передают локальную модель вместо настоящего транспорта. */
  loadState?: () => Promise<AppState>;
  /** Сообщение о смонтированном UI после чтения состояния; используется также нативной smoke-проверкой. */
  onReady?: () => Promise<void>;
}
const readState = () => window.api.app.state();
type Startup = { phase: 'loading' } | { phase: 'error'; error: string } | { phase: 'ready'; state: AppState };

/** Владелец только жизненного цикла старта: поздний ответ после повторного чтения или unmount отбрасывается.
 * Проектные страницы подключаются позже без неявного запуска отсутствующих доменных методов.
 */
export function App({ loadState = readState, onReady = signalFrontendReady }: AppProps) {
  const [startup, setStartup] = useState<Startup>({ phase: 'loading' });
  const sequence = useRef(0);
  const location = useLocation();
  const navigate = useNavigate();
  const load = useCallback(() => {
    const id = ++sequence.current;
    setStartup({ phase: 'loading' });
    void Promise.resolve()
      .then(loadState)
      .then(
        (state) => {
          if (id === sequence.current) setStartup({ phase: 'ready', state });
        },
        (error: unknown) => {
          if (id === sequence.current) setStartup({ phase: 'error', error: error instanceof Error ? error.message : shellTexts.unknownError });
        }
      );
  }, [loadState]);
  useEffect(() => {
    load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);
  const readinessFailed = useCallback((error: unknown) => {
    setStartup({ phase: 'error', error: error instanceof Error ? error.message : shellTexts.unknownError });
  }, []);
  const page = NAV_PAGES.find((item) => item.to === location.pathname);
  const projects = location.pathname === '/projects' || location.pathname === '/';
  return (
    <ShellLayout>
      <RenderBoundary>
        {startup.phase === 'loading' && <StartupProgress />}
        {startup.phase === 'error' && (
          <Alert severity="error">
            <AlertTitle>{shellTexts.startupError}</AlertTitle>
            {startup.error}
            <Box sx={{ mt: 2 }}>
              <ActionButton variant="outlined" onClick={load}>
                {shellTexts.retry}
              </ActionButton>
            </Box>
          </Alert>
        )}
        {startup.phase === 'ready' && (
          <ReadyContent onReady={onReady} onError={readinessFailed}>
            {projects ? (
              <ProjectsPage state={startup.state} />
            ) : (
              <Stack spacing={2}>
                <Typography variant="h5" component="h1">
                  {page?.label ?? shellTexts.missingPage}
                </Typography>
                <Alert severity="info">{shellTexts.unavailable}</Alert>
                <Box>
                  <ActionButton onClick={() => navigate('/projects')}>{shellTexts.returnProjects}</ActionButton>
                </Box>
              </Stack>
            )}
          </ReadyContent>
        )}
      </RenderBoundary>
    </ShellLayout>
  );
}
