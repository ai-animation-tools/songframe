/** Состояния задания у его действия: идущее — заметная плашка с прошедшим временем, итог — успех или сбой. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Stack } from '@mui/material';
import { commonTexts } from '@shared/texts/common';
import type { JobInfo } from '@shared/types';
import { JobStatus } from './JobStatus';

const job = (status: JobInfo['status'], extra: Partial<JobInfo> = {}): JobInfo => ({
  id: 'job-1',
  kind: 'tool',
  title: 'Эффект M04',
  status,
  startedAt: new Date(Date.now() - 75_000).toISOString(),
  finishedAt: status === 'running' ? null : new Date().toISOString(),
  log: '',
  code: status === 'failed' ? 1 : status === 'done' ? 0 : null,
  steps: [],
  ...extra
});

const meta = {
  title: 'Общие/Состояние задания',
  component: JobStatus,
  render: (args) => (
    <Stack sx={{ maxWidth: 560 }}>
      <JobStatus {...args} />
    </Stack>
  )
} satisfies Meta<typeof JobStatus>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {
  tags: ['ci'],
  name: 'Выполняется: название, прошедшее время и полоса',
  args: { job: job('running') },
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole('status');
    await expect(within(status).getByText('Эффект M04')).toBeVisible();
    // Время считается от начала задания, а не от показа плашки.
    await expect(within(status).getByText(/^1 мин 1\d с$/)).toBeVisible();
    await expect(status.querySelector('.MuiLinearProgress-root')).not.toBeNull();
  }
};

export const RunningWithoutJob: Story = {
  tags: ['ci'],
  name: 'Выполняется без записи задания: подпись действия, время с показа',
  args: { running: true, label: 'Ролик экспортируется' },
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole('status');
    await expect(within(status).getByText('Ролик экспортируется')).toBeVisible();
    await expect(within(status).getByText(commonTexts.job.elapsed(0))).toBeVisible();
  }
};

export const Done: Story = { name: 'Выполнено', args: { job: job('done') } };

export const Failed: Story = {
  name: 'Сбой с переходом к журналу',
  args: { job: job('failed', { error: 'FFmpeg завершился с кодом 1: не найден кодек.' }) }
};
