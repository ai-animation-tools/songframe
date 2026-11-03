import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { installApi } from '@platform/api';
import { App } from './App';
import { RenderBoundary } from './components/RenderBoundary';
import { ThemeModeProvider } from './theme';

/** Устанавливает совместимый API до монтирования; даже отказ инициализации транспорта показывается с повтором. */
let startupFailure: unknown;
try {
  installApi();
} catch (error) {
  startupFailure = error;
}
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <ThemeModeProvider>
      <HashRouter>
        <RenderBoundary>
          <App
            loadState={
              startupFailure
                ? async () => {
                    installApi();
                    return window.api.app.state();
                  }
                : undefined
            }
          />
        </RenderBoundary>
      </HashRouter>
    </ThemeModeProvider>
  );
