/**
 * Русское контекстное меню текста вместо стандартного меню WebKit, которое в Linux остаётся
 * английским без переводов WebKitGTK. У поля ввода — «Вырезать», «Копировать», «Вставить»,
 * «Выделить всё»; у выделенного обычного текста — «Копировать» и «Искать в Google».
 *
 * Меню перехватывает событие contextmenu на фазе захвата раньше рантайма Wails. Вставка читает
 * буфер обмена через Go (window.api.shell.clipboardText): WebKit не даёт странице читать его сам.
 * Вставка и удаление идут через execCommand, чтобы React увидел ввод, а Ctrl+Z поля отменял их.
 * Горячие клавиши Ctrl+X/C/V/A не перехватываются и работают штатно.
 */
import { type ReactElement, type ReactNode, useLayoutEffect, useState } from 'react';
import { Alert, Divider, ListItemIcon, ListItemText, Menu, MenuItem, type MenuItemProps, Snackbar, Typography } from '@mui/material';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import SearchIcon from '@mui/icons-material/Search';
import { contextMenuTexts as texts } from '@shared/texts/context-menu';
import { describeError } from '../state';
import { googleSearchUrl, textFieldActions, textFieldAt, textFieldState, type TextField, type TextFieldState } from './textContextMenu';

type MenuState = { x: number; y: number } & ({ kind: 'field'; field: TextField; state: TextFieldState } | { kind: 'text'; text: string });

/** Возвращает выделение, которое было в поле до открытия меню, и фокус. */
function restoreField(field: TextField, state: TextFieldState): void {
  field.focus();
  if (state.start === null || state.end === null) return;
  try {
    field.setSelectionRange(state.start, state.end);
  } catch {
    /* у type="number" выделение недоступно */
  }
}

/** Заменяет выделение текстом так же, как ввод с клавиатуры: React получает событие input. */
function replaceSelection(field: TextField, state: TextFieldState, text: string): void {
  restoreField(field, state);
  const done = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
  if (done) return;
  // Запасной путь без истории правки поля: setRangeText и событие input для React.
  const start = state.start ?? field.value.length;
  const end = state.end ?? field.value.length;
  field.setRangeText(text, start, end, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Пункт с подсказкой клавиш; остальные свойства (autoFocus, tabIndex от MenuList) уходят в MenuItem. */
function Item({ icon, label, keys, ...props }: { icon: ReactNode; label: string; keys?: string } & MenuItemProps): ReactElement {
  return (
    <MenuItem dense {...props}>
      <ListItemIcon>{icon}</ListItemIcon>
      <ListItemText>{label}</ListItemText>
      {keys && (
        <Typography variant="body2" color="text.secondary" sx={{ ml: 3 }}>
          {keys}
        </Typography>
      )}
    </MenuItem>
  );
}

/** Один экземпляр на окно: монтируется оболочкой приложения и в историях меню. */
export function TextContextMenu(): ReactElement {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Обработчик ставится сразу при монтировании, до первой отрисовки: щелчок не уходит меню WebKit.
  useLayoutEffect(() => {
    const open = (event: MouseEvent): void => {
      const field = textFieldAt(event.target);
      // Меню с клавиатуры (клавиша меню, Shift+F10) приходит без координат мыши: открываем у элемента.
      const keyboard = event.clientX === 0 && event.clientY === 0;
      const at = (element: Element): { x: number; y: number } => {
        if (!keyboard) return { x: event.clientX, y: event.clientY };
        const rect = element.getBoundingClientRect();
        return { x: rect.left + 8, y: rect.bottom };
      };
      if (field) {
        event.preventDefault();
        setMenu({ kind: 'field', field, state: textFieldState(field), ...at(field) });
        return;
      }
      const text = window.getSelection()?.toString() ?? '';
      if (!text.trim() || !(event.target instanceof Element)) return;
      event.preventDefault();
      setMenu({ kind: 'text', text, ...at(event.target) });
    };
    document.addEventListener('contextmenu', open, true);
    return () => document.removeEventListener('contextmenu', open, true);
  }, []);

  const close = (): void => setMenu(null);
  const copy = (text: string): void => {
    navigator.clipboard.writeText(text).catch((reason: unknown) => setError(texts.copyFailed({ reason: describeError(reason) })));
  };

  let items: ReactNode = null;
  if (menu?.kind === 'field') {
    const { field, state } = menu;
    const allowed = textFieldActions(state);
    items = [
      <Item
        key="cut"
        icon={<ContentCutIcon fontSize="small" />}
        label={texts.cut}
        keys={texts.cutKeys}
        disabled={!allowed.cut}
        onClick={() => {
          close();
          copy(state.selected);
          replaceSelection(field, state, '');
        }}
      />,
      <Item
        key="copy"
        icon={<ContentCopyIcon fontSize="small" />}
        label={texts.copy}
        keys={texts.copyKeys}
        disabled={!allowed.copy}
        onClick={() => {
          close();
          restoreField(field, state);
          copy(state.selected);
        }}
      />,
      <Item
        key="paste"
        icon={<ContentPasteIcon fontSize="small" />}
        label={texts.paste}
        keys={texts.pasteKeys}
        disabled={!allowed.paste}
        onClick={() => {
          close();
          window.api.shell
            .clipboardText()
            .then((text) => {
              if (text) replaceSelection(field, state, text);
              else restoreField(field, state);
            })
            .catch((reason: unknown) => setError(texts.pasteFailed({ reason: describeError(reason) })));
        }}
      />,
      <Divider key="divider" />,
      <Item
        key="all"
        icon={<SelectAllIcon fontSize="small" />}
        label={texts.selectAll}
        keys={texts.selectAllKeys}
        disabled={!allowed.selectAll}
        onClick={() => {
          close();
          field.focus();
          field.select();
        }}
      />
    ];
  } else if (menu?.kind === 'text') {
    const { text } = menu;
    const search = googleSearchUrl(text);
    items = [
      <Item
        key="copy"
        icon={<ContentCopyIcon fontSize="small" />}
        label={texts.copy}
        keys={texts.copyKeys}
        onClick={() => {
          close();
          copy(text);
        }}
      />,
      <Item
        key="search"
        icon={<SearchIcon fontSize="small" />}
        label={texts.searchGoogle}
        disabled={!search}
        onClick={() => {
          close();
          if (search) window.api.shell.openExternal(search).catch((reason: unknown) => setError(texts.searchFailed({ reason: describeError(reason) })));
        }}
      />
    ];
  }

  return (
    <>
      <Menu
        open={!!menu}
        onClose={close}
        anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}
        slotProps={{ list: { 'aria-label': texts.label, dense: true } }}
      >
        {items}
      </Menu>
      <Snackbar open={!!error} autoHideDuration={8000} onClose={() => setError(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity="error" onClose={() => setError(null)} variant="filled">
          {error}
        </Alert>
      </Snackbar>
    </>
  );
}
