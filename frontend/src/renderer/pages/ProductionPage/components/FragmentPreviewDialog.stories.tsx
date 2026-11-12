/** Фрагмент под музыку: выбор диапазона планов, задание сборки и просмотр результата в общем плеере. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { productionTexts } from '@shared/texts/production';
import { formatClock } from '../../../format';
import { DELIVERY_PROJECT } from '../../../testing/deliveryStories';
import { FRAGMENT_FAILURE, fragmentModel, type FragmentModel } from '../../../testing/fragmentStories';
import { pageShot } from '../../../testing/productionPageStories';
import { createStoryApi, type StoryOptions } from '../../../testing/storybook';
import { FragmentPreviewDialog } from './FragmentPreviewDialog';

const texts = productionTexts.fragmentPreview;
const SHOTS = [
  pageShot('M01', { title: 'Ворота', start: 0, end: 4.2 }),
  pageShot('M02', { title: 'Двор', start: 4.2, end: 9.5, asset: null }),
  pageShot('M03', { title: 'Огород', start: 9.5, end: 14 }),
  pageShot('M04', { title: 'Закат', start: 14, end: 18.75, asset: null })
];
const models = new WeakMap<object, FragmentModel>();
/** Задание опрашивается раз в секунду: результат ждём дольше стандартной секунды поиска. */
const JOB_TIMEOUT = { timeout: 4000 };

function options(fail = false): StoryOptions {
  return {
    createApi: () => {
      const model = fragmentModel({ fail });
      const session = createStoryApi(model.overrides);
      models.set(session.api, model);
      session.onCleanup(model.dispose);
      return session;
    }
  };
}

const meta = {
  title: 'Производство/Фрагмент под музыку',
  component: FragmentPreviewDialog,
  tags: ['!autodocs'],
  args: { open: true, project: DELIVERY_PROJECT, shots: SHOTS, initialShot: 'M02', onClose: fn() },
  parameters: { controls: { disable: true }, songframe: options() }
} satisfies Meta<typeof FragmentPreviewDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Диалог в портале MUI: поиск по документу, а не по канве истории. */
const page = (): ReturnType<typeof within> => within(document.body);

export const Build: Story = {
  name: 'Диапазон планов · сборка и просмотр',
  tags: ['ci'],
  play: async ({ args }) => {
    const screen = page();
    await screen.findByText(texts.description);
    // По умолчанию — выбранный на странице план и его участок песни.
    await screen.findByText(texts.window({ start: formatClock(4.2), end: formatClock(9.5) }));
    await userEvent.click(screen.getByRole('combobox', { name: texts.to }));
    await userEvent.click(await screen.findByRole('option', { name: 'M04 · Закат' }));
    await screen.findByText(texts.window({ start: formatClock(4.2), end: formatClock(18.75) }));
    // Последний план раньше первого сдвигает первый: диапазон не бывает пустым.
    await userEvent.click(screen.getByRole('combobox', { name: texts.from }));
    await userEvent.click(await screen.findByRole('option', { name: 'M03 · Огород' }));
    await userEvent.click(screen.getByRole('button', { name: texts.build }));
    await screen.findByText(texts.running);
    await expect(screen.getByRole('button', { name: texts.build })).toBeDisabled();
    await screen.findByText(texts.ready, undefined, JOB_TIMEOUT);
    const video = await screen.findByLabelText(texts.video);
    await expect(video).toHaveAttribute('src', expect.stringContaining('media/story-video.mp4?v=fragment-1'));
    await screen.findByRole('button', { name: texts.rebuild });
    const model = models.get(window.api)!;
    await expect(model.calls).toEqual([{ from: 'M03', to: 'M04' }]);
    await userEvent.click(screen.getByRole('button', { name: texts.close }));
    await waitFor(() => expect(args.onClose).toHaveBeenCalledTimes(1));
  }
};

export const Failed: Story = {
  name: 'Сборка не удалась · причина и журнал',
  tags: ['ci'],
  parameters: { songframe: options(true) },
  play: async () => {
    const screen = page();
    await userEvent.click(await screen.findByRole('button', { name: texts.build }));
    await screen.findByText(FRAGMENT_FAILURE, undefined, JOB_TIMEOUT);
    await expect(screen.queryByLabelText(texts.video)).toBeNull();
    // После сбоя сборку можно повторить.
    await expect(screen.getByRole('button', { name: texts.build })).toBeEnabled();
  }
};
