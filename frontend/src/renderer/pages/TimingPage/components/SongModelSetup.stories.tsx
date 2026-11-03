/** Установка и повтор используют рабочий компонент и локальные Jobs; модели не скачиваются. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn, expect, userEvent, waitFor, within } from 'storybook/test';
import { songTimingTexts as texts } from '@shared/texts/song-timing';
import { timingPageOptions } from '../../../testing/timingPageStories';
import { SongModelSetup } from './SongModelSetup';
const meta = {
  title: 'Тайминги/Модель уточнения границ',
  component: SongModelSetup,
  tags: ['!autodocs'],
  args: { onReady: fn(), onJob: fn() },
  parameters: { songframe: timingPageOptions({ local: 'download' }), controls: { disable: true } }
} satisfies Meta<typeof SongModelSetup>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Download: Story = {
  name: 'Явная загрузка · статус готовности',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // ActionButton снимает обёртку подсказки при разблокировке: каждый раз читаем текущий узел.
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.install })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: texts.install }));
    const progress = await canvas.findByRole('status', { name: texts.download });
    await expect(progress).toHaveTextContent(texts.downloadingAlignment);
    await expect(progress).not.toHaveTextContent('25%');
    const log = canvas.getByText(/alignment\.onnx: 25%/);
    await expect(log).not.toBeVisible();
    await userEvent.click(within(log.closest('details')!).getByText(texts.technicalLog));
    await expect(log).toBeVisible();
    await expect(log).toHaveTextContent('diagnostic-only');
    await expect(await canvas.findByText(texts.installed, {}, { timeout: 5000 })).toBeVisible();
  }
};
export const DownloadFailureRetry: Story = {
  name: 'Ошибка загрузки · повтор продолжает установку',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'download-failure' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // ActionButton снимает обёртку подсказки при разблокировке: каждый раз читаем текущий узел.
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.install })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: texts.install }));
    await expect(await canvas.findByText('Загрузка прервана. Повторите загрузку для продолжения.', {}, { timeout: 5000 })).toBeVisible();
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.install })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: texts.install }));
    await expect(await canvas.findByText(texts.installed, {}, { timeout: 5000 })).toBeVisible();
  }
};
export const Installed: Story = { name: 'Комплект уже установлен', parameters: { songframe: timingPageOptions({ local: 'installed' }) } };
export const Offline: Story = {
  name: 'Нет сети · загрузка заблокирована',
  parameters: { songframe: { ...timingPageOptions({ local: 'download' }), app: { ...timingPageOptions({ local: 'download' }).app, online: false } } },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('button', { name: texts.install })).toBeDisabled();
  }
};

export const SetupFailureRetry: Story = {
  name: 'Ошибка чтения комплекта · повтор возвращает явную загрузку',
  tags: ['ci'],
  parameters: { songframe: timingPageOptions({ local: 'setup-failure' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Не удалось проверить файлы моделей. Повторите чтение.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: texts.install })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: texts.retryRead }));
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.install })).toBeEnabled());
    await expect(canvas.queryByText('Не удалось проверить файлы моделей. Повторите чтение.')).not.toBeInTheDocument();
  }
};
