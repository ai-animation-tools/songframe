/** Срез речи плана с липсинком: предложение по разметке, пределы провайдера и подготовка WAV. */
import { useState, type ComponentProps, type ReactElement } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { productionTexts } from '@shared/texts/production';
import type { PackageView, SpeechPlan } from '@shared/types';
import { formatClock } from '../../../format';
import { DELIVERY_PROJECT, deliveryPackage } from '../../../testing/deliveryStories';
import { STORY_TRACK_PATH, type StoryOptions } from '../../../testing/storybook';
import { ProductionSpeechPanel } from './ProductionSpeechPanel';

const texts = productionTexts.productionSpeechPanel;
const pkg = { ...deliveryPackage('video', 'prepared'), speech: null };
const plan: SpeechPlan = {
  shot: pkg.shot,
  window: { start: 12, end: 17 },
  lines: [{ start: 12.4, end: 15.1, text: 'У старых ворот' }],
  proposed: { start: 12, end: 17 },
  lipSync: { min: 2, max: 10 },
  track: STORY_TRACK_PATH
};

interface SpeechInspection {
  /** Границы каждого вызова prepareSpeech. */
  prepared: ({ start: number; end: number } | undefined)[];
  /** Пакет после последней вырезки, как его перечитает родитель. */
  pkg: PackageView;
}
let activeInspection: SpeechInspection | null = null;

function speechInspection(): SpeechInspection {
  if (!activeInspection) throw new Error('Модель среза речи не открыта.');
  return activeInspection;
}

/** Модель speechPlan/prepareSpeech: вырезка записывает срез в audio/ пакета и возвращает пакет со speech. */
function speechOptions(overrides: Partial<SpeechPlan> = {}): StoryOptions {
  return {
    createApi: () => {
      const inspection: SpeechInspection = { prepared: [], pkg: structuredClone(pkg) };
      activeInspection = inspection;
      return {
        production: {
          speechPlan: async () => structuredClone({ ...plan, ...overrides }),
          prepareSpeech: async (_project, dir, bounds) => {
            inspection.prepared.push(bounds);
            const range = bounds ?? plan.proposed!;
            inspection.pkg = {
              ...inspection.pkg,
              speech: {
                // Basename совпадает с треком витрины: плеер среза получает настоящее медиа.
                path: `${dir}/audio/story-track.mp3`,
                recipe: `${dir}/audio/audio-recipe.json`,
                start: range.start,
                end: range.end,
                lines: plan.lines.filter((line) => line.end > range.start && line.start < range.end)
              }
            };
            return structuredClone(inspection.pkg);
          }
        }
      };
    }
  };
}

/** Родитель перечитывает пакет после вырезки: панель получает его speech, как на странице производства. */
function PreparedSpeechStory(props: ComponentProps<typeof ProductionSpeechPanel>): ReactElement {
  const [current, setCurrent] = useState(props.pkg);
  return (
    <ProductionSpeechPanel
      {...props}
      pkg={current}
      onPrepared={async () => {
        await props.onPrepared();
        setCurrent(speechInspection().pkg);
      }}
    />
  );
}

const meta = {
  title: 'Производство/Пакет/Срез речи',
  component: ProductionSpeechPanel,
  tags: ['!autodocs'],
  args: { project: DELIVERY_PROJECT, pkg, busy: false, onPrepared: fn() },
  parameters: { controls: { disable: true }, songframe: speechOptions() }
} satisfies Meta<typeof ProductionSpeechPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Proposed: Story = {
  name: 'Предложение по разметке · подготовка WAV',
  tags: ['ci'],
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/У старых ворот/);
    const prepare = canvas.getByRole('button', { name: texts.prepare });
    await waitFor(() => expect(prepare).toBeEnabled());
    await userEvent.click(prepare);
    await waitFor(() => expect(args.onPrepared).toHaveBeenCalledTimes(1));
  }
};

export const PreparedCut: Story = {
  name: 'Срез подготовлен · пакет со speech и повторная обрезка',
  tags: ['ci'],
  render: (args) => <PreparedSpeechStory {...args} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/У старых ворот/);
    // Пользователь сокращает срез: в пакет уходят именно введённые границы.
    const end = canvas.getByRole('textbox', { name: texts.cutEnd });
    await userEvent.clear(end);
    await userEvent.type(end, '16');
    await userEvent.click(canvas.getByRole('button', { name: texts.prepare }));
    await waitFor(() => expect(speechInspection().prepared).toEqual([{ start: 12, end: 16 }]));
    await waitFor(() => expect(args.onPrepared).toHaveBeenCalledTimes(1));
    await canvas.findByText(texts.ready({ start: formatClock(12), end: formatClock(16), seconds: texts.seconds(4) }));
    await expect(canvasElement.querySelector('audio')).toHaveAttribute('src', expect.stringContaining('media/story-track.mp3'));
    // Готовый срез показывает свои границы и предлагает обрезать заново, а не подготовить впервые.
    await expect(canvas.queryByRole('button', { name: texts.prepare })).toBeNull();
    await expect(canvas.getByRole('textbox', { name: texts.cutEnd })).toHaveValue('16');
    await userEvent.click(canvas.getByRole('button', { name: texts.timing }));
    await expect(canvas.getByRole('textbox', { name: texts.cutEnd })).toHaveValue('17');
    await userEvent.click(canvas.getByRole('button', { name: texts.recut }));
    await waitFor(() =>
      expect(speechInspection().prepared).toEqual([
        { start: 12, end: 16 },
        { start: 12, end: 17 }
      ])
    );
    await canvas.findByText(texts.ready({ start: formatClock(12), end: formatClock(17), seconds: texts.seconds(5) }));
  }
};

/** Скрытый плеер трека песни: прослушивание участка идёт через него, без записи файлов. */
const trackAudio = (canvasElement: HTMLElement): HTMLAudioElement => {
  const audio = canvasElement.querySelector<HTMLAudioElement>('audio[hidden]');
  if (!audio) throw new Error('Нет плеера трека песни.');
  return audio;
};

export const ListenSegment: Story = {
  name: 'Слушать участок · играет от начала, останавливается на конце и по кнопке',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/У старых ворот/);
    const audio = trackAudio(canvasElement);
    await expect(audio).toHaveAttribute('src', expect.stringContaining('media/story-track.mp3'));
    // Короткий участок: проигрывание само останавливается на введённом конце.
    const end = canvas.getByRole('textbox', { name: texts.cutEnd });
    await userEvent.clear(end);
    await userEvent.type(end, '12,6');
    await userEvent.click(await canvas.findByRole('button', { name: texts.listen }));
    await expect(await canvas.findByRole('button', { name: texts.stop })).toBeInTheDocument();
    await expect(canvas.getByRole('timer', { name: texts.position })).toHaveTextContent(/^0:12/);
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.listen })).toBeInTheDocument(), { timeout: 4000 });
    await expect(audio.paused).toBe(true);
    await expect(audio.currentTime).toBeGreaterThanOrEqual(12.6);
    await expect(audio.currentTime).toBeLessThan(12.9);
    await expect(canvas.queryByRole('timer')).toBeNull();

    // Каждое нажатие играет текущие значения полей; «Остановить» прерывает сразу.
    await userEvent.clear(end);
    await userEvent.type(end, '17');
    await userEvent.click(canvas.getByRole('button', { name: texts.listen }));
    await userEvent.click(await canvas.findByRole('button', { name: texts.stop }));
    await expect(await canvas.findByRole('button', { name: texts.listen })).toBeInTheDocument();
    await expect(audio.paused).toBe(true);
    await expect(audio.currentTime).toBeLessThan(14);
    // Прослушивание ничего не режет.
    await expect(speechInspection().prepared).toEqual([]);
  }
};

export const ListenUnavailable: Story = {
  name: 'Слушать участок · нет трека песни, неверные границы',
  tags: ['ci'],
  parameters: { songframe: speechOptions({ track: null }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/У старых ворот/);
    const listen = canvas.getByRole('button', { name: texts.listen });
    await expect(listen).toBeDisabled();
    await expect(listen).toHaveAttribute('title', expect.stringContaining(texts.noTrack));
    await expect(canvasElement.querySelector('audio')).toBeNull();
  }
};

export const ListenInvalidRange: Story = {
  name: 'Слушать участок · конец раньше начала',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/У старых ворот/);
    const end = canvas.getByRole('textbox', { name: texts.cutEnd });
    await userEvent.clear(end);
    await userEvent.type(end, '11');
    await waitFor(() => expect(canvas.getByRole('button', { name: texts.listen })).toBeDisabled());
    await expect(canvas.getByRole('button', { name: texts.listen })).toHaveAttribute('title', expect.stringContaining(texts.invalidRange));
  }
};
