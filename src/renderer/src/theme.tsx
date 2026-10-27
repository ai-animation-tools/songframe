/** Светлая и тёмная темы MUI; выбор хранится в localStorage, по умолчанию следует системе. */

import { type ReactElement, createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CssBaseline, ThemeProvider, createTheme, useMediaQuery } from '@mui/material';
import { themePalettes } from './theme-palette';

export type ThemeMode = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'songframe.theme';

interface ThemeModeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode(mode: ThemeMode): void;
}

const ThemeModeContext = createContext<ThemeModeContextValue>({ mode: 'system', resolved: 'light', setMode: () => undefined });

function readStoredMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function ThemeModeProvider({ children }: { children: ReactNode }): ReactElement {
  const [mode, setMode] = useState<ThemeMode>(readStoredMode);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const resolved = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* хранилище недоступно: тема просто не запомнится */
    }
  }, [mode]);
  const theme = useMemo(
    () =>
      createTheme({
        palette: themePalettes[resolved],
        shape: { borderRadius: 8 },
        typography: { fontSize: 13.5 },
        components: {
          MuiButton: { defaultProps: { disableElevation: true } },
          MuiTextField: { defaultProps: { size: 'small' } }
        }
      }),
    [resolved]
  );
  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved]);
  return (
    <ThemeModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}

export function useThemeMode(): ThemeModeContextValue {
  return useContext(ThemeModeContext);
}
