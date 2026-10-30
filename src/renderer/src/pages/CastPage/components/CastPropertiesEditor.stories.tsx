/** Ручное редактирование словаря использует рабочую валидацию и сохранённый снимок общей модели. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CastStory, castStoryOptions } from '../../../testing/castStories';

const meta = {
  title: 'Кастинг/Словарь свойств',
  component: CastStory,
  tags: ['!autodocs'],
  args: { mode: 'properties' },
  parameters: { songframe: castStoryOptions(), controls: { disable: true } },
  render: (args) => <CastStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof CastStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Поля монтируются до завершения анимации: ждём раскрытия, чтобы клик не пришёлся на соседнюю строку. */
async function openDictionary(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: /Словарь свойств/ }));
  await waitFor(() => expect(canvas.getByRole('textbox', { name: /^Код нового свойства/ }).closest('.MuiCollapse-root')).toHaveClass('MuiCollapse-entered'));
}

export const Dictionary: Story = { name: 'Типы · значения · проверка · использование у сущностей' };
export const EmptyDictionary: Story = { name: 'Нет словаря · создание первого свойства', args: { variant: 'no-dictionary' } };
export const NoKinds: Story = { name: 'Нет типов и сущностей', args: { variant: 'no-kinds' } };
export const LongTexts: Story = { name: 'Длинные подписи и подсказки', args: { variant: 'long' } };
export const InvalidDictionary: Story = { name: 'Пустая подпись и повтор кода · сохранение запрещено', args: { variant: 'invalid' } };
export const AddValidateSave: Story = {
  name: 'Добавить свойство · валидация · сохранение фиксирует код',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openDictionary(canvasElement);
    const key = canvas.getByRole('textbox', { name: /^Код нового свойства/ });
    const label = canvas.getByRole('textbox', { name: /^Подпись(?:\s*\*)?$/ });
    // При смене disabled рабочая ActionButton создаёт новый узел; старую ссылку не сохраняем.
    const add = () => canvas.getByRole('button', { name: 'Добавить свойство' });
    await userEvent.type(key, 'clothes');
    await expect(key).toHaveValue('clothes');
    await userEvent.type(label, 'Головной убор');
    await expect(label).toHaveValue('Головной убор');
    await expect(canvas.getByText('Свойство с кодом «clothes» уже есть в словаре этого типа.')).toBeInTheDocument();
    await expect(add()).toBeDisabled();
    await userEvent.clear(key);
    await userEvent.type(key, 'Bad-Key');
    await expect(key).toHaveValue('Bad-Key');
    await expect(add()).toBeDisabled();
    await userEvent.clear(key);
    await userEvent.type(key, 'hat');
    await expect(key).toHaveValue('hat');
    await expect(add()).toBeEnabled();
    await userEvent.click(add());
    const freshCode = canvas.getByRole('textbox', { name: /^Код(?:\s*\*)?$/ });
    await expect(freshCode).toHaveValue('hat');
    await expect(canvas.getByText('Словарь изменён')).toBeInTheDocument();
    // У новой строки код ещё редактируется; повтор немедленно блокирует общее сохранение.
    await userEvent.clear(freshCode);
    await userEvent.type(freshCode, 'clothes');
    await expect(freshCode).toHaveValue('clothes');
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await userEvent.clear(freshCode);
    await userEvent.type(freshCode, 'hat');
    await expect(freshCode).toHaveValue('hat');
    await userEvent.click(canvas.getByRole('button', { name: 'Сохранить' }));
    await canvas.findByText('Кастинг сохранён в локальную модель.');
    await expect(canvas.queryByRole('textbox', { name: /^Код(?:\s*\*)?$/ })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Изменить свойство «Головной убор»' }));
    await expect(canvas.queryByRole('textbox', { name: /^Код(?:\s*\*)?$/ })).not.toBeInTheDocument();
    await expect(canvas.getAllByRole('textbox', { name: /^Подпись(?:\s*\*)?$/ })[0]).toHaveValue('Головной убор');
  }
};
export const RemoveUsedProperty: Story = {
  name: 'Используемое свойство · отменить удаление и подтвердить',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await openDictionary(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Удалить свойство «Одежда»' }));
    let dialog = within(await screen.findByRole('dialog'));
    await expect(dialog.getByText(/2/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Удалить свойство «Одежда»' }));
    dialog = within(await screen.findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.queryByRole('button', { name: 'Удалить свойство «Одежда»' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
    const states = within(canvas.getByRole('region', { name: 'Начальные состояния сущностей' }));
    await expect(states.getByText(/Олег: clothes = Синяя куртка/)).toBeInTheDocument();
    await expect(states.getByText(/Дядя Паша: clothes = Светлая рубашка/)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await openDictionary(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Удалить свойство «Одежда»' })).toBeInTheDocument();
  }
};
