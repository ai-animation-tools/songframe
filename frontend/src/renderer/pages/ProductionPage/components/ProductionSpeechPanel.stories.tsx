/** Срез речи плана с липсинком: предложение по разметке, пределы провайдера и подготовка WAV. */
import { useState, type ComponentProps, type ReactElement } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { productionTexts } from '@shared/texts/production';
import type { PackageView, SpeechPlan } from '@shared/types';
import { formatClock } from '../../../format';
import { DELIVERY_PROJECT, deliveryPackage } from '../../../testing/deliveryStories';
import type { StoryOptions } from '../../../testing/storybook';
import { ProductionSpeechPanel } from './ProductionSpeechPanel';

const texts = productionTexts.productionSpeechPanel;
const pkg = { ...deliveryPackage('video', 'prepared'), speech: null };
const plan: SpeechPlan = {
  shot: pkg.shot,
  window: { start: 12, end: 17 },
  lines: [{ start: 12.4, end: 15.1, text: 'У старых ворот' }],
  proposed: { start: 12, end: 17 },
  lipSync: { min: 2, max: 10 }
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
function speechOptions(): StoryOptions {
  return {
    createApi: () => {
      const inspection: SpeechInspection = { prepared: [], pkg: structuredClone(pkg) };
      activeInspection = inspection;
      return {
        production: {
          speechPlan: async () => structuredClone(plan),
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
