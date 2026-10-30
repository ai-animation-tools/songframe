/** Взаимодействия с настоящими строками: границы, отметка на слух, заметка и подтверждение удаления. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { TimingStory, timingStoryOptions } from '../../../testing/timingStories';

const meta = {
  title: 'Тайминги/Строки разметки',
  component: TimingStory,
  tags: ['!autodocs'],
  parameters: { songframe: timingStoryOptions(), controls: { disable: true } },
  render: (args) => <TimingStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof TimingStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Regular: Story = { name: 'Черновик · подтверждённая строка · заметки' };
export const Empty: Story = { name: 'Нет строк разметки', args: { variant: 'empty' }, parameters: { songframe: timingStoryOptions({ variant: 'empty' }) } };
export const LongNarrow: Story = {
  name: 'Длинная строка · узкая рабочая область',
  args: { variant: 'long' },
  parameters: { songframe: { ...timingStoryOptions({ variant: 'long' }), workspaceWidth: 724 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = canvas.getByRole('region', { name: 'Строки разметки' });
    await expect(canvas.getByRole('columnheader', { name: 'Строка' }).getBoundingClientRect().width).toBeGreaterThanOrEqual(260);
    await expect(region.scrollWidth).toBeGreaterThan(region.clientWidth);
    region.focus();
    await expect(region).toHaveFocus();
    // userEvent не выполняет стандартную прокрутку браузера; проверяем её нативным DOM API.
    // Настоящие стрелки дополнительно проверяются при браузерной приёмке статической витрины.
    region.scrollBy({ left: 200 });
    await waitFor(() => expect(region.scrollLeft).toBeGreaterThan(0));
    await expect(canvasElement.ownerDocument.documentElement.scrollWidth).toBeLessThanOrEqual(canvasElement.ownerDocument.defaultView!.innerWidth);
  }
};
export const LongList: Story = {
  name: 'Длинная таблица · фокус и прокрутка · заголовки остаются видимыми',
  args: { variant: 'long-list' },
  parameters: { songframe: timingStoryOptions({ variant: 'long-list' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = canvas.getByRole('region', { name: 'Строки разметки' });
    await expect(canvas.getAllByRole('row')).toHaveLength(21);
    await expect(region.scrollHeight).toBeGreaterThan(region.clientHeight);
    region.focus();
    region.scrollBy({ top: 200 });
    await waitFor(() => expect(region.scrollTop).toBeGreaterThan(0));
    // Синтетическая стрелка проверяет, что глобальный обработчик не перехватывает управление таблицей.
    await userEvent.keyboard('{ArrowDown}');
    await expect(canvas.getByRole('status')).toHaveTextContent('Строка не выбрана');
    await expect(Math.abs(canvas.getByRole('columnheader', { name: '№' }).getBoundingClientRect().top - region.getBoundingClientRect().top)).toBeLessThan(2);
  }
};
export const BoundaryAndVerification: Story = {
  name: 'Границы соседей · подтверждение на слух · сохранить и открыть заново',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    let start = canvas.getByRole('spinbutton', { name: 'Начало строки 1' });
    await userEvent.clear(start);
    await userEvent.type(start, '1{Enter}');
    await expect(canvas.getByText('От 0.00 до 0.50 с. Граница не изменена.')).toBeInTheDocument();
    await expect(start).toHaveValue(0.3);
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await userEvent.clear(start);
    await userEvent.type(start, '0.4{Enter}');
    // Успешное применение перемонтирует поле по новому key границы.
    start = canvas.getByRole('spinbutton', { name: 'Начало строки 1' });
    await expect(start).toHaveValue(0.4);
    await expect(canvas.getByRole('spinbutton', { name: 'Конец строки 1' })).toHaveAttribute('max', '1.2');
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Подтвердить на слух строку 1' }));
    await expect(canvas.getByRole('textbox', { name: 'Примечание к строке 1' })).toHaveValue('сверка на слух выполнена; начало куплета');
    await expect(canvas.getByRole('status')).toHaveTextContent('Строка не выбрана');
    await userEvent.click(canvas.getByRole('button', { name: 'Сохранить' }));
    await canvas.findByText('Разметка сохранена');
    const note = canvas.getByRole('textbox', { name: 'Примечание к строке 1' });
    await userEvent.clear(note);
    await userEvent.type(note, 'Несохранённая заметка');
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённую разметку заново' }));
    await expect(canvas.getByRole('spinbutton', { name: 'Начало строки 1' })).toHaveValue(0.4);
    await expect(canvas.getByRole('checkbox', { name: 'Подтвердить на слух строку 1' })).toBeChecked();
    await expect(canvas.getByRole('textbox', { name: 'Примечание к строке 1' })).toHaveValue('сверка на слух выполнена; начало куплета');
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  }
};
export const RemoveAndCancel: Story = {
  name: 'Удалить строку · Escape сохраняет · подтверждение удаляет · отмена правок возвращает',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const remove = () => canvas.getByRole('button', { name: 'Убрать строку 1 из разметки' });
    await userEvent.click(remove());
    const dialog = within(await screen.findByRole('dialog'));
    await expect(dialog.getByText(/Исходный текст песни сохранится/)).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(remove()).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await userEvent.click(remove());
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Убрать' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.queryByRole('spinbutton', { name: 'Начало строки 1' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Отменить правки' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Отменить правки' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('spinbutton', { name: 'Начало строки 1' })).toHaveValue(0.3);
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  }
};
export const RemoveSaveReopen: Story = {
  name: 'Удалить первую строку · сохранить · открыть с новыми номерами',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    // Пробелы заметки обрезаются при сохранении, связь с физической строкой песни не меняется.
    const note = canvas.getByRole('textbox', { name: 'Примечание к строке 2' });
    await userEvent.clear(note);
    await userEvent.type(note, '  сверка на слух не выполнена; сохранить паузу  ');
    await userEvent.click(canvas.getByRole('button', { name: 'Убрать строку 1 из разметки' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Убрать' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: 'Сохранить' }));
    await canvas.findByText('Разметка сохранена');
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть сохранённую разметку заново' }));
    const firstRow = canvas.getByText('Сосед торопливо заводит мотор').closest('tr');
    const secondRow = canvas.getByText('И снова зовёт нас знакомая дорога').closest('tr');
    if (!firstRow || !secondRow) throw new Error('После открытия не найдены строки песни.');
    await expect(within(firstRow).getByRole('spinbutton', { name: 'Начало строки 1' })).toHaveValue(1.2);
    await expect(within(firstRow).getByRole('spinbutton', { name: 'Конец строки 1' })).toHaveValue(2.2);
    await expect(within(firstRow).getByRole('checkbox', { name: 'Подтвердить на слух строку 1' })).toBeChecked();
    await expect(within(firstRow).getByRole('textbox', { name: 'Примечание к строке 1' })).toHaveValue('сверка на слух выполнена; сохранить паузу');
    await expect(within(secondRow).getByRole('spinbutton', { name: 'Начало строки 2' })).toHaveValue(2.6);
    await expect(within(secondRow).getByRole('spinbutton', { name: 'Конец строки 2' })).toHaveValue(3.6);
    await expect(within(secondRow).getByRole('checkbox', { name: 'Подтвердить на слух строку 2' })).not.toBeChecked();
    await expect(canvas.queryByRole('spinbutton', { name: 'Начало строки 3' })).not.toBeInTheDocument();
    await expect(canvas.queryByText('У старых ворот начинается утро')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    // Проверяем и сериализованный снимок локального API: source_line остаётся номером исходного текста.
    const saved = await window.api.timing.view('storybook-timing');
    await expect(saved.timing?.lines).toEqual([
      { id: 1, source_line: 3, start: 1.2, end: 2.2, verified: true, note: 'сверка на слух выполнена; сохранить паузу' },
      { id: 2, source_line: 4, start: 2.6, end: 3.6, verified: false, note: '' }
    ]);
    await expect(saved.timing?.sections[0]).toEqual({ name: 'Куплет', start: 1.2, end: 3.6, note: 'строки 1–2' });
  }
};
export const SaveFailure: Story = {
  name: 'Ошибка сохранения · черновик остаётся · повтор успешен',
  args: { failSaveOnce: true },
  parameters: { songframe: timingStoryOptions({ failSaveOnce: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: 'Подтвердить на слух строку 1' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Сохранить' }));
    await canvas.findByText('Не удалось сохранить разметку. Правки остались в форме; повторите сохранение.');
    await expect(canvas.getByRole('checkbox', { name: 'Подтвердить на слух строку 1' })).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: 'Сохранить' }));
    await canvas.findByText('Разметка сохранена');
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  }
};
