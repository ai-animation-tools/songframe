/** Продолжение существующей попытки и ручное выяснение исхода никогда не выполняют новую платную отправку. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { RECEIVE_ERROR, receivingPackage, resultStoryOptions, ResumeStory } from '../../../testing/resultStories';

const meta = {
  title: 'Производство/Пакет/Получение результата',
  component: ResumeStory,
  // Подтверждение и галерея управляют фокусом: взаимодействия выполняются только в Canvas.
  tags: ['!autodocs'],
  parameters: { controls: { disable: true }, songframe: resultStoryOptions({ pkg: receivingPackage() }) }
} satisfies Meta<typeof ResumeStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ExistingId: Story = {
  name: 'Сохранённый ID · продолжение без новой отправки',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Продолжить получение' }));
    await expect(canvas.getByRole('button', { name: 'Продолжить получение' })).toBeDisabled();
    await canvas.findByText('Получение продолжено по ID: demo-video-01');
    await waitFor(() => expect(canvas.getByTestId('delivery-state')).toHaveTextContent('Статус: downloaded; ID: demo-video-01'));
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('получение: 1');
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('отправка: 0');
    await expect(canvas.getByText('Принять полученный результат?')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(canvas.getByRole('button', { name: 'Продолжить получение' })).toBeEnabled();
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('получение: 0');
  }
};

export const FailureRetry: Story = {
  name: 'Ошибка получения · повтор с тем же ID',
  parameters: { songframe: resultStoryOptions({ pkg: receivingPackage('download_failed'), failFirst: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Продолжить получение' }));
    await canvas.findByText(RECEIVE_ERROR);
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('Статус: download_failed; ID: demo-video-01');
    await userEvent.click(canvas.getByRole('button', { name: 'Продолжить получение' }));
    await waitFor(() => expect(canvas.getByTestId('delivery-state')).toHaveTextContent('Статус: downloaded; ID: demo-video-01'));
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('получение: 2');
    await expect(canvas.queryByText(RECEIVE_ERROR)).not.toBeInTheDocument();
  }
};

export const PartialDownload: Story = {
  name: 'Часть оригиналов получена · сохранить при продолжении',
  parameters: { songframe: resultStoryOptions({ pkg: receivingPackage('download_partial', { partial: true }), failFirst: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const original = canvasElement.querySelector('video');
    await expect(original).toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Принять' })).not.toBeInTheDocument();
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('оригиналов: 1');
    const source = original?.getAttribute('src');
    await userEvent.click(canvas.getByRole('button', { name: 'Продолжить получение' }));
    await canvas.findByText(RECEIVE_ERROR);
    await expect(canvasElement.querySelector('video')).toHaveAttribute('src', source);
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('Статус: download_partial');
    await expect(canvas.queryByRole('button', { name: 'Принять' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Продолжить получение' }));
    await waitFor(() => expect(canvas.getByTestId('delivery-state')).toHaveTextContent('Статус: downloaded'));
    await expect(canvasElement.querySelector('video')).toHaveAttribute('src', source);
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('оригиналов: 1');
  }
};

export const ImageExistingId: Story = {
  name: 'Изображение по сохранённому ID · кандидат требует отдельного выбора',
  parameters: { songframe: resultStoryOptions({ pkg: receivingPackage('outputs_pending', { kind: 'image' }) }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Получение изображения · опора K02/)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Продолжить получение' }));
    await canvas.findByRole('button', { name: 'Выбрать как опору' });
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('Статус: downloaded; ID: demo-image-01');
    await expect(canvas.getByText('Опора K02: кандидат не выбран; утверждена: false.')).toBeInTheDocument();
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('выбор кандидата: 0');
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('отправка: 0');
  }
};

export const UnknownAttach: Story = {
  name: 'Неизвестный исход без ID · файл из истории сервиса',
  parameters: { songframe: resultStoryOptions({ pkg: receivingPackage('submission_unknown', { unknown: true }) }, true) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'Продолжить получение' })).not.toBeInTheDocument();
    // Ручной результат доступен без сети: файл уже скачан пользователем из истории сервиса.
    await userEvent.click(canvas.getByRole('button', { name: 'Загрузить результат вручную' }));
    await waitFor(() => expect(canvas.getByTestId('delivery-state')).toHaveTextContent('Статус: downloaded; ID: нет; ручной результат: true'));
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('выбор файлов: 1');
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('отправка: 0');
    await expect(canvasElement.querySelector('video')).toBeInTheDocument();
  }
};

export const CancelFilePicker: Story = {
  name: 'Ручной выбор отменён · попытка не меняется',
  parameters: { songframe: resultStoryOptions({ pkg: receivingPackage('submitting', { unknown: true }), cancelPicker: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Загрузить результат вручную' }));
    await waitFor(() => expect(canvas.getByTestId('delivery-state')).toHaveTextContent('выбор файлов: 1'));
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('Статус: submitting; ID: нет; ручной результат: false; оригиналов: 0');
    await expect(canvas.getByRole('button', { name: 'Задание не создано' })).toBeEnabled();
  }
};

export const NotCreated: Story = {
  name: 'Задание не создано · отмена, подтверждение и новый вопрос',
  parameters: { songframe: resultStoryOptions({ pkg: receivingPackage('submission_unknown', { unknown: true }) }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: 'Задание не создано' }));
    let dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(within(dialog).getByText(/повторная отправка спишет кредиты ещё раз/)).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('Статус: submission_unknown');
    await userEvent.click(canvas.getByRole('button', { name: 'Задание не создано' }));
    dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toBeVisible());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Задание не создано' }));
    await canvas.findByText(/Требуются новая оценка стоимости и отдельное подтверждение отправки/);
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('Статус: prepared; ID: нет');
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('отправка: 0');
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить модель' }));
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Задание не создано' })).toBeEnabled();
  }
};

export const ManualInterrupted: Story = {
  name: 'Ручной оригинал уже сохранён · восстановить вопрос после прерывания',
  parameters: { songframe: resultStoryOptions({ pkg: receivingPackage('downloaded', { manual: true }) }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'Загрузить результат вручную' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Продолжить получение' }));
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'Продолжить получение' })).not.toBeInTheDocument());
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('Статус: downloaded; ID: нет; ручной результат: true; оригиналов: 1');
    await expect(canvas.getByTestId('delivery-state')).toHaveTextContent('выбор файлов: 0');
  }
};

export const Busy: Story = {
  name: 'Занято · ручные решения заблокированы',
  args: { busy: true },
  parameters: { songframe: resultStoryOptions({ pkg: receivingPackage('submission_unknown', { unknown: true }) }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Загрузить результат вручную' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Задание не создано' })).toBeDisabled();
  }
};

export const Offline: Story = {
  name: 'Без сети · получение по ID недоступно',
  parameters: { songframe: resultStoryOptions({ pkg: receivingPackage() }, true) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: 'Продолжить получение' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', expect.stringMatching(/сети|интернет/i));
  }
};

export const ProviderUnavailable: Story = {
  name: 'Программа провайдера отсутствует · причина блокировки',
  args: { providerAvailable: false },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Продолжить получение' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', expect.stringContaining('Программа Тестовый сервис не найдена'));
  }
};
