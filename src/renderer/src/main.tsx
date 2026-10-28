import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import createCache from '@emotion/cache';
import { CacheProvider } from '@emotion/react';
import { App } from './App';
import { installErrorReporting } from './diagnostics';

installErrorReporting();

// Стили MUI вставляются правилами в один лист (insertRule), а не отдельным тегом <style> на правило:
// иначе каждая новая страница добавляет сотни тегов и браузер пересчитывает стили на каждой вставке.
const styles = createCache({ key: 'css', speedy: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CacheProvider value={styles}>
      <App />
    </CacheProvider>
  </StrictMode>
);
