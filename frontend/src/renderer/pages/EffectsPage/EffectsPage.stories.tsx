/** Настоящая страница «Эффекты» на локальной модели Go-сервиса: превью, применение, копирование и снятие эффекта. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { effectsTexts as texts } from '@shared/texts/effects';
import { EFFECTS_KIT_PROBLEM, EFFECTS_STALE_REASON, effectsPageInspection, effectsPageOptions } from '../../testing/effectsPageStories';
import { EffectsPage } from './EffectsPage';
import { MEDIA_MAX_WIDTH } from './components/EffectShotPanel';
import { FULL_WIDTH, PREVIEW_WIDTH } from './useEffectsPage';

const meta = {
  title: 'Страницы/Эффекты',
  component: EffectsPage,
  tags: ['!autodocs'],
  parameters: { songframe: effectsPageOptions(), controls: { disable: true } }
} satisfies Meta<typeof EffectsPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Превью ждёт паузу после правки, задание — два опроса раз в секунду. */
const WAIT = { timeout: 6000 };

function body(canvasElement: HTMLElement): ReturnType<typeof within> {
  return within(canvasElement.ownerDocument.body);
}

export const Applied: Story = {
  name: 'Свежий эффект · подсказки, превью до и после, ролик',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByText(texts.status.fresh);
    // Дождь по ветру: наклон считает Go, ползунка наклона нет, компас показывает направление.
    await expect(canvas.getByRole('switch', { name: texts.wind.toggle })).toBeChecked();
    await expect(canvas.getByRole('slider', { name: texts.wind.compass({ direction: 20 }) })).toBeVisible();
    await expect(canvas.queryByText('Наклон, градусы от вертикали')).toBeNull();
    // У эффекта — описание «когда и зачем», у параметра — подсказка по фокусу на названии.
    await expect(canvas.getByText(/^Дождь поверх принятого плана/)).toBeVisible();
    canvas.getByText('Плотность, капель на мегапиксель').parentElement?.focus();
    await screen.findByRole('tooltip', { name: /морось/ });
    await expect(canvas.getByRole('slider', { name: 'Плотность, капель на мегапиксель' })).toHaveAccessibleDescription(/морось/);
    await canvas.findByRole('img', { name: texts.previewAlt({ shot: 'M01', frame: 36 }) }, WAIT);
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.steps.length).toBe(2), WAIT);
    // «До» — кадр без эффектов.
    await userEvent.click(canvas.getByRole('button', { name: texts.previewBefore }));
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.steps).toEqual([]), WAIT);
    // Без правок применять нечего.
    await expect(canvas.getByRole('button', { name: texts.apply })).toBeDisabled();
    // Ролик — соседняя вкладка: с эффектом и принятое видео.
    await expect(canvasElement.querySelector('video')).toBeNull();
    await userEvent.click(canvas.getByRole('tab', { name: texts.video }));
    await expect(canvas.getByLabelText(texts.videoAfter)).toBeInTheDocument();
    // Плеер не шире кадра: крупно смотрят на весь экран.
    await expect(canvas.getByLabelText(texts.videoAfter).getBoundingClientRect().width).toBeLessThanOrEqual(MEDIA_MAX_WIDTH);
    await userEvent.click(canvas.getByRole('button', { name: texts.videoBefore }));
    await expect(canvas.getByLabelText(texts.videoBefore)).toBeInTheDocument();
  }
};

export const FrameFullscreen: Story = {
  name: 'Кадр на весь экран · полный размер, до и после',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByRole('img', { name: texts.previewAlt({ shot: 'M01', frame: 36 }) }, WAIT);
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.width).toBe(PREVIEW_WIDTH), WAIT);
    await userEvent.click(canvas.getByRole('button', { name: 'На весь экран' }));
    const dialog = await screen.findByRole('dialog', { name: texts.frameFullscreen });
    // На весь экран кадр запрашивается в полном размере ролика: зерно не усредняется.
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)).toMatchObject({ width: FULL_WIDTH, frame: 36 }), WAIT);
    await expect(within(dialog).getByRole('img', { name: texts.previewAlt({ shot: 'M01', frame: 36 }) })).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: texts.previewBefore }));
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)).toMatchObject({ width: FULL_WIDTH, steps: [] }), WAIT);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Выйти из полноэкранного режима' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.width).toBe(PREVIEW_WIDTH), WAIT);
  }
};

export const AddAndApply: Story = {
  name: 'План без эффекта · дождь без камеры и применение',
  tags: ['ci'],
  parameters: { songframe: effectsPageOptions({ shot: 'M02' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByText(texts.status.none);
    await expect(canvas.getByText(texts.chainEmpty)).toBeVisible();
    await expect(canvas.getByRole('button', { name: texts.apply })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: texts.add }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Дождь' }));
    // У плана нет направления камеры: ветер недоступен, наклон — ползунком.
    await expect(canvas.getByRole('switch', { name: texts.wind.toggle })).toBeDisabled();
    await expect(canvas.getByText(texts.wind.noCamera)).toBeVisible();
    await expect(canvas.getByText('Наклон, градусы от вертикали')).toBeVisible();
    await canvas.findByText(texts.status.dirty);
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.steps).toEqual([{ effect: 'rain', given: {} }]), WAIT);
    // Ролика с эффектом ещё нет: на вкладке — заглушка с пояснением, принятое видео — переключателем.
    await userEvent.click(canvas.getByRole('tab', { name: texts.video }));
    await expect(canvas.getByText(texts.videoNone)).toBeVisible();
    await expect(canvasElement.querySelector('video')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: texts.apply }));
    await expect(effectsPageInspection().renders).toEqual([{ shot: 'M02', steps: [{ effect: 'rain', given: {} }] }]);
    await screen.findByText(texts.applied, undefined, WAIT);
    await canvas.findByText(texts.status.fresh, undefined, WAIT);
    await expect(canvas.queryByText(texts.status.dirty)).toBeNull();
    // Готовый ролик заменяет заглушку.
    await waitFor(() => expect(canvas.getByLabelText(texts.videoAfter)).toBeInTheDocument(), WAIT);
    await expect(canvas.queryByText(texts.videoNone)).toBeNull();
  }
};

export const CopyFromShot: Story = {
  name: 'Взять параметры с плана · сброс',
  tags: ['ci'],
  parameters: { songframe: effectsPageOptions({ shot: 'M02' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByText(texts.status.none);
    await userEvent.click(canvas.getByRole('button', { name: texts.copyFrom }));
    const source = await screen.findByRole('menuitem', { name: /^M01/ });
    // Устаревший эффект M03 тоже годится как источник параметров.
    await expect(screen.getByRole('menuitem', { name: /^M03/ })).toBeVisible();
    await userEvent.click(source);
    await screen.findByText(texts.copied({ shot: 'M01' }));
    await canvas.findByText(texts.status.dirty);
    await expect(canvas.getByText('Дождь')).toBeVisible();
    await expect(canvas.getByText('Зерно')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: texts.reset }));
    await canvas.findByText(texts.chainEmpty);
  }
};

export const Remove: Story = {
  name: 'Убрать эффект',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByText(texts.status.fresh);
    await userEvent.click(canvas.getByRole('button', { name: texts.removeEffect }));
    const dialog = await screen.findByRole('dialog', { name: `${texts.removeTitle({ shot: 'M01' })}?` });
    await userEvent.click(within(dialog).getByRole('button', { name: texts.removeEffect }));
    await screen.findByText(texts.removed);
    await canvas.findByText(texts.status.none);
    await expect(effectsPageInspection().removed).toEqual(['M01']);
    await userEvent.click(canvas.getByRole('tab', { name: texts.video }));
    await expect(canvas.getByText(texts.videoNone)).toBeVisible();
    await expect(canvasElement.querySelector('video')).toBeNull();
  }
};

export const StaleAndBroken: Story = {
  name: 'Устаревший эффект и повреждённый комплект',
  parameters: { songframe: effectsPageOptions({ shot: 'M03' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(texts.status.stale({ reason: EFFECTS_STALE_REASON }));
    // Устаревший эффект можно применить заново без правок.
    await expect(canvas.getByRole('button', { name: texts.apply })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: /^M04/ }));
    await canvas.findByText(EFFECTS_KIT_PROBLEM);
  }
};

export const Empty: Story = {
  name: 'Принятых планов нет',
  parameters: { songframe: effectsPageOptions({ state: 'empty' }) },
  play: async ({ canvasElement }) => {
    // «Производство» в тексте — ссылка на страницу, поэтому сверяется начало фразы.
    await within(canvasElement).findByText(/^Принятых планов пока нет/);
  }
};
