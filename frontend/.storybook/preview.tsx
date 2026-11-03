import type { Preview } from '@storybook/react-vite';
import { useState } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { MemoryRouter } from 'react-router-dom';
import { createAppTheme, ThemeModeValueProvider, type ThemeMode } from '../src/renderer/theme';

/** Локальная тема истории никогда не пишет профиль приложения или localStorage. */
function StoryTheme({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  const [mode, setMode] = useState<ThemeMode>(dark ? 'dark' : 'light');
  const resolved = mode === 'dark' ? 'dark' : 'light';
  return (
    <ThemeModeValueProvider value={{ mode, resolved, setMode }}>
      <ThemeProvider theme={createAppTheme(resolved)}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeModeValueProvider>
  );
}
const preview: Preview = {
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story, context) => (
      <StoryTheme key={context.id} dark={context.parameters.dark}>
        <MemoryRouter initialEntries={[context.parameters.route ?? '/projects']}>
          <Story />
        </MemoryRouter>
      </StoryTheme>
    )
  ]
};
export default preview;
