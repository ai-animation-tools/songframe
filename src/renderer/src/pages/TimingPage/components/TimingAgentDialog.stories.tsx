/** Диалог использует рабочий hook и локальный ASR API; случайное закрытие не отменяет задание. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Stack, Typography } from '@mui/material';
import { timingAgentTexts as texts } from '@shared/texts/timing-agent';
import { commonTexts } from '@shared/texts/common';
import { ActionButton } from '../../../components/ActionButton';
import { makeTimingStoryView } from '../../../testing/timingStories';
import { timingAgentOptions, timingAgentInspection, TIMING_ASR_START_ERROR } from '../../../testing/timingAgentStories';
import { TimingAgentDialog } from './TimingAgentDialog';

function Journey() {
  const [open, setOpen] = useState(true);
  const [applied, setApplied] = useState(false);
  return (
    <Stack spacing={2}>
      <ActionButton onClick={() => setOpen(true)}>{texts.title}</ActionButton>
      {applied && <Typography>Предложение получено страницей</Typography>}
      {open && (
        <TimingAgentDialog
          project="/mock/timing-project"
          lines={makeTimingStoryView().timing!.lines}
          onClose={() => setOpen(false)}
          onApply={() => setApplied(true)}
        />
      )}
    </Stack>
  );
}
const meta = {
  title: 'Тайминги/Агентное распознавание',
  component: Journey,
  tags: ['!autodocs'],
  parameters: { songframe: timingAgentOptions(), controls: { disable: true } },
  render: () => <Journey />
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RequestAndApply: Story = {
  name: 'Запрос · ASR-свидетельства · перенос только явной кнопкой',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(dialog.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    const source = dialog.getByRole('button', { name: texts.source });
    await expect(source).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(source);
    await expect(dialog.getByText(/"path": "track.mp3"/)).toBeVisible();
    await userEvent.click(source);
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.run }));
    await expect(await dialog.findByText(texts.running, { exact: false })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    const root = screen.getByRole('dialog').closest('.MuiDialog-root')!;
    const container = root.querySelector('.MuiDialog-container')!;
    await userEvent.click(container);
    await expect(screen.getByRole('dialog')).toBeVisible();
    await expect(timingAgentInspection().cancels).toBe(0);
    await waitFor(() => expect(dialog.getByRole('button', { name: texts.apply })).toBeEnabled(), { timeout: 5000 });
    await userEvent.click(dialog.getByRole('button', { name: texts.evidence }));
    await expect(dialog.getByText('12.00–16.00 с · У старых ворот начинается утро')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(screen.getByRole('dialog')).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: texts.apply }));
    await expect(await screen.findByText('Предложение получено страницей')).toBeVisible();
    await expect(timingAgentInspection()).toEqual({ starts: 1, cancels: 0, proposals: 1 });
    await userEvent.click(within(canvasElement).getByRole('button', { name: texts.title }));
    const reopened = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(reopened.getByText(texts.engine({ name: 'Демонстрационный ASR · model-test' }))).toBeVisible());
    await expect(reopened.getByRole('button', { name: texts.source })).toHaveAttribute('aria-expanded', 'false');
  }
};
export const CancelRunning: Story = {
  name: 'Работающий агент · Esc и фон игнорируются · явная отмена',
  tags: ['ci'],
  parameters: { songframe: timingAgentOptions('running') },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = within(await screen.findByRole('dialog'));
    await dialog.findByText(texts.running, { exact: false });
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('dialog').closest('.MuiDialog-root')!.querySelector('.MuiDialog-container')!);
    await expect(timingAgentInspection().cancels).toBe(0);
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(timingAgentInspection()).toEqual({ starts: 1, cancels: 1, proposals: 0 });
    await userEvent.click(within(canvasElement).getByRole('button', { name: texts.title }));
    await expect(await screen.findByText(texts.cancelled)).toBeVisible();
  }
};
export const StopRunning: Story = {
  name: 'Остановить задание с сохранением окна',
  parameters: { songframe: timingAgentOptions('running') },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.click(await dialog.findByRole('button', { name: commonTexts.stop }));
    await expect(await dialog.findByText(texts.cancelled)).toBeVisible();
    await expect(screen.getByRole('dialog')).toBeVisible();
    await expect(timingAgentInspection().cancels).toBe(1);
  }
};
export const Unsupported: Story = {
  name: 'Нет ASR · понятная причина · без запасного Whisper',
  parameters: { songframe: timingAgentOptions('unsupported') },
  play: async ({ canvasElement }) => {
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await waitFor(() => expect(dialog.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.run }));
    await expect(await dialog.findByText(texts.unsupported, {}, { timeout: 5000 })).toBeVisible();
    await expect(dialog.getByRole('button', { name: texts.apply })).toBeDisabled();
    await expect(timingAgentInspection()).toEqual({ starts: 1, cancels: 0, proposals: 0 });
  }
};
export const InvalidReport: Story = {
  name: 'Неверный JSON · ошибка без переноса',
  parameters: { songframe: timingAgentOptions('invalid') },
  play: async ({ canvasElement }) => {
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await waitFor(() => expect(dialog.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.run }));
    await expect(await dialog.findByText(texts.invalidReport, {}, { timeout: 5000 })).toBeVisible();
    await expect(dialog.getByRole('button', { name: texts.apply })).toBeDisabled();
  }
};
export const Stale: Story = {
  name: 'Исходники изменились · перенос запрещён',
  parameters: { songframe: timingAgentOptions('stale') },
  play: async ({ canvasElement }) => {
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await waitFor(() => expect(dialog.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.run }));
    await expect(await dialog.findByText(texts.stale, {}, { timeout: 5000 })).toBeVisible();
    await expect(dialog.getByRole('button', { name: texts.apply })).toBeDisabled();
  }
};
export const StartFailureAndRetry: Story = {
  name: 'Ошибка запуска · повтор с тем же запросом',
  parameters: { songframe: timingAgentOptions('fail-start') },
  play: async ({ canvasElement }) => {
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await waitFor(() => expect(dialog.getByRole('button', { name: commonTexts.run })).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.run }));
    await expect(await dialog.findByText(TIMING_ASR_START_ERROR)).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.run }));
    await waitFor(() => expect(dialog.getByRole('button', { name: texts.apply })).toBeEnabled(), { timeout: 5000 });
    await expect(timingAgentInspection().starts).toBe(2);
  }
};
export const ReadFailureAndRetry: Story = {
  name: 'Ошибка чтения запроса · повтор',
  parameters: { songframe: timingAgentOptions('fail-read') },
  play: async ({ canvasElement }) => {
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await userEvent.click(await dialog.findByRole('button', { name: commonTexts.retry }));
    await waitFor(() => expect(dialog.getByRole('button', { name: commonTexts.run })).toBeEnabled());
  }
};
export const RestartRequired: Story = {
  name: 'Прежний preload · просьба перезапустить без белого экрана',
  parameters: { songframe: timingAgentOptions('missing-api') },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const dialog = within(await screen.findByRole('dialog'));
    await expect(await dialog.findByText(texts.restartRequired)).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }
};
