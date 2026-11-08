/** Плеер трека на настоящем MP3 витрины: запуск, пауза, громкость, перемотка и отсутствующий файл. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { storyFileUrl } from '../testing/storybook';
import { AudioPlayer } from './AudioPlayer';

const texts = commonTexts.player;
const meta = {
  title: 'Общие/Плеер трека',
  component: AudioPlayer,
  tags: ['!autodocs'],
  args: { src: storyFileUrl('story-track.mp3'), duration: 10 },
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof AudioPlayer>;
export default meta;
type Story = StoryObj<typeof meta>;

function audioOf(canvasElement: HTMLElement): HTMLAudioElement {
  const audio = canvasElement.querySelector('audio');
  if (!audio) throw new Error('Плеер истории не создал audio.');
  return audio;
}

export const Playback: Story = {
  tags: ['ci'],
  name: 'Запуск · громкость · перемотка · пауза',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const audio = audioOf(canvasElement);
    // Известная длительность видна до метаданных, затем её уточняет сам файл.
    await waitFor(() => expect(canvas.getByText(/^0:00\.00 \/ 0:30\.\d\d$/)).toBeInTheDocument(), { timeout: 10000 });
    const volume = canvas.getByRole('slider', { name: texts.volume });
    await expect(volume).toHaveAttribute('aria-valuenow', '100');
    volume.focus();
    await userEvent.keyboard('{PageDown}');
    await waitFor(() => expect(audio.volume).toBeCloseTo(0.9));
    await expect(volume).toHaveAttribute('aria-valuetext', texts.volumePercent({ value: 90 }));
    const position = canvas.getByRole('slider', { name: texts.position });
    fireEvent.change(position, { target: { value: '12' } });
    await waitFor(() => expect(audio.currentTime).toBeCloseTo(12, 0));
    await userEvent.click(canvas.getByRole('button', { name: texts.play }));
    await waitFor(() => expect(audio.paused).toBe(false));
    await waitFor(() => expect(audio.currentTime).toBeGreaterThan(12.1), { timeout: 5000 });
    await userEvent.click(canvas.getByRole('button', { name: texts.pause }));
    await waitFor(() => expect(audio.paused).toBe(true));
    await expect(canvas.getByRole('button', { name: texts.play })).toBeInTheDocument();
    await expect(audio.volume).toBeCloseTo(0.9);
  }
};

export const MissingFile: Story = {
  name: 'Файла нет · понятная ошибка',
  args: { src: storyFileUrl('missing-track.mp3'), duration: 10 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(texts.loadFailed, {}, { timeout: 10000 })).toBeInTheDocument();
    await expect(canvas.getByText(/^0:00\.00 \/ 0:10\.00$/)).toBeInTheDocument();
  }
};
