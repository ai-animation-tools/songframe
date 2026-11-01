/** Настоящая страница открывает рабочий диалог; API ограничен локальной моделью витрины. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { commonTexts } from '@shared/texts/common';
import { draftDialogOptions } from '../../testing/dialogDraftStories';
import { checkDraftDialog } from '../../testing/dialogDraftPlay';
import { JobsPage } from './JobsPage';
const meta = { title: 'Страницы/Задания', component: JobsPage, tags: ['!autodocs'], parameters: { songframe: draftDialogOptions(true) } } satisfies Meta<
  typeof JobsPage
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PreserveDialogDraft: Story = {
  name: 'Черновик окна · случайное закрытие и явная отмена',
  tags: ['ci'],
  play: ({ canvasElement }) => checkDraftDialog(canvasElement, 'retry', commonTexts.retry)
};
