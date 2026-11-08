/** Отступ закреплённого блока под шапкой и панелью действий страницы: высота панели меняется при переносе кнопок и фильтров. */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useHeaderHeight } from '../components/headerHeight';

/** Зазор между панелью действий и закреплённым блоком совпадает с промежутком сетки страницы. */
const GAP = 16;

export function useStickyTop(deps: readonly unknown[] = []): { barRef: RefObject<HTMLDivElement | null>; stickyTop: number } {
  const barRef = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(0);
  const headerHeight = useHeaderHeight();
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const update = (): void => setBarHeight(bar.getBoundingClientRect().height);
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    update();
    return () => observer.disconnect();
    // Панель появляется после загрузки данных страницы: наблюдение подключается заново по переданным зависимостям.
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { barRef, stickyTop: headerHeight + barHeight + GAP };
}
