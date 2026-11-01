/** Настоящая страница проверяет свободный ввод, сохранение и повторное чтение отдельной локальной модели. */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Stack } from '@mui/material';
import { commonTexts } from '@shared/texts/common';
import { timingTexts } from '@shared/texts/timing';
import { ActionButton } from '../../components/ActionButton';
import { TIMING_PAGE_SAVE_ERROR, timingPageInspection, timingPageOptions } from '../../testing/timingPageStories';
import { TimingPage } from './TimingPage';

/** Перемонтирование заново читает API, а не копирует текущую форму в видимость сохранённого результата. */
function TimingPageJourney() {
  const [epoch, setEpoch] = useState(0);
  return (
    <Stack spacing={2}>
      <ActionButton onClick={() => setEpoch((current) => current + 1)}>Открыть сохранённую страницу заново</ActionButton>
      <TimingPage key={epoch} />
    </Stack>
  );
}

const meta = {
  title: 'Страницы/Тайминги',
  component: TimingPage,
  tags: ['!autodocs'],
  parameters: { songframe: timingPageOptions(), controls: { disable: true } },
  render: () => <TimingPageJourney />
} satisfies Meta<typeof TimingPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Regular: Story = { name: 'Обычный режим по умолчанию' };

export const ManualBoundaryRoundTrip: Story = {
  tags: ['ci'],
  name: 'Ручной режим · 0–2.9 → 12–16 · перекрытие · исправление · точное сохранение',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const toggle = await canvas.findByRole('switch', { name: timingTexts.manualMode });
    await expect(toggle).not.toBeChecked();
    const before = timingPageInspection().saved;
    await userEvent.click(toggle);
    await expect(canvas.getByText(timingTexts.manualModeHint)).toBeVisible();
    const start = canvas.getByRole('textbox', { name: 'Начало строки 1' });
    const end = canvas.getByRole('textbox', { name: 'Конец строки 1' });
    await userEvent.clear(start);
    await userEvent.type(start, '12');
    await userEvent.tab();
    await expect(start).toHaveValue('12');
    await expect(end).toHaveValue('2.9');
    await expect(start).toHaveAttribute('aria-invalid', 'false');
    await expect(timingPageInspection()).toEqual({ requests: [], saved: before });
    await userEvent.clear(end);
    await userEvent.type(end, '16{Enter}');
    await expect(end).toHaveValue('16');
    await expect(canvas.queryByText(/Граница не изменена/)).not.toBeInTheDocument();
    await expect(timingPageInspection()).toEqual({ requests: [], saved: before });
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(await screen.findByText(timingTexts.main.overlappingLines({ first: 1, second: 3 }))).toBeVisible();
    await expect(start).toHaveValue('12');
    await expect(end).toHaveValue('16');
    await expect(timingPageInspection()).toEqual({ requests: [], saved: before });
    for (const [id, boundary, value] of [
      [2, 'Начало', '17'],
      [2, 'Конец', '19'],
      [3, 'Начало', '20'],
      [3, 'Конец', '23']
    ] as const) {
      const field = canvas.getByRole('textbox', { name: `${boundary} строки ${id}` });
      await userEvent.clear(field);
      await userEvent.type(field, value);
    }
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(await screen.findByText(timingTexts.saved)).toBeVisible();
    const expected = before.timing!.lines.map((line, index) => ({
      ...line,
      ...[
        { start: 12, end: 16 },
        { start: 17, end: 19 },
        { start: 20, end: 23 }
      ][index]
    }));
    await expect(timingPageInspection().requests).toEqual([{ ...before.timing, lines: expected }]);
    await expect(timingPageInspection().saved.timing?.lines).toEqual(expected);
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённую страницу заново' }));
    await expect(await canvas.findByRole('spinbutton', { name: 'Начало строки 1' })).toHaveValue(12);
    await expect(canvas.getByRole('spinbutton', { name: 'Конец строки 1' })).toHaveValue(16);
    await expect(canvas.getByRole('switch', { name: timingTexts.manualMode })).not.toBeChecked();
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
  }
};

export const ManualIncompleteBoundary: Story = {
  tags: ['ci'],
  name: 'Ручной режим · пустой и нечисловой ввод остаются до сохранения',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('switch', { name: timingTexts.manualMode }));
    const before = timingPageInspection().saved;
    const start = canvas.getByRole('textbox', { name: 'Начало строки 1' });
    const invalid = timingTexts.main.invalidBoundaries({ id: 1 });
    await userEvent.clear(start);
    await userEvent.tab();
    await expect(start).toHaveValue('');
    await expect(screen.queryByText(invalid)).not.toBeInTheDocument();
    await expect(timingPageInspection()).toEqual({ requests: [], saved: before });
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(await screen.findByText(invalid)).toBeVisible();
    await expect(start).toHaveValue('');
    await expect(timingPageInspection()).toEqual({ requests: [], saved: before });
    await userEvent.type(start, 'не время{Enter}');
    await expect(start).toHaveValue('не время');
    await expect(start).toHaveAttribute('aria-invalid', 'false');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(await screen.findByText(invalid)).toBeVisible();
    await expect(timingPageInspection()).toEqual({ requests: [], saved: before });
    await userEvent.click(canvas.getByRole('button', { name: timingTexts.discard }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: timingTexts.discard }));
    await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Начало строки 1' })).toHaveValue('0'));
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
  }
};

export const ManualSaveFailure: Story = {
  tags: ['ci'],
  name: 'Ручной режим · ошибка API сохраняет черновик · повтор успешен',
  parameters: { songframe: timingPageOptions({ failSaveOnce: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('switch', { name: timingTexts.manualMode }));
    const before = timingPageInspection().saved;
    const end = canvas.getByRole('textbox', { name: 'Конец строки 1' });
    await userEvent.clear(end);
    await userEvent.type(end, '2.5');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    const failure = await canvas.findByRole('alert', { name: timingTexts.saveProblemsTitle });
    await expect(within(failure).getByText(TIMING_PAGE_SAVE_ERROR)).toBeVisible();
    await expect(end).toHaveValue('2.5');
    await expect(timingPageInspection().saved).toEqual(before);
    await expect(timingPageInspection().requests).toHaveLength(1);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(await screen.findByText(timingTexts.saved)).toBeVisible();
    await expect(timingPageInspection().requests).toHaveLength(2);
    await expect(timingPageInspection().requests[1]).toEqual(timingPageInspection().requests[0]);
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённую страницу заново' }));
    await expect(await canvas.findByRole('spinbutton', { name: 'Конец строки 1' })).toHaveValue(2.5);
    await expect(canvas.getByRole('button', { name: commonTexts.save })).toBeDisabled();
  }
};
