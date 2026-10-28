/** Переход к цели ссылки: прокрутка в видимую часть окна, фокус, краткая подсветка и снятие параметра якоря. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANCHOR_HIGHLIGHT_ATTR, anchorScrollBlock, coveredArea, findAnchor, revealAnchor, withoutAnchor } from './useAnchorTarget';

interface FakeElement {
  style: Record<string, string>;
  attributes: Set<string>;
  scrolled: ScrollIntoViewOptions[];
  focused: number;
}

const fakeElement = (height: number, focusable: boolean): FakeElement & HTMLElement => {
  const element: FakeElement = { style: {}, attributes: new Set(), scrolled: [], focused: 0 };
  return Object.assign(element, {
    getBoundingClientRect: () => ({ height }),
    scrollIntoView: (options: ScrollIntoViewOptions) => element.scrolled.push(options),
    matches: () => focusable,
    focus: () => (element.focused += 1),
    setAttribute: (name: string) => element.attributes.add(name),
    removeAttribute: (name: string) => element.attributes.delete(name)
  }) as unknown as FakeElement & HTMLElement;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useAnchorTarget', () => {
  it('ставит помещающуюся цель в центр, а высокую — к верху видимой части окна', () => {
    const covered = { top: 100, bottom: 50 };
    expect(anchorScrollBlock(300, 800, covered)).toBe('center');
    expect(anchorScrollBlock(700, 800, covered)).toBe('start');
  });

  it('учитывает шапку и закреплённые панели страницы', () => {
    const rect =
      (values: Partial<DOMRect>): (() => DOMRect) =>
      () =>
        values as DOMRect;
    const root = {
      querySelector: () => ({ getBoundingClientRect: rect({ bottom: 49 }) }),
      querySelectorAll: (selector: string) =>
        selector.includes('"top"') ? [{ getBoundingClientRect: rect({ height: 56 }) }] : [{ getBoundingClientRect: rect({ height: 40 }) }]
    } as unknown as ParentNode;
    expect(coveredArea(root)).toEqual({ top: 105, bottom: 40 });
  });

  it('прокручивает к цели с полями под закреплённые панели, фокусирует и снимает подсветку', () => {
    vi.useFakeTimers();
    const element = fakeElement(200, true);
    revealAnchor(element, { top: 105, bottom: 0 }, 800);
    expect(element.style.scrollMarginTop).toBe('113px');
    expect(element.scrolled).toEqual([{ block: 'center', behavior: 'smooth' }]);
    expect(element.focused).toBe(1);
    expect(element.attributes.has(ANCHOR_HIGHLIGHT_ATTR)).toBe(true);
    vi.runAllTimers();
    expect(element.attributes.has(ANCHOR_HIGHLIGHT_ATTR)).toBe(false);
  });

  it('не фокусирует нефокусируемый блок', () => {
    vi.useFakeTimers();
    const element = fakeElement(200, false);
    revealAnchor(element, { top: 0, bottom: 0 }, 800);
    expect(element.focused).toBe(0);
    expect(element.scrolled).toHaveLength(1);
  });

  it('снимает только параметр якоря', () => {
    expect(withoutAnchor(new URLSearchParams('shot=M01&anchor=production-speech')).toString()).toBe('shot=M01');
  });

  it('ищет цель по data-anchor', () => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const selectors: string[] = [];
    const root = { querySelector: (selector: string) => (selectors.push(selector), null) } as unknown as ParentNode;
    expect(findAnchor(root, 'test')).toBeNull();
    expect(selectors).toEqual(['[data-anchor="test"]']);
  });
});
