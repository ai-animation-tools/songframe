/** Настоящая страница открывает рабочий диалог; API ограничен локальной моделью витрины. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { jobsTexts } from '@shared/texts/jobs';
import type { PreviousSessionInfo } from '@shared/types';
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

/** Страница журнала с локальной моделью диагностики: сбой прошлого сеанса задаётся параметром, сохранения считаются. */
function crashOptions(previous: PreviousSessionInfo | null, saved: { count: number }) {
  const base = draftDialogOptions(true);
  return {
    ...base,
    createApi: () => ({
      ...base.createApi?.(),
      agents: { list: async () => [] },
      diagnostics: {
        previousSession: async () => previous,
        saveReport: async () => {
          saved.count += 1;
          return '/mock/songframe-diagnostics.txt';
        }
      }
    })
  };
}

const crashSaved = { count: 0 };

export const PreviousSessionCrashed: Story = {
  name: 'Сбой прошлого сеанса · предупреждение и сохранение отчёта',
  tags: ['ci'],
  parameters: { songframe: crashOptions({ crashed: true, startedAt: '2026-11-20T08:15:30.000Z', version: '1.1.0' }, crashSaved) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const alert = await canvas.findByText(jobsTexts.previousCrashTitle);
    await expect(alert).toBeVisible();
    await expect(canvas.getByText(/версия 1\.1\.0/)).toBeVisible();
    const before = crashSaved.count;
    await userEvent.click(within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: jobsTexts.saveReportShort }));
    await expect(await canvas.findByText(/Отчёт сохранён: \/mock\/songframe-diagnostics\.txt/)).toBeVisible();
    await expect(crashSaved.count).toBe(before + 1);
  }
};

export const PreviousSessionClean: Story = {
  name: 'Прошлый сеанс завершён штатно · предупреждения нет',
  tags: ['ci'],
  parameters: { songframe: crashOptions(null, { count: 0 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(jobsTexts.empty);
    await expect(canvas.queryByText(jobsTexts.previousCrashTitle)).not.toBeInTheDocument();
  }
};
