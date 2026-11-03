/** Просмотр оригиналов, отдельный выбор кандидата и приёмка используют рабочие блоки и локальную модель API. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { receivedPackage, RESULT_ERROR, resultStoryOptions, ResultStory } from '../../../testing/resultStories';

const meta = {
  title: 'Производство/Пакет/Полученный результат',
  component: ResultStory,
  // Последовательности галереи и подтверждения переводят фокус и предназначены для Canvas.
  tags: ['!autodocs'],
  parameters: { controls: { disable: true }, songframe: resultStoryOptions() }
} satisfies Meta<typeof ResultStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const VideoPreview: Story = {
  name: 'Видео получено полностью · просмотр и создание сводки',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const video = canvasElement.querySelector('video');
    await expect(video).toBeInTheDocument();
    await waitFor(() => expect(video?.duration).toBe(8));
    await video?.play();
    await waitFor(() => expect(video?.paused).toBe(false));
    video?.pause();
    await userEvent.click(canvas.getByRole('button', { name: 'Сделать техническую сводку' }));
    await canvas.findByRole('button', { name: /Открыть крупно: Техническая сводка.*summary=1/ });
    await expect(canvas.queryByRole('button', { name: 'Сделать техническую сводку' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Принять' })).toBeEnabled();
  }
};

export const SummaryGallery: Story = {
  name: 'Техническая сводка · галерея, клавиатура и повторное открытие',
  parameters: { songframe: resultStoryOptions({ pkg: receivedPackage('video', { previews: true }) }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /Открыть крупно: Техническая сводка.*summary=1/ }));
    let dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(within(dialog).getByRole('button', { name: 'Предыдущее изображение' })).toBeDisabled();
    await userEvent.keyboard('{ArrowRight}');
    await expect(within(dialog).getByRole('img')).toHaveAttribute('src', expect.stringContaining('summary=2'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Оригинальный размер (1:1)' }));
    await expect(within(dialog).getByRole('button', { name: 'Оригинальный размер (1:1)' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: /Открыть крупно: Техническая сводка.*summary=1/ }));
    dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(within(dialog).getByRole('img')).toHaveAttribute('src', expect.stringContaining('summary=1'));
    await expect(within(dialog).getByRole('button', { name: 'Оригинальный размер (1:1)' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }
};

export const AcceptVideo: Story = {
  name: 'Принять видео · отмена и отдельное подтверждение участка',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Принять' }));
    let dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(within(dialog).getByText(/Оригинал длиной 8,00 с не совпадает с окном плана 5,00 с/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('приёмка: 0');
    await userEvent.click(canvas.getByRole('button', { name: 'Принять' }));
    dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toBeVisible());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Принять' }));
    await canvas.findByText(/Результат принят в assets\/shots\/M02/);
    await expect(canvas.queryByRole('button', { name: 'Принять' })).not.toBeInTheDocument();
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('приёмка: 1');
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.getByRole('button', { name: 'Принять' })).toBeEnabled();
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }
};

export const ZeroSectionRetry: Story = {
  tags: ['ci'],
  name: 'Нулевой участок · ошибка без приёмки и повтор с исходным результатом',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    const original = canvasElement.querySelector('video')?.getAttribute('src');
    await userEvent.click(canvas.getByRole('button', { name: 'Принять' }));
    let dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toBeVisible());
    const end = within(dialog).getByRole('spinbutton', { name: 'Конец, с' });
    await userEvent.clear(end);
    await userEvent.type(end, '0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await canvas.findByText('Конец участка должен быть позже начала.');
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('приёмка: 0');
    await expect(canvasElement.querySelector('video')).toHaveAttribute('src', original);
    await expect(canvas.queryByText(/Результат принят в assets/)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Принять' }));
    dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(within(dialog).getByRole('spinbutton', { name: 'Конец, с' })).toHaveValue(5);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Принять' }));
    await canvas.findByText(/Результат принят в assets\/shots\/M02/);
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('приёмка: 1');
    await expect(canvas.queryByText('Конец участка должен быть позже начала.')).not.toBeInTheDocument();
  }
};

export const ReopenAndReview: Story = {
  name: 'Вернуть вопрос · перейти к монтажной пробе с оригиналом',
  args: { showDecision: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Вернуть вопрос о результате' }));
    await canvas.findByText('Принять полученный результат?');
    await expect(canvas.queryByRole('button', { name: 'Вернуть вопрос о результате' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Собрать пробу' }));
    const route = await canvas.findByText(/Открыт маршрут: \/project\/montage/);
    await expect(route).toHaveTextContent('shots=M01,M02,M03');
    await expect(route).toHaveTextContent('source=M02%3Aplan%2Fbatches%2FM02-video-attempt-01');
    await expect(route).toHaveTextContent('Вопрос о результате сохранён');
    await expect(canvas.getByText('Принять полученный результат?')).toBeInTheDocument();
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('приёмка: 0');
  }
};

export const ChooseImage: Story = {
  name: 'Изображения · галерея и выбор кандидата без утверждения опоры',
  parameters: { songframe: resultStoryOptions({ pkg: receivedPackage('image') }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /Открыть крупно: K02 · вариант 2/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(within(dialog).getByRole('img')).toHaveAttribute('src', expect.stringContaining('variant=2'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(canvas.getAllByRole('button', { name: 'Выбрать как опору' })[1]);
    await canvas.findByText('Утвердить опору K02?');
    await expect(canvas.getByText('Опора K02: кандидат выбран; утверждена: false.')).toBeInTheDocument();
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('выбор кандидата: 1');
    await expect(canvas.getAllByRole('button', { name: 'Выбрать как опору' })[0]).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Утвердить K02' })).toBeEnabled();
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('приёмка: 0');
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.getByText('Опора K02: кандидат не выбран; утверждена: false.')).toBeInTheDocument();
    await expect(canvas.getAllByRole('button', { name: 'Выбрать как опору' })[1]).toBeEnabled();
  }
};

export const MissingImageToken: Story = {
  name: 'Изображения без resultToken · выбор заблокирован',
  parameters: { songframe: resultStoryOptions({ pkg: receivedPackage('image', { token: false }) }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const button of canvas.getAllByRole('button', { name: 'Выбрать как опору' })) {
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('title', expect.stringContaining('Данные показанного результата не подтверждены'));
    }
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('выбор кандидата: 0');
  }
};

export const MissingVideoToken: Story = {
  name: 'Видео без resultToken · подтверждение приёмки заблокировано',
  parameters: { songframe: resultStoryOptions({ pkg: receivedPackage('video', { token: false }) }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Принять' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toBeVisible());
    const button = within(dialog).getByRole('button', { name: 'Принять' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', expect.stringContaining('Данные показанного результата не подтверждены'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('приёмка: 0');
  }
};

export const Busy: Story = {
  name: 'Занято · просмотр доступен, приёмка и запись заблокированы',
  args: { busy: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelector('video')).toHaveAttribute('controls');
    for (const name of ['Принять', 'Вернуть вопрос о результате', 'Сделать техническую сводку']) {
      await expect(canvas.getByRole('button', { name })).toBeDisabled();
    }
  }
};

export const SummaryFailureRetry: Story = {
  name: 'Ошибка создания сводки · оригинал сохраняется для повтора',
  parameters: { songframe: resultStoryOptions({ failFirst: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const original = canvasElement.querySelector('video')?.getAttribute('src');
    await userEvent.click(canvas.getByRole('button', { name: 'Сделать техническую сводку' }));
    await canvas.findByText(RESULT_ERROR);
    await expect(canvasElement.querySelector('video')).toHaveAttribute('src', original);
    await expect(canvas.getByRole('button', { name: 'Принять' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Сделать техническую сводку' }));
    await canvas.findByRole('button', { name: /Открыть крупно: Техническая сводка.*summary=1/ });
    await expect(canvas.queryByText(RESULT_ERROR)).not.toBeInTheDocument();
  }
};
