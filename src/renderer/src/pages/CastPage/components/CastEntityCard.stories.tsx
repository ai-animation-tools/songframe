/** Карточки используют общую модель черновика, сохранения и привязок референсов. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { CastStory, castStoryOptions } from '../../../testing/castStories';

const meta = {
  title: 'Кастинг/Карточка сущности',
  component: CastStory,
  tags: ['!autodocs'],
  parameters: { songframe: castStoryOptions(), controls: { disable: true } },
  render: (args) => <CastStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof CastStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Entity: Story = { name: 'Персонаж · изображения · начальное состояние' };
export const Collapsed: Story = { name: 'Свёрнутые карточки разных сущностей', args: { collapsed: true } };
export const NoImages: Story = { name: 'Нет изображений · можно привязать общий референс', args: { variant: 'no-images' } };
export const BrokenImage: Story = { name: 'Утраченный файл · путь привязки сохранён', args: { variant: 'broken-image' } };
export const LongNames: Story = {
  name: 'Длинные имя, код, роль и описание',
  args: { variant: 'long' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = canvas.getByRole('button', { name: /Олег Александрович.*председатель/, expanded: true });
    const card = heading.closest('[data-cast-entity]')!;
    // Документ может не прокручиваться, хотя статус уже вышел за рамку центрированной карточки.
    await waitFor(() => {
      const bounds = card.getBoundingClientRect();
      for (const item of heading.querySelectorAll('.MuiChip-root, .MuiAccordionSummary-expandIconWrapper')) {
        const rect = item.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
        expect(rect.right).toBeLessThanOrEqual(bounds.right);
      }
    });
    await userEvent.click(heading);
    await waitFor(() => expect(heading).toHaveAttribute('aria-expanded', 'false'));
    await userEvent.click(heading);
    await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Название' })).toBeVisible());
  }
};
export const WithoutDictionary: Story = { name: 'Нет словаря · свои свойства состояния', args: { variant: 'no-dictionary' } };
export const World: Story = {
  name: 'Мир сцены · код, тип и удаление заблокированы',
  args: { variant: 'world' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('textbox', { name: 'Код' })).toBeDisabled();
    await expect(canvas.getByRole('combobox', { name: 'Тип' })).toHaveAttribute('aria-disabled', 'true');
    await expect(canvas.getByRole('button', { name: /Удалить.*Мир сцены/ })).toBeDisabled();
    await userEvent.clear(canvas.getByRole('textbox', { name: 'Название' }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'Название' }), 'Вечерний мир');
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
  }
};
export const SaveAndRetry: Story = {
  name: 'Правка → запрет генерации → ошибка сохранения → повтор',
  args: { failSaveOnce: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = canvas.getByRole('textbox', { name: 'Название' });
    // ActionButton меняет обёртку при блокировке: после перехода ищем текущий DOM-узел.
    const save = () => canvas.getByRole('button', { name: 'Сохранить' });
    const generate = () => canvas.getByRole('button', { name: 'Сгенерировать изображение' });
    await expect(save()).toBeDisabled();
    await expect(generate()).toBeEnabled();
    await userEvent.clear(name);
    await userEvent.type(name, 'Олег после правки');
    await expect(canvas.getByText('Есть несохранённые правки', { exact: true })).toBeInTheDocument();
    await expect(generate()).toBeDisabled();
    await userEvent.click(save());
    await canvas.findByText('Не удалось сохранить кастинг. Черновик сохранён в форме; повторите сохранение.');
    await expect(name).toHaveValue('Олег после правки');
    await expect(save()).toBeEnabled();
    await expect(generate()).toBeDisabled();
    await userEvent.click(save());
    await canvas.findByText('Кастинг сохранён в локальную модель.');
    await expect(save()).toBeDisabled();
    await expect(generate()).toBeEnabled();
    await userEvent.click(generate());
    await canvas.findByText('Запрошено открытие диалога для «Олег после правки». Генерация не запускалась.');
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.getByRole('textbox', { name: 'Название' })).toHaveValue('Олег');
  }
};
export const SharedReference: Story = {
  name: 'Общий референс · снять только одну привязку',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /Убрать изображение.*Общий референс/ }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Убрать' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.queryByRole('button', { name: /Убрать изображение.*Общий референс/ })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
    // Разворачиваем соседа: общий исходник и его отдельная привязка остаются доступны.
    await userEvent.click(canvas.getByRole('button', { name: /Дядя Паша.*pasha/ }));
    await canvas.findByRole('button', { name: /Убрать изображение.*Общий референс/ });
    await userEvent.click(canvas.getByRole('button', { name: /Олег.*oleg/ }));
    await waitFor(() => expect(canvas.getAllByRole('combobox', { name: 'Добавить из исходников' })).toHaveLength(1));
    await userEvent.click(canvas.getByRole('combobox', { name: 'Добавить из исходников' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Общий референс — вечерний свет' }));
    await expect(canvas.getByRole('button', { name: /Убрать изображение.*Общий референс/ })).toBeInTheDocument();
    // Возврат той же привязки восстанавливает исходный порядок и снимает dirty.
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  }
};
export const PrimaryReference: Story = {
  name: 'Основное изображение · сменить и восстановить порядок',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Олег — профиль' }));
    const thumbnail = canvasElement.querySelector('[data-cast-entity="oleg"] .MuiAccordionSummary-root img');
    await expect(thumbnail).toHaveAttribute('src', expect.stringContaining('view=side'));
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Сгенерировать изображение' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Олег — анфас' }));
    await expect(thumbnail).toHaveAttribute('src', expect.stringContaining('view=front'));
    await expect(canvas.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  }
};
