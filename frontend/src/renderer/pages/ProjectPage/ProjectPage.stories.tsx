/** Настоящая страница открывает рабочий диалог; API ограничен локальной моделью витрины. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { projectsTexts } from '@shared/texts/projects';
import { draftDialogOptions } from '../../testing/dialogDraftStories';
import { checkDraftDialog } from '../../testing/dialogDraftPlay';
import { ProjectPage } from './ProjectPage';
const meta = { title: 'Страницы/Проект', component: ProjectPage, tags: ['!autodocs'], parameters: { songframe: draftDialogOptions(true) } } satisfies Meta<
  typeof ProjectPage
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PreserveDialogDraft: Story = {
  name: 'Черновик окна · случайное закрытие и явная отмена',
  tags: ['ci'],
  play: ({ canvasElement }) => checkDraftDialog(canvasElement, 'rename', commonTexts.rename)
};
export const FrameRate: Story = {
  name: 'Шапка · частота кадров проекта',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(projectsTexts.projectFrameRate(30))).toBeVisible();
  }
};
