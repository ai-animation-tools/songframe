/**
 * Точка входа renderer Go-версии. Отличия от 634fd94:
 * - window.api устанавливает адаптер Wails (installApi) до первого рендера: media-компоненты синхронно
 *   вызывают shell.fileUrl, а preload Electron больше нет;
 * - список перенесённых методов адаптера передаётся страницам через AvailabilityProvider;
 * - после первого успешного app.state окно подтверждает готовность Go (signalFrontendReady, smoke);
 * - ошибка рендера изолируется RenderBoundary и уходит в журнал через diagnostics.reportRendererError.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import createCache from '@emotion/cache';
import { CacheProvider } from '@emotion/react';
import { installApi, methodAvailability, signalFrontendReady } from '@platform/api';
import { App } from './App';
import { AvailabilityProvider } from './availability';
import { RenderBoundary } from './components/RenderBoundary';
import { installErrorReporting } from './diagnostics';

installApi();
installErrorReporting();

// Стили MUI вставляются правилами в один лист (insertRule), а не отдельным тегом <style> на правило:
// иначе каждая новая страница добавляет сотни тегов и браузер пересчитывает стили на каждой вставке.
const styles = createCache({ key: 'css', speedy: true });

/** Ошибка рендера уходит в тот же журнал, что и необработанные ошибки окна. */
function reportRenderError(error: Error): void {
  try {
    window.api.diagnostics.reportRendererError({ kind: 'error', message: `${error.name}: ${error.message}`, stack: error.stack, source: window.location.hash });
  } catch {
    // Журнал недоступен: ошибка остаётся в консоли окна.
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CacheProvider value={styles}>
      <AvailabilityProvider value={methodAvailability}>
        <RenderBoundary onError={reportRenderError}>
          <App onReady={() => signalFrontendReady()} />
        </RenderBoundary>
      </AvailabilityProvider>
    </CacheProvider>
  </StrictMode>
);
