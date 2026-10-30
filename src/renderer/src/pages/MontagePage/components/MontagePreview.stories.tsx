/** Нативный video и аудиочасы работают на подготовленных файлах, без сборки ролика. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { montageTexts } from '@shared/texts/montage';
import { MontagePreviewStory, MONTAGE_LOCKED_REASON } from '../../../testing/montageStories';
import type { StoryOptions } from '../../../testing/storybook';

const meta = {
  title: 'Монтаж/Предпросмотр',
  component: MontagePreviewStory,
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof MontagePreviewStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** IconButton показывает причину на фокусируемой обёртке: проверяем саму подсказку, а не несуществующий title кнопки. */
async function expectDisabledReason(button: HTMLElement, reason: string): Promise<void> {
  const wrapper = button.parentElement;
  if (!wrapper) throw new Error('Не найдена обёртка выключенной кнопки.');
  const screen = within(button.ownerDocument.body);
  await userEvent.hover(wrapper);
  await expect(await screen.findByRole('tooltip')).toHaveTextContent(reason);
  await userEvent.unhover(wrapper);
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
}

export const SeekAndFrames: Story = {
  name: 'Метаданные, покадровый шаг и перемотка между соседями',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const activeVideo = () => Array.from(canvasElement.querySelectorAll('video')).find((video) => video.style.visibility === 'visible');
    await waitFor(() => expect(canvas.getByTestId('preview-state')).toHaveTextContent('метаданные M01: 150'), { timeout: 10000 });
    await waitFor(() => expect(activeVideo()?.readyState).toBeGreaterThanOrEqual(2), { timeout: 10000 });
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.nextFrame }));
    await expect(canvas.getByTestId('preview-state')).toHaveTextContent('Кадр пробы: 1;');
    await waitFor(() => expect(Math.abs((activeVideo()?.currentTime ?? -1) - 16 / 30)).toBeLessThan(0.035));
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.previousFrame }));
    await expect(canvas.getByTestId('preview-state')).toHaveTextContent('Кадр пробы: 0;');
    const seek = canvas.getByRole('slider', { name: 'Позиция демонстрации' });
    seek.focus();
    await userEvent.keyboard('{End}');
    await expect(canvas.getByTestId('preview-state')).toHaveTextContent('Кадр пробы: 89;');
    await expect(activeVideo()?.getAttribute('src')).toContain('scene=M02');
    await waitFor(() => expect(Math.abs((activeVideo()?.currentTime ?? -1) - 74 / 30)).toBeLessThan(0.035));
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.toStart }));
    await expect(canvas.getByTestId('preview-state')).toHaveTextContent('Кадр пробы: 0;');
    await expect(canvas.getByRole('button', { name: montageTexts.play })).toBeEnabled();
    await waitFor(() => expect(Math.abs((activeVideo()?.currentTime ?? -1) - 0.5)).toBeLessThan(0.035));
  }
};

export const PlaybackAndCut: Story = {
  name: 'Воспроизведение и проверка склейки · настройки сохраняются',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const audio = canvasElement.querySelector('audio');
    await waitFor(() => expect(audio?.readyState).toBeGreaterThanOrEqual(2), { timeout: 10000 });
    await userEvent.click(canvas.getByRole('checkbox', { name: montageTexts.loop }));
    const volume = canvas.getByRole('slider', { name: montageTexts.volume });
    volume.focus();
    await userEvent.keyboard('{Home}');
    await expect(audio?.volume).toBe(0);
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.play }));
    await waitFor(() => expect(audio?.paused).toBe(false));
    await waitFor(() => expect(Number(canvas.getByTestId('preview-state').textContent?.match(/Кадр пробы: (\d+)/)?.[1])).toBeGreaterThan(1));
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.pause }));
    await expect(audio?.paused).toBe(true);
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.previewCut }));
    await waitFor(() => expect(audio?.paused).toBe(false));
    await userEvent.click(canvas.getByRole('button', { name: montageTexts.pause }));
    await expect(audio?.paused).toBe(true);
    await expect(canvas.getByTestId('preview-state')).toHaveTextContent('громкость: 0%; повтор: включён');
  }
};

export const CardThenVideo: Story = { name: 'Опора перед видео · реальное изображение', args: { card: true } };
export const MissingVideo: Story = {
  name: 'Недоступный оригинал · понятная ошибка файла',
  args: { missingVideo: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('Не удалось открыть видео M01'), { timeout: 10000 });
    await expect(canvas.getByRole('alert')).toHaveTextContent('недоступный-оригинал.mp4');
  }
};
export const NoTrack: Story = {
  name: 'Песня отсутствует · причина блокировки воспроизведения',
  args: { noTrack: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: montageTexts.play })).toBeDisabled();
    await expectDisabledReason(canvas.getByRole('button', { name: montageTexts.play }), montageTexts.noTrack);
    await expect(canvas.getByRole('button', { name: montageTexts.previewCut })).toBeDisabled();
  }
};
export const Suspended: Story = {
  name: 'Экспорт выполняется · плеер приостановлен',
  args: { suspended: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of [montageTexts.play, montageTexts.toStart, montageTexts.previousFrame, montageTexts.nextFrame, montageTexts.previewCut]) {
      await expect(canvas.getByRole('button', { name })).toBeDisabled();
      await expectDisabledReason(canvas.getByRole('button', { name }), MONTAGE_LOCKED_REASON);
    }
  }
};
export const Narrow: Story = {
  name: 'Узкая рабочая область · управление переносится',
  parameters: { songframe: { workspaceWidth: 580 } satisfies StoryOptions }
};
