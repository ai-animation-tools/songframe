/** Оболочка витрины повторяет рабочую тему и контейнер, не монтируя эффекты приложения. */
import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import createCache from '@emotion/cache';
import { CacheProvider } from '@emotion/react';
import { Alert, AppBar, Box, CssBaseline, GlobalStyles, Snackbar, ThemeProvider, Toolbar, Typography } from '@mui/material';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppValueProvider, describeError, type AppContextValue } from '@renderer/state';
import { offlineAccess } from '@renderer/network';
import { createAppTheme, ThemeModeValueProvider } from '@renderer/theme';
import { PageLoaderArea } from '@renderer/components/PageLoader';
import { LinkedText } from '@renderer/components/LinkedText';
import { BASE_HEADER_HEIGHT, HeaderHeightContext } from '@renderer/components/headerHeight';
import { anchorHighlightStyles, useAnchorTarget } from '@renderer/hooks/useAnchorTarget';
import type { StoryOptions } from '@renderer/testing/storybook';

const styles = createCache({ key: 'css', speedy: true });
const noAction = (): void => undefined;
const noAsyncAction = async (): Promise<void> => undefined;
const defaultApp: AppContextValue = {
  state: null,
  status: null,
  loading: false,
  aiAccess: null,
  online: true,
  agentProvider: null,
  refreshAiAccess: noAsyncAction,
  invalidateAiAccess: noAction,
  setAgentProvider: noAction,
  refresh: noAsyncAction,
  refreshStatus: noAsyncAction,
  openProject: async () => {
    throw new Error('Storybook: openProject требует локальной модели истории.');
  },
  closeProject: noAsyncAction,
  notify: noAction,
  describeError
};

/** Текущий маршрут демонстрационного роутера: play-проверки сверяют переходы и снятие ?anchor=. */
function StoryRoute(): ReactElement {
  const location = useLocation();
  return (
    <Typography variant="caption" color="text.secondary" noWrap data-testid="story-route" sx={{ minWidth: 0 }}>
      {location.pathname + location.search}
    </Typography>
  );
}

/** Целая страница получает ту же обработку ?anchor=, что и рабочая оболочка Layout. */
function StoryAnchors(): null {
  useAnchorTarget();
  return null;
}

interface Props {
  children: ReactNode;
  options: StoryOptions;
  mode: 'light' | 'dark';
  width: number;
}

export function StoryEnvironment({ children, options, mode, width }: Props): ReactElement {
  const [toast, setToast] = useState<{ message: string; severity: 'success' | 'info' | 'warning' | 'error'; persist?: boolean } | null>(null);
  const notify = useCallback<AppContextValue['notify']>((message, severity = 'info', config = {}) => {
    setToast({ message, severity, persist: config.persist });
  }, []);
  const value = useMemo(() => {
    const app = { ...defaultApp, notify, ...options.app };
    return { ...app, aiAccess: app.online ? app.aiAccess : offlineAccess(app.aiAccess) };
  }, [notify, options.app]);
  const theme = useMemo(() => createAppTheme(mode), [mode]);
  const themeMode = useMemo(() => ({ mode, resolved: mode, setMode: noAction }), [mode]);
  const workspace = (
    <Box
      // Браузерный набор измеряет переполнение именно рабочей области: в окне справа от неё есть запас.
      data-testid="story-workspace"
      sx={{
        width: options.workspaceWidth ?? width,
        maxWidth: '100%',
        minHeight: 560,
        mx: 'auto',
        p: 3,
        containerName: 'workspace',
        containerType: 'inline-size'
      }}
    >
      <PageLoaderArea>
        {/* Любой путь демонстрационного роутера сохраняет блок и позволяет проверить переход LinkedText. */}
        <Routes>
          <Route path="*" element={children} />
        </Routes>
      </PageLoaderArea>
    </Box>
  );
  return (
    <CacheProvider value={styles}>
      <ThemeModeValueProvider value={themeMode}>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <MemoryRouter initialEntries={[options.route ?? '/']}>
            <AppValueProvider value={value}>
              {options.shell === 'page' ? (
                <>
                  {/* Упрощённая шапка повторяет высоту и закрепление рабочей: под ней встают панели действий страницы. */}
                  <GlobalStyles styles={anchorHighlightStyles} />
                  <StoryAnchors />
                  <AppBar position="fixed" color="default" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
                    <Toolbar variant="dense" sx={{ gap: 2 }}>
                      <Typography variant="subtitle1" fontWeight={700}>
                        SongFrame · витрина
                      </Typography>
                      <StoryRoute />
                    </Toolbar>
                  </AppBar>
                  <Box sx={{ height: BASE_HEADER_HEIGHT - 1 }} />
                  <HeaderHeightContext.Provider value={BASE_HEADER_HEIGHT}>{workspace}</HeaderHeightContext.Provider>
                </>
              ) : (
                workspace
              )}
              <Snackbar
                open={toast !== null}
                autoHideDuration={toast?.persist ? null : 6000}
                onClose={(_, reason) => {
                  if (reason !== 'clickaway') setToast(null);
                }}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
              >
                <Alert variant="filled" severity={toast?.severity ?? 'info'} onClose={() => setToast(null)}>
                  <LinkedText text={toast?.message ?? ''} />
                </Alert>
              </Snackbar>
            </AppValueProvider>
          </MemoryRouter>
        </ThemeProvider>
      </ThemeModeValueProvider>
    </CacheProvider>
  );
}
