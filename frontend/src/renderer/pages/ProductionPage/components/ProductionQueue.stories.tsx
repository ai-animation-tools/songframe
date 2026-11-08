/** Открытие очереди выбирает запрос, удаление повреждённой папки требует отдельного подтверждения. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ProductionQueueStory, brokenPackage, queuedPackage, DELETE_ERROR } from '../../../testing/productionQueueStories';

const meta = {
  title: 'Производство/Очередь/Сохранённые запросы',
  component: ProductionQueueStory,
  // Подтверждение удаления использует фокус собственного Canvas.
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } },
  render: (args) => <ProductionQueueStory key={JSON.stringify(args)} {...args} />
} satisfies Meta<typeof ProductionQueueStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  name: 'Очередь пуста · сброс фильтра',
  args: { initialPackages: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Показать все планы' }));
    await expect(canvas.getByText('Фильтр: Все планы. Отправок генерации: 0.')).toBeInTheDocument();
  }
};
export const SavedRequests: Story = {
  name: 'Image и video · открытие не отправляет запрос',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByRole('button', { name: 'Открыть запрос' })[0]);
    await expect(canvas.getByText(/Открыт запрос M02 · опора K02: plan\/awaiting\/M02-image-01/)).toBeInTheDocument();
    await userEvent.click(canvas.getAllByRole('button', { name: 'Открыть запрос' })[1]);
    await expect(canvas.getByText(/Открыт запрос M02: plan\/awaiting\/M02-video-01/)).toBeInTheDocument();
    await expect(canvas.getByText('Фильтр: Очередь. Отправок генерации: 0.')).toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Отправить' })).not.toBeInTheDocument();
  }
};
export const Selected: Story = { name: 'Выбран сохранённый видеозапрос', args: { initialSelected: queuedPackage().dir } };
export const Busy: Story = {
  name: 'Занято · просмотр разрешён, удаление заблокировано',
  args: { busy: true, initialBroken: [brokenPackage()] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Удалить папку' })).toBeDisabled();
    await expect(canvas.getAllByRole('button', { name: 'Открыть запрос' })[0]).toBeEnabled();
  }
};
export const Broken: Story = { name: 'Повреждённая папка · запрос открыть нельзя', args: { initialPackages: [], initialBroken: [brokenPackage()] } };
export const DeleteBroken: Story = {
  name: 'Удаление повреждённой папки · отмена и подтверждение',
  args: { initialBroken: [brokenPackage()], initialSelected: queuedPackage().dir },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Удалить папку' }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByText('Очередь (3)')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Удалить папку' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить папку' }));
    await canvas.findByText('Удалена повреждённая папка: plan/awaiting/M02-broken. Выбор сохранён.');
    await expect(canvas.getByText('Очередь (2)')).toBeInTheDocument();
    await expect(canvas.getByText(/Открыт запрос M02: plan\/awaiting\/M02-video-01/)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.getByText('Очередь (3)')).toBeInTheDocument();
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }
};
export const DeleteFailure: Story = {
  name: 'Ошибка удаления · папка сохранена для повтора',
  args: { initialPackages: [], initialBroken: [brokenPackage()], failFirst: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const remove = async (): Promise<void> => {
      await userEvent.click(canvas.getByRole('button', { name: 'Удалить папку' }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить папку' }));
    };
    await remove();
    await canvas.findByText(DELETE_ERROR);
    await expect(canvas.getByText('Очередь (1)')).toBeInTheDocument();
    await remove();
    await canvas.findByText('Очередь (0)');
    await expect(canvas.queryByText(DELETE_ERROR)).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Удалить папку' })).not.toBeInTheDocument();
  }
};
export const LongPaths: Story = {
  name: 'Длинные пути и ошибка повреждённой папки',
  args: {
    initialPackages: [queuedPackage('video', 'сохранённый-видеозапрос-с-полным-названием-постановки-и-длинным-пояснением-вечернего-освещения')],
    initialBroken: [
      brokenPackage({
        relative: 'plan/awaiting/M02-незавершённая-подготовка-пакета-с-длинным-названием-папки',
        reason: 'Не удалось прочитать workflow.json после прерванного сохранения: обязательное поле текущего этапа отсутствует'
      })
    ]
  }
};
