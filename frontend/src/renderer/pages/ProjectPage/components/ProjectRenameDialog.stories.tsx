/** Случайное закрытие сохраняет локальный черновик; явная отмена начинает новую форму. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { DraftDialogStory, draftDialogOptions } from '../../../testing/dialogDraftStories';
import { checkDraftDialog } from '../../../testing/dialogDraftPlay';
const meta = {
  title: 'Проект/Переименование',
  component: DraftDialogStory,
  tags: ['!autodocs'],
  args: { kind: 'rename' },
  parameters: { songframe: draftDialogOptions() }
} satisfies Meta<typeof DraftDialogStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PreserveDraft: Story = {
  name: 'Черновик · Escape, фон, ошибка и явная отмена',
  tags: ['ci'],
  play: ({ canvasElement }) => checkDraftDialog(canvasElement, 'rename')
};
