/** Меню текста на настоящих полях: доступность пунктов, вставка из буфера Go, копирование и поиск. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack, TextField, Typography } from '@mui/material';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { contextMenuTexts as texts } from '@shared/texts/context-menu';
import { createStoryApi, type StoryOptions } from '../testing/storybook';
import { TextContextMenu } from './TextContextMenu';

const CLIPBOARD = 'из буфера';
const opened: string[] = [];
const writes: string[] = [];

function Fields() {
  const [lyrics, setLyrics] = useState('дорога к старым воротам');
  return (
    <Stack spacing={2} sx={{ maxWidth: 520 }}>
      {/* Меню монтируется один раз, как в оболочке приложения. */}
      <TextContextMenu />
      <TextField label="Строка песни" value={lyrics} onChange={(event) => setLyrics(event.target.value)} />
      <Typography data-testid="echo">{lyrics}</Typography>
      <TextField label="Путь только для чтения" value="/clip/source/track.mp3" slotProps={{ input: { readOnly: true } }} />
      <TextField label="Ключ доступа" type="password" defaultValue="секрет" />
      <Typography data-testid="prose">Утро начинается у старых ворот</Typography>
    </Stack>
  );
}

const meta = {
  title: 'Общие/Контекстное меню текста',
  component: TextContextMenu,
  render: () => <Fields />,
  parameters: {
    songframe: {
      createApi: () =>
        createStoryApi({
          shell: { clipboardText: async () => CLIPBOARD, openExternal: async (url: string) => void opened.push(url) }
        })
    } satisfies StoryOptions
  },
  beforeEach: () => {
    opened.length = 0;
    writes.length = 0;
    // Запись в буфер браузера в обходе Playwright без разрешения отклоняется: проверяем переданный текст.
    const original = navigator.clipboard?.writeText;
    if (navigator.clipboard) navigator.clipboard.writeText = async (text: string) => void writes.push(text);
    return () => {
      if (navigator.clipboard && original) navigator.clipboard.writeText = original;
    };
  }
} satisfies Meta<typeof TextContextMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Правый клик user-event ставит курсор и сбрасывает выделение, чего настоящий браузер при щелчке
 * по выделению не делает; поэтому событие contextmenu отправляется напрямую, в центр элемента.
 */
async function openMenu(target: Element, prepare?: () => void) {
  const screen = within(target.ownerDocument.body);
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  // Закрытое меню возвращает фокус и этим снимает выделение страницы: выделяем после закрытия.
  prepare?.();
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 10, clientY: rect.top + rect.height / 2 })
  );
  return screen.findByRole('menu', { name: texts.label });
}

const item = (menu: HTMLElement, name: string) => within(menu).getByRole('menuitem', { name: new RegExp(`^${name}`) });

export const FieldActions: Story = {
  name: 'Поле · вырезать, вставить из буфера, выделить всё, только чтение и пароль',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const field = canvas.getByRole('textbox', { name: 'Строка песни' }) as HTMLInputElement;
    const echo = canvas.getByTestId('echo');

    // Без выделения доступны только вставка и «Выделить всё».
    field.focus();
    field.setSelectionRange(0, 0);
    let menu = await openMenu(field);
    await expect(item(menu, texts.cut)).toHaveAttribute('aria-disabled', 'true');
    await expect(item(menu, texts.copy)).toHaveAttribute('aria-disabled', 'true');
    await expect(item(menu, texts.paste)).not.toHaveAttribute('aria-disabled');
    await expect(within(menu).getByText(texts.pasteKeys)).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await expect(field).toHaveFocus();

    // «Вырезать» копирует выделение и удаляет его из поля; React видит новое значение.
    field.setSelectionRange(0, 7);
    menu = await openMenu(field);
    await userEvent.click(item(menu, texts.cut));
    await waitFor(() => expect(echo).toHaveTextContent(/^к старым воротам$/));
    await expect(writes).toEqual(['дорога ']);

    // «Вставить» берёт текст из буфера через Go и ставит его на место курсора.
    field.setSelectionRange(0, 0);
    menu = await openMenu(field);
    await userEvent.click(item(menu, texts.paste));
    await waitFor(() => expect(echo).toHaveTextContent(`${CLIPBOARD}к старым воротам`));
    await expect(field).toHaveFocus();

    menu = await openMenu(field);
    await userEvent.click(item(menu, texts.selectAll));
    await waitFor(() => expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]));

    // Поле только для чтения копируется, но не правится; пароль не копируется.
    const locked = canvas.getByRole('textbox', { name: 'Путь только для чтения' }) as HTMLInputElement;
    locked.focus();
    locked.setSelectionRange(0, 5);
    menu = await openMenu(locked);
    await expect(item(menu, texts.copy)).not.toHaveAttribute('aria-disabled');
    await expect(item(menu, texts.cut)).toHaveAttribute('aria-disabled', 'true');
    await expect(item(menu, texts.paste)).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(item(menu, texts.copy));
    await waitFor(() => expect(writes).toEqual(['дорога ', '/clip']));
    const secret = canvas.getByLabelText('Ключ доступа') as HTMLInputElement;
    secret.focus();
    secret.setSelectionRange(0, 3);
    menu = await openMenu(secret);
    await expect(item(menu, texts.copy)).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
  }
};

export const SelectedText: Story = {
  name: 'Выделенный текст · копировать и искать в Google',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const prose = canvas.getByTestId('prose');
    // Вне поля и без выделения меню нет, а событие остаётся несброшенным.
    window.getSelection()?.removeAllRanges();
    const plain = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    prose.dispatchEvent(plain);
    await expect(plain.defaultPrevented).toBe(false);
    await expect(within(canvasElement.ownerDocument.body).queryByRole('menu')).not.toBeInTheDocument();

    const selectProse = () => {
      const range = document.createRange();
      range.selectNodeContents(prose);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    };
    let menu = await openMenu(prose, selectProse);
    await expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    await userEvent.click(item(menu, texts.copy));
    await waitFor(() => expect(writes).toEqual(['Утро начинается у старых ворот']));

    menu = await openMenu(prose, selectProse);
    await userEvent.click(item(menu, texts.searchGoogle));
    await waitFor(() => expect(opened).toHaveLength(1));
    await expect(new URL(opened[0]).searchParams.get('q')).toBe('Утро начинается у старых ворот');
    await expect(opened[0].startsWith('https://www.google.com/search?q=')).toBe(true);
  }
};
