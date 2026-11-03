/** Настоящая страница монтажа: локальное чтение материалов не запускает экспорт, FFmpeg или отдельный плеер. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { montageTexts } from '@shared/texts/montage';
import { draftDialogOptions } from '../../testing/dialogDraftStories';
import { montageView, MONTAGE_PROJECT } from '../../testing/montageStories';
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
