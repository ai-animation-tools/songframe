/** Расход плана: попытки и отправки, суммы по источникам, неизвестный расход и стоимость секунды принятого материала. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { productionTexts } from '@shared/texts/production';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import type { ShotSpend } from '@shared/types';
import { DELIVERY_PROJECT } from '../../../testing/deliveryStories';
import { pageShot } from '../../../testing/productionPageStories';
import { createStoryApi, type StoryOptions } from '../../../testing/storybook';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { ShotSpendSummary } from './ShotSpendSummary';

const texts = productionTexts.shotSpend;
const EMPTY: ShotSpend = { attempts: 0, images: 0, videos: 0, rejected: 0, unknown: 0, manual: 0, totals: [], acceptedSeconds: null, perSecond: [] };

/** Принятый план: две попытки, опора и три видео, одно из них ручная генерация в рублях. */
const ACCEPTED: ShotSpend = {
  attempts: 2,
  images: 1,
  videos: 3,
  rejected: 2,
  unknown: 0,
  manual: 1,
  totals: [
    { provider: TEST_PROVIDER, unit: 'credits', amount: 24.5 },
    { provider: null, unit: 'RUB', amount: 120 }
  ],
  acceptedSeconds: 5,
  perSecond: [
    { provider: TEST_PROVIDER, unit: 'credits', amount: 4.9 },
    { provider: null, unit: 'RUB', amount: 24 }
  ]
};

/** План в работе: одна отправка с известным расходом, у второй исход неизвестен. */
const UNKNOWN: ShotSpend = { ...EMPTY, attempts: 2, videos: 2, unknown: 1, totals: [{ provider: TEST_PROVIDER, unit: 'credits', amount: 13 }] };

function options(spend: ShotSpend): StoryOptions {
  return {
    createApi: () => {
      const session = createStoryApi({ production: { spend: async () => structuredClone(spend) } });
      session.onCleanup(registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo));
      return session;
    }
  };
}

const meta = {
  title: 'Производство/Планы/Расход плана',
  component: ShotSpendSummary,
  tags: ['!autodocs'],
  args: { project: DELIVERY_PROJECT, shot: pageShot('M02') },
  parameters: { controls: { disable: true }, songframe: options(ACCEPTED) }
} satisfies Meta<typeof ShotSpendSummary>;
export default meta;
type Story = StoryObj<typeof meta>;

const provider = testProviderInfo.title;

export const Accepted: Story = {
  name: 'Принятый план · отклонённые варианты и стоимость секунды',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(texts.sends({ attempts: 2, videos: 3, images: 1 }));
    // Кредиты сервиса и рубли ручной генерации — отдельные суммы.
    await expect(canvas.getByText(`${texts.spent}: 24,5 кредита (${provider}) · 120 ₽ (${texts.manualSource})`)).toBeInTheDocument();
    await expect(canvas.getByText(texts.accepted({ seconds: '5,00', rejected: 2 }))).toBeInTheDocument();
    await expect(canvas.getByText(`${texts.perSecond}: 4,9 кредита (${provider}) · 24 ₽ (${texts.manualSource})`)).toBeInTheDocument();
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
  }
};

export const Unknown: Story = {
  name: 'План в работе · неизвестный расход не считается нулём',
  tags: ['ci'],
  parameters: { songframe: options(UNKNOWN) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(texts.unknown({ count: 1 }));
    await expect(canvas.getByText(`${texts.spent}: 13 кредитов (${provider})`)).toBeInTheDocument();
    // До приёмки нет ни отклонённых вариантов, ни стоимости секунды.
    await expect(canvas.queryByText(texts.perSecond, { exact: false })).not.toBeInTheDocument();
  }
};

export const NoSends: Story = {
  name: 'Без отправок · блока нет',
  parameters: { songframe: options(EMPTY) },
  play: async ({ canvasElement }) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(within(canvasElement).queryByText(texts.heading)).not.toBeInTheDocument();
  }
};
