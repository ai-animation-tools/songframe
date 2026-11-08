/** Проверяем отчёт, настоящее видео, доступность отдельной приёмки и жизненный цикл hook. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { videoReviewTexts } from '@shared/texts/video-review';
import { VIDEO_REVIEW_ERROR, VideoReviewStory, videoReviewStoryOptions } from '../../../testing/videoReviewStories';

const meta = {
  title: 'Производство/Пакет/Проверка видео агентом',
  component: VideoReviewStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true }, songframe: videoReviewStoryOptions() }
} satisfies Meta<typeof VideoReviewStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const StartAndReopen: Story = {
  name: 'Запуск · сохранённый отчёт после повторного открытия',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(videoReviewTexts.status.idle);
    await waitFor(() => expect(canvas.getByRole('button', { name: videoReviewTexts.start })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: videoReviewTexts.start }));
    await canvas.findByText(videoReviewTexts.status.preparing);
    await expect(canvas.getByRole('button', { name: 'Принять' })).toBeEnabled();
    await canvas.findByText(videoReviewTexts.verdict.mismatch, {}, { timeout: 6000 });
    await expect(canvas.getByTestId('review-accepts')).toHaveTextContent('Подтверждений приёмки: 0');
    await userEvent.click(canvas.getByRole('button', { name: 'Закрыть результат' }));
    await expect(canvas.queryByText(videoReviewTexts.heading)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть результат' }));
    await canvas.findByText(videoReviewTexts.verdict.mismatch);
    await expect(canvas.getByRole('button', { name: videoReviewTexts.repeat })).toBeEnabled();
  }
};

export const Evidence: Story = {
  name: 'Наблюдения · таймкод оригинала и галерея кадров',
  tags: ['ci'],
  parameters: { songframe: videoReviewStoryOptions({ status: 'completed' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await canvas.findByText(videoReviewTexts.verdict.uncertain);
    const video = canvasElement.querySelector('video');
    await waitFor(() => expect(video?.duration).toBe(8));
    await userEvent.click(canvas.getByRole('button', { name: 'Перейти к 0:02.50 в исходном видео' }));
    await waitFor(() => expect(video?.currentTime).toBeCloseTo(2.5));
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть крупно: Кадр F002 · 0:02.50' }));
    let dialog = await screen.findByRole('dialog');
    await expect(within(dialog).getByRole('img')).toHaveAttribute('src', expect.stringContaining('frame=2'));
    await userEvent.keyboard('{ArrowRight}');
    await expect(within(dialog).getByRole('img')).toHaveAttribute('src', expect.stringContaining('frame=3'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: 'Открыть крупно: Кадр F001 · 0:00.00' }));
    dialog = await screen.findByRole('dialog');
    await expect(within(dialog).getByRole('img')).toHaveAttribute('src', expect.stringContaining('frame=1'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Закрыть' }));
    await expect(canvas.getByTestId('review-accepts')).toHaveTextContent('Подтверждений приёмки: 0');
  }
};

export const Cancel: Story = {
  name: 'Остановка проверки · приёмка остаётся отдельной',
  tags: ['ci'],
  parameters: { songframe: videoReviewStoryOptions({ status: 'running' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: videoReviewTexts.cancel }));
    await canvas.findByText(videoReviewTexts.status.cancelled);
    await expect(canvas.getByRole('button', { name: videoReviewTexts.repeat })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Принять' })).toBeEnabled();
    await expect(canvas.getByTestId('review-accepts')).toHaveTextContent('Подтверждений приёмки: 0');
  }
};

export const StartFailure: Story = {
  name: 'Ошибка запуска · повтор с сохранённым оригиналом',
  tags: ['ci'],
  parameters: { songframe: videoReviewStoryOptions({ failFirst: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(videoReviewTexts.status.idle);
    await waitFor(() => expect(canvas.getByRole('button', { name: videoReviewTexts.start })).toBeEnabled());
    const original = canvasElement.querySelector('video')?.getAttribute('src');
    await userEvent.click(canvas.getByRole('button', { name: videoReviewTexts.start }));
    const panel = within(canvas.getByRole('region', { name: videoReviewTexts.heading }));
    await panel.findByText(VIDEO_REVIEW_ERROR);
    await expect(canvasElement.querySelector('video')).toHaveAttribute('src', original);
    await expect(canvas.getByRole('button', { name: 'Принять' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: videoReviewTexts.start }));
    await canvas.findByText(videoReviewTexts.verdict.match, {}, { timeout: 6000 });
    await expect(panel.queryByText(VIDEO_REVIEW_ERROR)).not.toBeInTheDocument();
  }
};

export const ReadFailure: Story = {
  name: 'Ошибка чтения · восстановление сохранённого отчёта',
  tags: ['ci'],
  parameters: { songframe: videoReviewStoryOptions({ status: 'completed', failRead: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: videoReviewTexts.refresh }));
    await canvas.findByText(videoReviewTexts.verdict.match);
    await expect(canvas.queryByText('Не удалось прочитать сохранённый отчёт.')).not.toBeInTheDocument();
  }
};

export const Stale: Story = {
  name: 'Исходники изменились · отчёт помечен устаревшим',
  parameters: { songframe: videoReviewStoryOptions({ status: 'completed', stale: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(videoReviewTexts.main.stale);
    await expect(canvas.getByRole('button', { name: videoReviewTexts.repeat })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Принять' })).toBeEnabled();
  }
};

export const Failed: Story = {
  name: 'Ошибка агента · новый запуск доступен',
  parameters: { songframe: videoReviewStoryOptions({ status: 'failed' }) }
};

export const Accepted: Story = {
  name: 'Видео принято · сохранённый отчёт доступен для просмотра',
  args: { accepted: true },
  parameters: { songframe: videoReviewStoryOptions({ status: 'completed' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(videoReviewTexts.verdict.mismatch);
    await expect(canvas.queryByRole('button', { name: 'Принять' })).not.toBeInTheDocument();
  }
};

export const LongReport: Story = {
  name: 'Длинный отчёт · раскрытие наблюдений',
  parameters: { songframe: videoReviewStoryOptions({ status: 'completed', longReport: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const expand = await canvas.findByRole('button', { name: videoReviewTexts.showAll });
    await expect(canvas.queryByText('Дополнительное наблюдение 4.')).not.toBeInTheDocument();
    await userEvent.click(expand);
    await canvas.findByText('Дополнительное наблюдение 4.');
    await userEvent.click(canvas.getByRole('button', { name: videoReviewTexts.showLess }));
    await expect(canvas.queryByText('Дополнительное наблюдение 4.')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: videoReviewTexts.refresh })).toBeEnabled();
  }
};

export const RefreshAvailability: Story = {
  name: 'Чужое задание завершилось · обновление доступности без закрытия',
  tags: ['ci'],
  parameters: { songframe: videoReviewStoryOptions({ initiallyBusy: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(videoReviewTexts.status.idle);
    await expect(canvas.getByRole('button', { name: videoReviewTexts.start })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: videoReviewTexts.start })).toHaveAttribute('title', expect.stringContaining(videoReviewTexts.main.busy));
    await userEvent.click(canvas.getByRole('button', { name: videoReviewTexts.refresh }));
    await waitFor(() => expect(canvas.getByRole('button', { name: videoReviewTexts.start })).toBeEnabled());
    await expect(canvas.getByTestId('review-accepts')).toHaveTextContent('Подтверждений приёмки: 0');
  }
};

export const RefreshFailedStatus: Story = {
  name: 'Перечитать ошибку · видимый отклик без нового анализа',
  tags: ['ci'],
  parameters: { songframe: videoReviewStoryOptions({ status: 'failed', slowRefresh: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(videoReviewTexts.status.failed);
    const panel = within(canvas.getByRole('region', { name: videoReviewTexts.heading }));
    const refresh = panel.getByRole('button', { name: videoReviewTexts.refresh });
    // Общая подсказка кнопки убирает конечную точку, сохраняя оба предложения.
    await expect(refresh).toHaveAttribute('title', 'Перечитывает сохранённый статус и отчёт. Не запускает агента повторно');
    await userEvent.click(refresh);
    await panel.findByRole('progressbar', { name: videoReviewTexts.refreshing });
    await expect(panel.getByRole('button', { name: videoReviewTexts.repeat })).toBeDisabled();
    await within(canvasElement.ownerDocument.body).findByText(videoReviewTexts.refreshedFailed);
    await expect(panel.getByRole('button', { name: videoReviewTexts.refresh })).toBeEnabled();
    await expect(panel.getByText(VIDEO_REVIEW_ERROR)).toBeInTheDocument();
    await expect(canvas.getByTestId('review-agent-calls')).toHaveTextContent('Запусков агента: 0; отмен: 0');
  }
};
