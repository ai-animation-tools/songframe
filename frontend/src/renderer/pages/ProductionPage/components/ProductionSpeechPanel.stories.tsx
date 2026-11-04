/** Срез речи плана с липсинком: предложение по разметке, пределы провайдера и подготовка WAV. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { platformTexts } from '@shared/texts/platform';
import { productionTexts } from '@shared/texts/production';
import type { SpeechPlan } from '@shared/types';
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

/** Модель speechPlan/prepareSpeech; вызовы вырезки накапливаются в prepared. */
function speechOptions(unavailable: StoryOptions['unavailable'] = []): StoryOptions {
  return {
    unavailable,
    createApi: () => ({
      production: {
        speechPlan: async () => structuredClone(plan),
        prepareSpeech: async () => structuredClone(pkg)
      }
    })
  };
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

export const CutNotMigrated: Story = {
  name: 'Вырезка не перенесена · кнопка объясняет причину',
  tags: ['ci'],
  parameters: { songframe: speechOptions(['production.prepareSpeech']) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/У старых ворот/);
    const prepare = canvas.getByRole('button', { name: texts.prepare });
    await expect(prepare).toBeDisabled();
    await expect(prepare).toHaveAttribute('title', expect.stringContaining(platformTexts.unavailable));
  }
};
