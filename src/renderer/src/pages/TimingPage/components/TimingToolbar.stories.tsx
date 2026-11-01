/** Панель показывает настоящие причины недоступности, а массовое подтверждение остаётся черновиком до сохранения. */
import { timingTexts } from '@shared/texts/timing';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { TimingStory, timingStoryOptions } from '../../../testing/timingStories';

const meta = {
  title: 'Тайминги/Действия и причины',
  component: TimingStory,
  tags: ['!autodocs'],
  parameters: { songframe: timingStoryOptions(), controls: { disable: true } },
  render: (args) => <TimingStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof TimingStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MissingTrack: Story = {
  name: 'Нет трека · подсказка недоступной разметки',
  args: { variant: 'missing-track' },
  parameters: { songframe: timingStoryOptions({ variant: 'missing-track' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const generate = canvas.getByRole('button', { name: 'Разметить' });
    await expect(generate).toBeDisabled();
    // ActionButton оборачивает disabled-кнопку в доступный для фокуса span с подсказкой.
    await userEvent.hover(generate.parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent('Сначала добавьте трек на странице «Исходники».');
  }
};
export const InvalidBindings: Story = {
  name: 'Изменён текст песни · сохранение недоступно',
  args: { variant: 'invalid-bindings' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Подтвердить на слух строку 1' }));
    const save = canvas.getByRole('button', { name: 'Сохранить' });
    await expect(save).toBeDisabled();
    await userEvent.hover(save.parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent('Текст песни изменился: сначала повторите автоматическую разметку.');
  }
};
export const VerifyAllAndDiscard: Story = {
  name: 'Подтвердить все · причина блокировки · отмена диалога · отмена правок',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Подтвердить все' }));
    for (const checkbox of canvas.getAllByRole('checkbox')) await expect(checkbox).toBeChecked();
    const verify = canvas.getByRole('button', { name: 'Подтвердить все' });
    await expect(verify).toBeDisabled();
    await userEvent.hover(verify.parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent('Все строки уже подтверждены.');
    await userEvent.unhover(verify.parentElement!);
    await userEvent.click(canvas.getByRole('button', { name: 'Отменить правки' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Отменить правки' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Отменить правки' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('checkbox', { name: 'Подтвердить на слух строку 1' })).not.toBeChecked();
    await expect(canvas.getByRole('checkbox', { name: 'Подтвердить на слух строку 2' })).toBeChecked();
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  }
};

export const ManualModeToggle: Story = {
  tags: ['ci'],
  name: 'Ручной режим · переключение без правок и сохранения',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole('switch', { name: timingTexts.manualMode });
    await expect(toggle).not.toBeChecked();
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    const before = await window.api.timing.view('storybook-timing');
    await userEvent.click(toggle);
    await expect(toggle).toBeChecked();
    await expect(canvas.getByText(timingTexts.manualModeHint)).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Начало строки 1' })).toHaveValue('0.3');
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await userEvent.click(toggle);
    await expect(toggle).not.toBeChecked();
    await expect(canvas.queryByText(timingTexts.manualModeHint)).not.toBeInTheDocument();
    await expect(canvas.getByRole('spinbutton', { name: 'Начало строки 1' })).toHaveValue(0.3);
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await expect(await window.api.timing.view('storybook-timing')).toEqual(before);
  }
};
