/**
 * Чистая часть контекстного меню текста: какое поле или выделение под курсором, какие пункты
 * доступны и адрес поиска. Компонент TextContextMenu только показывает меню и выполняет действия.
 */

/** Типы input, в которых правится текст; флажки, кнопки и выбор файла своего меню не получают. */
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'number', 'password']);

export type TextField = HTMLInputElement | HTMLTextAreaElement;

/** Поле ввода текста, внутри которого вызвано меню, либо null. */
export function textFieldAt(target: EventTarget | null): TextField | null {
  if (!(target instanceof Element)) return null;
  const field = target.closest('input, textarea');
  if (field instanceof HTMLTextAreaElement) return field;
  if (field instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(field.type)) return field;
  return null;
}

/** Команда правки поля по сочетанию клавиш: Ctrl+Z — отмена, Ctrl+Shift+Z и Ctrl+Y — повтор, иначе null.
 * Клавиша берётся физическая (code), а не символ: в русской раскладке Ctrl+Z приходит как «я». */
export function fieldEditCommand(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): 'undo' | 'redo' | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.code === 'KeyZ') return event.shiftKey ? 'redo' : 'undo';
  if (event.code === 'KeyY' && !event.shiftKey) return 'redo';
  return null;
}

/** Нужна ли странице своя отмена в полях: собственная отмена WebKitGTK в полях не срабатывает,
 * поэтому в Linux её выполняет TextContextMenu, а Wails свою отключает (internal/app/edit_keys_linux.go).
 * В Windows поле отменяет сам WebView2, страница не вмешивается. */
export function needsFieldUndo(userAgent: string): boolean {
  return userAgent.includes('Linux') && !userAgent.includes('Android');
}

/** Снимок поля на момент открытия меню: меню забирает фокус, а выделение нужно вернуть перед действием. */
export interface TextFieldState {
  /** Границы выделения; null у полей без API выделения (type="number"). */
  start: number | null;
  end: number | null;
  selected: string;
  editable: boolean;
  /** Пароль не копируется и не вырезается, как в обычном меню браузера. */
  secret: boolean;
  empty: boolean;
}

export function textFieldState(field: TextField): TextFieldState {
  let start: number | null = null;
  let end: number | null = null;
  try {
    start = field.selectionStart;
    end = field.selectionEnd;
  } catch {
    /* у type="number" выделение недоступно */
  }
  const selected = start !== null && end !== null ? field.value.slice(start, end) : '';
  return {
    start,
    end,
    selected,
    editable: !field.readOnly && !field.disabled,
    secret: field instanceof HTMLInputElement && field.type === 'password',
    empty: field.value.length === 0
  };
}

/** Доступность пунктов меню поля. */
export function textFieldActions(state: TextFieldState): { cut: boolean; copy: boolean; paste: boolean; selectAll: boolean } {
  const copy = state.selected.length > 0 && !state.secret;
  return { cut: copy && state.editable, copy, paste: state.editable, selectAll: !state.empty };
}

/** Длина запроса поиска: длинное выделение (абзац промпта) обрезается, чтобы адрес оставался допустимым. */
export const SEARCH_QUERY_LIMIT = 500;

/** Адрес поиска Google по выделенному тексту; пробелы и переводы строк схлопываются. */
export function googleSearchUrl(text: string): string | null {
  const query = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, SEARCH_QUERY_LIMIT).join('');
  return query ? `https://www.google.com/search?q=${encodeURIComponent(query)}` : null;
}
