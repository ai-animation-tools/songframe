/**
 * Общий прелоадер страницы: страница сообщает, что ещё загружает данные, а оболочка показывает индикатор над рабочей областью.
 * Индикатор появляется с задержкой, чтобы быстрые переходы не мигали.
 */
import { commonTexts } from '@shared/texts/common';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Box, CircularProgress, Fade } from '@mui/material';

/** Загрузки короче этого не показываются. */
export const PAGE_LOADER_DELAY_MS = 150;

type Register = (id: string, loading: boolean) => void;
const PageLoaderContext = createContext<Register | null>(null);

/** Страница сообщает, что её данные ещё не готовы; при уходе со страницы отметка снимается сама. */
export function usePageLoading(loading: boolean): void {
  const register = useContext(PageLoaderContext);
  const id = useId();
  useEffect(() => {
    register?.(id, loading);
    return () => register?.(id, false);
  }, [register, id, loading]);
}

/** Оболочка рабочей области: содержимое страницы и индикатор поверх него, пока хоть одна часть страницы загружается. */
export function PageLoaderArea({ children }: { children: ReactNode }): ReactElement {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [visible, setVisible] = useState(false);
  const register = useCallback<Register>((id, loading) => {
    setPending((current) => {
      if (loading === current.has(id)) return current;
      const next = new Set(current);
      if (loading) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const loading = pending.size > 0;
  useEffect(() => {
    if (!loading) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), PAGE_LOADER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [loading]);
  const value = useMemo(() => register, [register]);
  return (
    <PageLoaderContext.Provider value={value}>
      <Box sx={{ position: 'relative', minHeight: loading ? 240 : undefined }} aria-busy={loading || undefined}>
        {children}
        <Fade in={visible} unmountOnExit>
          <Box
            role="progressbar"
            aria-label={commonTexts.pageLoading}
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: (theme) => theme.zIndex.appBar - 1,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'center',
              pt: 12,
              bgcolor: 'background.default',
              opacity: 0.85
            }}
          >
            {/* Имя несёт внешний progressbar, вложенный не дублирует его. */}
            <CircularProgress aria-hidden />
          </Box>
        </Fade>
      </Box>
    </PageLoaderContext.Provider>
  );
}
