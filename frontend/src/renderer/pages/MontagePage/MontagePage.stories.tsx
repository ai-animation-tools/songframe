/** Настоящая страница монтажа: локальное чтение материалов не запускает экспорт, FFmpeg или отдельный плеер. */
import { useState, type ReactElement } from 'react';
import { Button } from '@mui/material';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { montageTexts } from '@shared/texts/montage';
import { draftDialogOptions } from '../../testing/dialogDraftStories';
import { MONTAGE_BLOCKED_REASON, montageDraft, montageReviewView, montageView, MONTAGE_PROJECT } from '../../testing/montageStories';
import { MontagePage } from './MontagePage';
const options = draftDialogOptions(true);
const meta = {
  title: 'Страницы/Монтаж',
  component: MontagePage,
  tags: ['!autodocs'],
  parameters: {
    songframe: {
      ...options,
      route: '/project/montage?shots=M01,M02',
      app: { ...options.app, state: { ...options.app!.state!, current: MONTAGE_PROJECT } },
      createApi: () => ({ montage: { view: async () => structuredClone(montageView()) } })
    }
  }
} satisfies Meta<typeof MontagePage>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Приложение перерисовывает страницу при каждом обновлении статуса: возврат в окно, конец задания. */
function RerenderedPage(): ReactElement {
  const [count, setCount] = useState(0);
  return (
    <>
      <Button onClick={() => setCount(count + 1)}>Обновить статус приложения: {count}</Button>
      <MontagePage />
    </>
  );
}
const SAVED_DRAFT = { id: '2fe903c0-b6d3-4176-9692-dda994878f85', name: 'Проба клипа', updatedAt: '2026-11-06T08:46:11.000Z' };
/** Страница открыта без выбранных сцен: дорожка приходит только из сохранённого черновика. */
const savedDraftApi = (removed: string[] = []) => ({
  montage: {
    view: async () => ({ ...structuredClone(montageView()), saved: [SAVED_DRAFT] }),
    load: async () => ({ ...montageDraft(), name: SAVED_DRAFT.name }),
    remove: async (_project: string, id: string) => void removed.push(id)
  }
});
const openSavedDraft = async (canvasElement: HTMLElement): Promise<void> => {
  const canvas = within(canvasElement);
  const screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(await canvas.findByRole('combobox', { name: montageTexts.openDraft }));
  await userEvent.click(await screen.findByRole('option', { name: /Проба клипа/ }));
  await expect(await canvas.findByRole('textbox', { name: montageTexts.draftName })).toHaveValue(SAVED_DRAFT.name);
};
export const OpenedDraftReopenKeepsScenes: Story = {
  name: 'Открытый черновик · виден в списке, переоткрытие оставляет его сцены на дорожке',
  tags: ['ci'],
  parameters: { songframe: { route: '/project/montage', createApi: () => savedDraftApi() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await openSavedDraft(canvasElement);
    await waitFor(() => expect(canvas.getByRole('combobox', { name: montageTexts.openDraft })).toHaveTextContent(SAVED_DRAFT.name));
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.more }));
    await userEvent.click(await screen.findByRole('menuitem', { name: montageTexts.reopenMaterials }));
    await waitFor(() => expect(canvas.getByRole('textbox', { name: montageTexts.draftName })).toHaveValue(montageTexts.defaultName));
    // Материалы обновлены, а не потеряны; проба уже новая, поэтому список снова ничего не показывает.
    await expect(canvas.getAllByText('M01').length).toBeGreaterThan(0);
    await expect(canvas.getAllByText('M02').length).toBeGreaterThan(0);
    await expect(canvas.getByRole('combobox', { name: montageTexts.openDraft })).not.toHaveTextContent(SAVED_DRAFT.name);
  }
};
const removedDrafts: string[] = [];
export const RemoveSavedDraft: Story = {
  name: 'Открытый черновик · удаление с подтверждением оставляет дорожку',
  tags: ['ci'],
  parameters: { songframe: { route: '/project/montage', createApi: () => savedDraftApi(removedDrafts) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    removedDrafts.length = 0;
    await canvas.findByRole('textbox', { name: montageTexts.draftName });
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.more }));
    // Несохранённой пробе удалять нечего.
    await expect(await screen.findByRole('menuitem', { name: montageTexts.removeDraft })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    await openSavedDraft(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.more }));
    await userEvent.click(await screen.findByRole('menuitem', { name: montageTexts.removeDraft }));
    const dialog = await screen.findByRole('dialog', { name: montageTexts.removeDraftTitle });
    await expect(dialog).toHaveTextContent(SAVED_DRAFT.name);
    await userEvent.click(within(dialog).getByRole('button', { name: montageTexts.removeDraftConfirm }));
    await waitFor(() => expect(removedDrafts).toEqual([SAVED_DRAFT.id]));
    await expect(await canvas.findByText(montageTexts.newDraft)).toBeInTheDocument();
    // Пока диалог закрывается, страница скрыта от специальных возможностей: ждём её возвращения.
    await expect(await canvas.findByRole('combobox', { name: montageTexts.openDraft })).toHaveAttribute('aria-disabled', 'true');
    await expect(canvas.getAllByText('M01').length).toBeGreaterThan(0);
  }
};
export const StatusRefreshKeepsDraft: Story = {
  name: 'Несохранённая проба · обновление статуса приложения её не сбрасывает',
  tags: ['ci'],
  render: () => <RerenderedPage />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = await canvas.findByRole('textbox', { name: montageTexts.draftName });
    await userEvent.clear(name);
    await userEvent.type(name, 'Проба до обновления');
    await userEvent.tab();
    await expect(canvas.getByText(montageTexts.unsavedChanges)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: /Обновить статус приложения/ }));
    await expect(await canvas.findByRole('button', { name: 'Обновить статус приложения: 1' })).toBeInTheDocument();
    // Сброс пришёл бы асинхронно, после ответа montage.view: дожидаемся возможного чтения.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(canvas.getByRole('textbox', { name: montageTexts.draftName })).toHaveValue('Проба до обновления');
    await expect(canvas.getByText(montageTexts.unsavedChanges)).toBeInTheDocument();
  }
};
/** Ctrl+Z в русской раскладке: символ «я», физическая клавиша KeyZ. */
function pressHistoryKey(code: 'KeyZ' | 'KeyY', key: string, shiftKey = false): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { code, key, ctrlKey: true, shiftKey, bubbles: true, cancelable: true }));
}
export const HistoryKeysAnyLayout: Story = {
  name: 'Отмена и повтор · Ctrl+Z, Ctrl+Shift+Z и Ctrl+Y работают и в русской раскладке',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = await canvas.findByRole('textbox', { name: montageTexts.draftName });
    await userEvent.clear(name);
    await userEvent.type(name, 'Проба с отменой');
    await userEvent.tab();
    (document.activeElement as HTMLElement | null)?.blur();
    pressHistoryKey('KeyZ', 'я');
    await waitFor(() => expect(canvas.getByRole('textbox', { name: montageTexts.draftName })).toHaveValue(montageTexts.defaultName));
    pressHistoryKey('KeyY', 'н');
    await waitFor(() => expect(canvas.getByRole('textbox', { name: montageTexts.draftName })).toHaveValue('Проба с отменой'));
    pressHistoryKey('KeyZ', 'я');
    await waitFor(() => expect(canvas.getByRole('textbox', { name: montageTexts.draftName })).toHaveValue(montageTexts.defaultName));
    pressHistoryKey('KeyZ', 'Я', true);
    await waitFor(() => expect(canvas.getByRole('textbox', { name: montageTexts.draftName })).toHaveValue('Проба с отменой'));
  }
};
export const DiscardWarning: Story = {
  name: 'Несохранённая проба · предупреждение перед переоткрытием материалов',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const name = await canvas.findByRole('textbox', { name: montageTexts.draftName });
    await expect(canvas.getByRole('group', { name: montageTexts.lyricLines })).toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.type(name, 'Несохранённая режиссёрская версия');
    // Поле фиксирует изменение при уходе фокуса; меню вызывает штатную проверку dirty страницы.
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.more }));
    await userEvent.click(await screen.findByRole('menuitem', { name: montageTexts.reopenMaterials }));
    const dialog = await screen.findByRole('dialog', { name: montageTexts.replaceTitle });
    await expect(within(dialog).getByRole('alert')).toHaveTextContent(montageTexts.replaceWarning);
    dialog.focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('textbox', { name: montageTexts.draftName })).toHaveValue('Несохранённая режиссёрская версия');
    await expect(canvas.getByText(montageTexts.unsavedChanges)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.more }));
    await userEvent.click(await screen.findByRole('menuitem', { name: montageTexts.reopenMaterials }));
    const reopened = await screen.findByRole('dialog', { name: montageTexts.replaceTitle });
    await userEvent.click(within(reopened).getByRole('button', { name: montageTexts.replace }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('textbox', { name: montageTexts.draftName })).toHaveValue(montageTexts.defaultName);
  }
};
export const ScenarioReviewBlocksApply: Story = {
  name: 'Сценарий требует пересмотра · применение выключено с причиной, правка и проба доступны',
  tags: ['ci'],
  parameters: { songframe: { createApi: () => ({ montage: { view: async () => structuredClone(montageReviewView()) } }) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await canvas.findByRole('textbox', { name: montageTexts.draftName });
    // Причина видна на странице со ссылкой на «Сценарий», где сценарий утверждают заново.
    const alert = canvas.getAllByRole('alert').find((item) => item.textContent?.includes(MONTAGE_BLOCKED_REASON));
    await expect(alert).toBeDefined();
    await expect(within(alert!).getByRole('link', { name: /Сценарий/ })).toHaveAttribute('href', '/project/scenario');
    // Сохранение и проба не зависят от утверждения сценария.
    await expect(canvas.getByRole('button', { name: montageTexts.saveDraft })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: montageTexts.exportVideo })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.more }));
    const apply = await screen.findByRole('menuitem', { name: new RegExp(montageTexts.applyToScenes) });
    await expect(apply).toHaveAttribute('aria-disabled', 'true');
    await expect(apply).toHaveTextContent(MONTAGE_BLOCKED_REASON);
    await expect(screen.getByRole('menuitem', { name: montageTexts.reopenMaterials })).not.toHaveAttribute('aria-disabled');
    await userEvent.keyboard('{Escape}');
  }
};
