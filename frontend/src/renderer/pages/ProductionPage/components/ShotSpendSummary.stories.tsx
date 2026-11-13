/** Расход плана: бейджи сумм и пометок, окно «Расход Mxx» с записями и правкой своей цены. */
import { useState, type ReactElement } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { productionTexts } from '@shared/texts/production';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import type { ShotSpend, ShotSpendBadge } from '@shared/types';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { DELIVERY_PROJECT } from '../../../testing/deliveryStories';
import { pageShot } from '../../../testing/productionPageStories';
import { createSpendModel, emptySpend, spendBadge, spendEntry } from '../../../testing/spendStories';
import { createStoryApi, type StoryOptions } from '../../../testing/storybook';
import { ShotSpendSummary } from './ShotSpendSummary';

const texts = productionTexts.shotSpend;
const provider = testProviderInfo.title;

/** Принятый план: два видео сервиса по 13 кредитов (принято второе), опора сервиса за 2 кредита и своя опора без цены. */
const ACCEPTED: ShotSpend = {
  ...emptySpend(),
  attempts: 2,
  images: 1,
  videos: 2,
  ownImages: 1,
  rejected: 1,
  acceptedSeconds: 5,
  entries: [
    spendEntry('M02', { provider: TEST_PROVIDER, amount: 13, unit: 'credits', removed: true }),
    spendEntry('M02', { provider: TEST_PROVIDER, amount: 13, unit: 'credits', accepted: true, removed: true }),
    spendEntry('M02', { kind: 'image', provider: TEST_PROVIDER, amount: 2, unit: 'credits', removed: true }),
    spendEntry('M02', { kind: 'image', status: 'manual', frame: 'K01', editable: true, removed: true })
  ]
};

/** Своё видео без цены, принято. */
const UNPRICED: ShotSpend = {
  ...emptySpend(),
  attempts: 1,
  videos: 1,
  manual: 1,
  acceptedSeconds: 4,
  entries: [spendEntry('M02', { status: 'manual', accepted: true, editable: true, removed: true })]
};

/** Принят до начала учёта расхода: записей нет. */
const MISSING: ShotSpend = { ...emptySpend(), missing: true, unpriced: 1, acceptedSeconds: 4 };

/** План в работе: сервис не сообщил списание. */
const UNKNOWN: ShotSpend = {
  ...emptySpend(),
  attempts: 1,
  videos: 1,
  entries: [spendEntry('M02', { provider: TEST_PROVIDER, status: 'unknown', editable: true })]
};

/** Бейдж в шапке перечитывается после правки, как вид страницы после load(). */
function SpendHarness({ initial }: { initial: ShotSpendBadge | null }): ReactElement {
  const [badge, setBadge] = useState(initial);
  const shot = pageShot('M02', { spend: badge });
  return (
    <ShotSpendSummary
      project={DELIVERY_PROJECT}
      shot={shot}
      onChanged={() => void window.api.production.spend(DELIVERY_PROJECT, 'M02').then((spend) => setBadge(spendBadge('M02', spend)))}
    />
  );
}

function options(spend: ShotSpend): StoryOptions {
  return {
    createApi: () => {
      const model = createSpendModel({ M02: spend });
      const session = createStoryApi({
        production: {
          spend: async (_project, shot) => model.spend(shot),
          setSpendAmount: async (_project, ref, amount, unit) => model.setAmount(ref, amount, unit),
          priceAccepted: async (_project, shot, amount, unit) => model.priceAccepted(shot, amount, unit)
        }
      });
      session.onCleanup(registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo));
      return session;
    }
  };
}

function initialBadge(spend: ShotSpend): ShotSpendBadge {
  return spendBadge('M02', createSpendModel({ M02: spend }).spend('M02'));
}

const meta = {
  title: 'Производство/Планы/Расход плана',
  component: SpendHarness,
  tags: ['!autodocs'],
  args: { initial: initialBadge(ACCEPTED) },
  parameters: { controls: { disable: true }, songframe: options(ACCEPTED) }
} satisfies Meta<typeof SpendHarness>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Открывает окно «Расход M02». */
async function openDialog(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: texts.open }));
  return within(await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: texts.title({ shot: 'M02' }) }));
}

/** Вводит стоимость в открытый редактор окна и сохраняет. */
async function enterCost(dialog: ReturnType<typeof within>, amount: string, unit: string): Promise<void> {
  const field = dialog.getByRole('spinbutton', { name: productionTexts.manualGeneration.cost });
  await userEvent.clear(field);
  await userEvent.type(field, amount);
  await userEvent.click(dialog.getByRole('combobox', { name: productionTexts.manualGeneration.unit }));
  await userEvent.click(await within(document.body).findByRole('option', { name: unit }));
  await userEvent.click(dialog.getByRole('button', { name: texts.save }));
}

export const Accepted: Story = {
  name: 'Принятый план · суммы бейджами, записи видео и опор, цена своей опоры',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const chips = within(within(canvasElement).getByTestId('shot-spend'));
    // Видео и опора сервиса — одна сумма в его кредитах; своя опора без цены тревоги не вызывает.
    await expect(chips.getByText('28 кредитов')).toBeInTheDocument();
    await expect(chips.queryByText(texts.chipUnpriced)).not.toBeInTheDocument();
    const dialog = await openDialog(canvasElement);
    await expect(dialog.getByText(texts.acceptedTotal({ seconds: '5,00', rejected: 1 }))).toBeInTheDocument();
    await expect(dialog.getByText(`${texts.perSecond}: 5,6 кредита (${provider})`)).toBeInTheDocument();
    await expect(dialog.getAllByText(texts.videoSent({ source: provider }))).toHaveLength(2);
    await expect(dialog.getByText(`${texts.acceptedMark} · ${texts.removed}`)).toBeInTheDocument();
    // Списание сервиса не правится: кнопка есть только у своей опоры.
    await expect(dialog.getAllByRole('button', { name: new RegExp(`^(${texts.set}|${texts.edit}):`) })).toHaveLength(1);
    await userEvent.click(dialog.getByRole('button', { name: `${texts.set}: ${texts.ownFrame({ frame: 'K01' })}` }));
    await enterCost(dialog, '50', '₽');
    await expect(await dialog.findByText('50 ₽')).toBeInTheDocument();
    await waitFor(() => expect(chips.getByText('50 ₽')).toBeInTheDocument());
    await expect(chips.getByText('28 кредитов')).toBeInTheDocument();
  }
};

export const Unpriced: Story = {
  name: 'Своё видео без цены · заметный бейдж, цена указывается в окне',
  tags: ['ci'],
  args: { initial: initialBadge(UNPRICED) },
  parameters: { songframe: options(UNPRICED) },
  play: async ({ canvasElement }) => {
    const chips = within(within(canvasElement).getByTestId('shot-spend'));
    await expect(chips.getByText(texts.chipUnpriced)).toBeInTheDocument();
    const dialog = await openDialog(canvasElement);
    await expect(dialog.getByText(texts.unpriced({ count: 1 }))).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: `${texts.set}: ${texts.videoManual}` }));
    await enterCost(dialog, '150', '₽');
    await waitFor(() => expect(chips.getByText('150 ₽')).toBeInTheDocument());
    await expect(chips.queryByText(texts.chipUnpriced)).not.toBeInTheDocument();
    // Исправление: та же запись, другая цена; «Снять цену» возвращает пометку.
    await userEvent.click(dialog.getByRole('button', { name: `${texts.edit}: ${texts.videoManual}` }));
    await userEvent.click(dialog.getByRole('button', { name: texts.clear }));
    await waitFor(() => expect(chips.getByText(texts.chipUnpriced)).toBeInTheDocument());
  }
};

export const AcceptedWithoutEntry: Story = {
  name: 'Принят до учёта расхода · цена принятого видео по комплекту',
  tags: ['ci'],
  args: { initial: initialBadge(MISSING) },
  parameters: { songframe: options(MISSING) },
  play: async ({ canvasElement }) => {
    const chips = within(within(canvasElement).getByTestId('shot-spend'));
    await expect(chips.getByText(texts.chipUnpriced)).toBeInTheDocument();
    const dialog = await openDialog(canvasElement);
    await expect(dialog.getByText(texts.missing)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: texts.priceAccepted }));
    await enterCost(dialog, '300', 'кредиты');
    await waitFor(() => expect(chips.getByText('300 кредитов')).toBeInTheDocument());
    await expect(dialog.queryByText(texts.missing)).not.toBeInTheDocument();
    await expect(dialog.getByText(texts.videoKit)).toBeInTheDocument();
  }
};

export const UnknownCharge: Story = {
  name: 'Списание неизвестно · сумму можно указать самому',
  tags: ['ci'],
  args: { initial: initialBadge(UNKNOWN) },
  parameters: { songframe: options(UNKNOWN) },
  play: async ({ canvasElement }) => {
    const chips = within(within(canvasElement).getByTestId('shot-spend'));
    await expect(chips.getByText(texts.chipUnknown)).toBeInTheDocument();
    const dialog = await openDialog(canvasElement);
    await expect(dialog.getByText(texts.unknown({ count: 1 }))).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: `${texts.set}: ${texts.videoSent({ source: provider })}` }));
    await enterCost(dialog, '20', 'кредиты');
    await waitFor(() => expect(chips.getByText('20 кредитов')).toBeInTheDocument());
    await expect(dialog.getByText(texts.userAmount)).toBeInTheDocument();
  }
};

export const NoSpend: Story = {
  name: 'Без расхода · блока нет',
  args: { initial: null },
  parameters: { songframe: options(emptySpend()) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByTestId('shot-spend')).not.toBeInTheDocument();
  }
};
