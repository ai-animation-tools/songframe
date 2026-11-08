/**
 * Переход к цели ссылки: при параметре ?anchor=<id> страница прокручивается к `[data-anchor="<id>"]`,
 * фокусирует его, если он фокусируемый, и кратко подсвечивает. Параметр затем снимается, чтобы
 * повторный рендер или возврат назад не прокручивали снова.
 */
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Theme } from '@mui/material';
import { ANCHOR_PARAM } from '../components/linkTargets';

/** Атрибут подсветки найденной цели; оформление задаёт anchorHighlightStyles из темы. */
export const ANCHOR_HIGHLIGHT_ATTR = 'data-anchor-highlight';
/** Метка закреплённой панели страницы (PageActionBar): её высота закрывает часть окна при прокрутке. */
export const PAGE_ACTION_BAR_ATTR = 'data-page-action-bar';

const HIGHLIGHT_MS = 2000;
/** Данные страницы приходят асинхронно: цель ждём, пока она не появится, но не дольше этого времени. */
const WAIT_MS = 5000;
const GAP = 8;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

/** Сколько окна закрывают сверху закреплённые шапка и панель страницы, а снизу — нижняя панель. */
export interface CoveredArea {
  top: number;
  bottom: number;
}

export function coveredArea(root: ParentNode): CoveredArea {
  const header = root.querySelector('header');
  const height = (selector: string): number =>
    Array.from(root.querySelectorAll(selector)).reduce((sum, element) => sum + element.getBoundingClientRect().height, 0);
  return {
    top: (header?.getBoundingClientRect().bottom ?? 0) + height(`[${PAGE_ACTION_BAR_ATTR}="top"]`),
    bottom: height(`[${PAGE_ACTION_BAR_ATTR}="bottom"]`)
  };
}

/** Помещающуюся цель ставим в центр видимой части окна, высокую — к её верху, чтобы начало не ушло под шапку. */
export function anchorScrollBlock(elementHeight: number, viewportHeight: number, covered: CoveredArea): ScrollLogicalPosition {
  return elementHeight <= viewportHeight - covered.top - covered.bottom - 2 * GAP ? 'center' : 'start';
}

/** Прокрутка, фокус и подсветка найденной цели. */
export function revealAnchor(element: HTMLElement, covered: CoveredArea, viewportHeight: number): void {
  // Поля прокрутки учитываются scrollIntoView: цель встаёт в часть окна, не закрытую закреплёнными панелями.
  element.style.scrollMarginTop = `${covered.top + GAP}px`;
  element.style.scrollMarginBottom = `${covered.bottom + GAP}px`;
  element.scrollIntoView({ block: anchorScrollBlock(element.getBoundingClientRect().height, viewportHeight, covered), behavior: 'smooth' });
  if (element.matches(FOCUSABLE)) element.focus({ preventScroll: true });
  element.setAttribute(ANCHOR_HIGHLIGHT_ATTR, '');
  // Подсветка не зависит от жизни эффекта: снятие параметра перерисовывает страницу, а подсветка должна дожить до конца.
  setTimeout(() => element.removeAttribute(ANCHOR_HIGHLIGHT_ATTR), HIGHLIGHT_MS);
}

/** Параметры маршрута без якоря; прочие (например, ?shot=) сохраняются. */
export function withoutAnchor(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(ANCHOR_PARAM);
  return next;
}

export function findAnchor(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(id)}"]`);
}

/** Оформление подсветки из темы; подключается один раз в общей оболочке. */
export function anchorHighlightStyles(theme: Theme): Record<string, object> {
  return {
    [`[${ANCHOR_HIGHLIGHT_ATTR}]`]: {
      outline: `2px solid ${theme.palette.primary.main}`,
      outlineOffset: 2,
      transition: 'outline-color 0.3s'
    }
  };
}

/** Подключается в общей оболочке и действует на всех страницах: цель ищется в документе по data-anchor. */
export function useAnchorTarget(): void {
  const [params, setParams] = useSearchParams();
  const anchor = params.get(ANCHOR_PARAM);
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;

  useEffect(() => {
    if (!anchor) return;
    const clear = (): void => setParamsRef.current((current) => withoutAnchor(current), { replace: true });
    const reveal = (): boolean => {
      const element = findAnchor(document, anchor);
      if (!element) return false;
      revealAnchor(element, coveredArea(document), window.innerHeight);
      clear();
      return true;
    };
    if (reveal()) return;
    // Цель появится после загрузки данных страницы; без неё параметр всё равно снимается.
    const observer = new MutationObserver(() => {
      if (reveal()) stop();
    });
    const timer = setTimeout(() => {
      stop();
      clear();
    }, WAIT_MS);
    function stop(): void {
      observer.disconnect();
      clearTimeout(timer);
    }
    observer.observe(document.body, { childList: true, subtree: true });
    return stop;
  }, [anchor]);
}
