/** Светлая и тёмная темы MUI; выбор хранится в localStorage, по умолчанию следует системе. */

import { type ReactElement, createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CssBaseline, ThemeProvider, buttonClasses, createTheme, touchRippleClasses, useMediaQuery } from '@mui/material';
import { ruRU } from '@mui/material/locale';
import { themePalettes } from './theme-palette';

export type ThemeMode = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'songframe.theme';

interface ThemeModeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode(mode: ThemeMode): void;
}

const ThemeModeContext = createContext<ThemeModeContextValue>({ mode: 'system', resolved: 'light', setMode: () => undefined });

/** Единый источник темы приложения и браузерной витрины; не обращается к хранилищу или системе. */
export function createAppTheme(mode: 'light' | 'dark') {
  return createTheme(
    {
      palette: themePalettes[mode],
      shape: { borderRadius: 8 },
      typography: { fontSize: 13.5 },
      components: {
        // Волна фокуса с клавиатуры у значков, вкладок и пунктов остаётся видимой, но приглушена.
        MuiButtonBase: {
          styleOverrides: { root: { [`& .${touchRippleClasses.ripplePulsate}.${touchRippleClasses.rippleVisible}`]: { opacity: 0.12 } } }
        },
        // У кнопки с подписью фокус с клавиатуры — рамка её цвета: заливка за текстом опускала бы контраст подписи
        // цветных кнопок ниже WCAG AA (4.5:1), а рамка оставляет фон покоя или наведения.
        MuiButton: {
          defaultProps: { disableElevation: true, disableFocusRipple: true },
          styleOverrides: {
            root: ({ ownerState, theme }) => ({
              [`&.${buttonClasses.focusVisible}`]: {
                outline: `2px solid ${ownerState.color && ownerState.color !== 'inherit' ? theme.palette[ownerState.color].main : 'currentColor'}`,
                outlineOffset: 2
              }
            })
          }
        },
        MuiTextField: { defaultProps: { size: 'small' } }
      }
    },
    ruRU
  );
}

/** Управляемый режим без записи в localStorage; MUI ThemeProvider и CssBaseline принадлежат оболочке. */
export function ThemeModeValueProvider({ value, children }: { value: ThemeModeContextValue; children: ReactNode }): ReactElement {
  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

/** Читает сохранённую тему по ключу STORAGE_KEY; недоступное хранилище не препятствует старту. */
function readStoredMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** Связывает выбранную тему с системным режимом и хранит её в отдельном ключе Go-оболочки. */
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
  const theme = useMemo(() => createAppTheme(resolved), [resolved]);
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

/** Возвращает выбор темы ближайшей оболочки, включая изолированное окружение Storybook. */
export function useThemeMode(): ThemeModeContextValue {
  return useContext(ThemeModeContext);
}
