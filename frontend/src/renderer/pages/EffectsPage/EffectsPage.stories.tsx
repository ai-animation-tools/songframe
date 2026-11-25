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

/** Открыть выезжающую панель «Планы» и вернуть её. */
async function openShots(canvasElement: HTMLElement): Promise<ReturnType<typeof within>> {
  // Кнопка ждёт конца закрытия прежнего окна: до этого страница скрыта от доступности.
  await userEvent.click(await within(canvasElement).findByRole('button', { name: texts.shots }));
  return within(await body(canvasElement).findByRole('dialog', { name: texts.listLabel }));
}

export const Applied: Story = {
  name: 'Свежий эффект · подсказки, превью до и после, ролик',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(texts.status.fresh);
    // Планы — в выезжающей панели: карточки с первой опорой, эффектами плана и отметкой «В монтаже» или «Устарел».
    const drawer = await openShots(canvasElement);
    const list = drawer.getByRole('list', { name: texts.listLabel });
    await expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    const current = within(list).getByRole('button', { current: true });
    await expect(within(current).getByRole('img', { name: 'M01' })).toBeVisible();
    await expect(within(current).getByText('Дождь + Зерно')).toBeVisible();
    await expect(within(current).getByText(texts.fresh)).toBeVisible();
    await expect(within(list).getByText(texts.noEffect)).toBeVisible();
    await expect(within(list).getByText(texts.stale)).toBeVisible();
    await userEvent.click(drawer.getByRole('button', { name: texts.closeShots }));
    await waitFor(() => expect(body(canvasElement).queryByRole('dialog', { name: texts.listLabel })).toBeNull());
    // Дождь по ветру: наклон считает Go, поля наклона нет, компас показывает направление.
    await expect(canvas.getByRole('switch', { name: texts.wind.toggle })).toBeChecked();
    await expect(canvas.getByRole('slider', { name: texts.wind.compass({ direction: 20 }) })).toBeVisible();
    await expect(canvas.queryByText('Наклон, градусы от вертикали')).toBeNull();
    // У эффекта — описание «когда и зачем», у параметра — числовое поле с подсказкой, диапазоном и значением по умолчанию.
    await expect(canvas.getByText(/^Дождь поверх принятого плана/)).toBeVisible();
    const density = canvas.getByRole('spinbutton', { name: 'Плотность, капель на мегапиксель' });
    await expect(density).toHaveAccessibleDescription(/морось.*Допустимо от \d+ до \d+, по умолчанию \d+\./);
    // Панель эффекта сворачивается: параметры дождя скрыты, отметка изменений остаётся в заголовке.
    const rain = canvas.getByRole('button', { name: /^Дождь/ });
    await expect(rain).toHaveAttribute('aria-expanded', 'true');
    await expect(within(rain).getByText(texts.changed({ count: 3 }))).toBeVisible();
    await userEvent.click(rain);
    await expect(rain).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(canvas.queryByRole('spinbutton', { name: 'Плотность, капель на мегапиксель' })).toBeNull());
    await userEvent.click(rain);
    await canvas.findByRole('spinbutton', { name: 'Плотность, капель на мегапиксель' });
    await canvas.findByRole('img', { name: texts.previewAlt({ shot: 'M01', frame: 36 }) }, WAIT);
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.steps.length).toBe(2), WAIT);
    // «До» — кадр без эффектов.
    await userEvent.click(canvas.getByRole('button', { name: texts.previewBefore }));
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.steps).toEqual([]), WAIT);
    // Без правок применять нечего.
    await expect(canvas.getByRole('button', { name: texts.apply })).toBeDisabled();
    // Ролик — соседняя вкладка: с эффектом и принятое видео.
    await expect(canvasElement.querySelector('video')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: texts.video }));
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
    // У плана нет направления камеры: ветер недоступен, наклон — полем.
    await expect(canvas.getByRole('switch', { name: texts.wind.toggle })).toBeDisabled();
    await expect(canvas.getByText(texts.wind.noCamera)).toBeVisible();
    await expect(canvas.getByRole('spinbutton', { name: 'Наклон, градусы от вертикали' })).toBeVisible();
    await canvas.findByText(texts.status.dirty);
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.steps).toEqual([{ effect: 'rain', given: {} }]), WAIT);
    // Ролика с эффектом ещё нет: на вкладке — заглушка с пояснением, принятое видео — переключателем.
    await userEvent.click(canvas.getByRole('button', { name: texts.video }));
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

export const Reverse: Story = {
  name: 'Реверс · эффект без параметров первым в цепочке',
  tags: ['ci'],
  parameters: { songframe: effectsPageOptions({ shot: 'M02' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByText(texts.status.none);
    await userEvent.click(canvas.getByRole('button', { name: texts.add }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Зерно' }));
    await userEvent.click(canvas.getByRole('button', { name: texts.add }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Реверс' }));
    // Реверс встаёт первым: он разворачивает видео до остальных эффектов.
    const cards = canvas.getAllByRole('button', { name: /^(Реверс|Зерно)/ });
    await expect(cards.map((card) => card.textContent)).toEqual(['Реверс', 'Зерно']);
    // Параметров нет: только описание и удаление, без полей и сброса.
    await expect(canvas.getByText(/^Ролик плана идёт задом наперёд/)).toBeVisible();
    await expect(canvas.getAllByRole('button', { name: texts.resetStep })).toHaveLength(1);
    await expect(canvas.getByRole('button', { name: texts.removeStep({ title: 'Реверс' }) })).toBeEnabled();
    await waitFor(
      () =>
        expect(effectsPageInspection().previews.at(-1)?.steps).toEqual([
          { effect: 'reverse', given: {} },
          { effect: 'grain', given: {} }
        ]),
      WAIT
    );
    await userEvent.click(canvas.getByRole('button', { name: texts.apply }));
    await expect(effectsPageInspection().renders).toEqual([
      {
        shot: 'M02',
        steps: [
          { effect: 'reverse', given: {} },
          { effect: 'grain', given: {} }
        ]
      }
    ]);
    await canvas.findByText(texts.status.fresh, undefined, WAIT);
  }
};

export const CopyFromShot: Story = {
  name: 'Числовые поля · взять параметры с плана · сброс',
  tags: ['ci'],
  parameters: { songframe: effectsPageOptions({ shot: 'M02' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByText(texts.status.none);
    // Свой эффект черновика: значение вписывается точно, число вне диапазона поле не принимает.
    await userEvent.click(canvas.getByRole('button', { name: texts.add }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Свет' }));
    const intensity = canvas.getByRole('spinbutton', { name: 'Сила' });
    await userEvent.clear(intensity);
    await userEvent.type(intensity, '15');
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.steps).toEqual([{ effect: 'light', given: { intensity: 15 } }]), WAIT);
    await userEvent.clear(intensity);
    await userEvent.type(intensity, '25');
    await expect(intensity).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(intensity);
    await userEvent.type(intensity, '15.5');
    await expect(intensity).toHaveAttribute('aria-invalid', 'false');
    // Эффекты источника добавляются к черновику: несохранённый свет остаётся.
    await userEvent.click(canvas.getByRole('button', { name: texts.copyFrom }));
    const source = await screen.findByRole('menuitem', { name: /^M01/ });
    // Устаревший эффект M03 тоже годится как источник параметров.
    await expect(screen.getByRole('menuitem', { name: /^M03/ })).toBeVisible();
    await userEvent.click(source);
    await screen.findByText(texts.copied({ shot: 'M01' }));
    await canvas.findByText(texts.status.dirty);
    await expect(canvas.getByRole('button', { name: /^Свет/ })).toBeVisible();
    await expect(canvas.getByRole('button', { name: /^Дождь/ })).toBeVisible();
    await expect(await canvas.findByRole('button', { name: /^Зерно/ })).toBeVisible();
    await waitFor(
      () =>
        expect(
          effectsPageInspection()
            .previews.at(-1)
            ?.steps.map((step) => step.effect)
        ).toEqual(['light', 'rain', 'grain']),
      WAIT
    );
    await expect(effectsPageInspection().previews.at(-1)?.steps[0]).toEqual({ effect: 'light', given: { intensity: 15.5 } });
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
    await userEvent.click(canvas.getByRole('button', { name: texts.video }));
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
    const drawer = await openShots(canvasElement);
    await userEvent.click(drawer.getByRole('button', { name: /^M04/ }));
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

export const LightBeamAndTime: Story = {
  name: 'Свет · ручки на общем превью, время в секундах плана, шкала под превью',
  tags: ['ci'],
  parameters: { songframe: effectsPageOptions({ shot: 'M02' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByText(texts.status.none);
    await userEvent.click(canvas.getByRole('button', { name: texts.add }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Свет' }));
    // Отдельного превью у карточки нет: ручки включаются на общем превью панели.
    await expect(canvas.queryByRole('group', { name: texts.beam.label })).toBeNull();
    await userEvent.click(canvas.getByRole('switch', { name: texts.beam.toggle({ title: 'Свет' }) }));
    const panel = canvas.getByTestId('effect-preview-panel');
    const editor = within(panel).getByRole('group', { name: texts.beam.label });
    await expect(within(editor).getByRole('button', { name: texts.beam.source({ x: 0.1, y: 0.9 }) })).toBeVisible();
    // Щелчок по полю ставит источник в эту точку: правая верхняя четверть кадра.
    const box = editor.getBoundingClientRect();
    const toClient = (fx: number, fy: number) => ({
      clientX: box.left + ((fx + 0.4) / 1.8) * box.width,
      clientY: box.top + ((fy + 0.4) / 1.8) * box.height
    });
    await userEvent.pointer([{ keys: '[MouseLeft]', target: editor, coords: toClient(0.75, 0.25) }]);
    await waitFor(() => expect(canvas.getByRole('spinbutton', { name: 'Источник по горизонтали, доля кадра' })).toHaveValue(0.75));
    await expect(canvas.getByRole('spinbutton', { name: 'Источник по вертикали, доля кадра' })).toHaveValue(0.25);
    // Ручка направления поворачивается и клавиатурой.
    const direction = within(editor).getByRole('button', { name: texts.beam.direction({ value: 45 }) });
    direction.focus();
    await userEvent.keyboard('{ArrowLeft}');
    await expect(canvas.getByRole('spinbutton', { name: 'Направление луча, градусы: 0 — вправо, 90 — вверх' })).toHaveValue(46);
    await waitFor(
      () => expect(effectsPageInspection().previews.at(-1)?.steps).toEqual([{ effect: 'light', given: { source_x: 0.75, source_y: 0.25, direction: 46 } }]),
      WAIT
    );
    // Тот же переключатель есть и в панели превью: ручки убираются, остаётся кадр.
    await userEvent.click(within(panel).getByRole('button', { name: texts.beam.toggle({ title: 'Свет' }) }));
    await expect(within(panel).queryByRole('group', { name: texts.beam.label })).toBeNull();
    // Моменты — в секундах плана (72 кадра по 24 в секунду: последний кадр — 2,96 с), рецепт хранит долю.
    const scale = within(panel).getByRole('slider', { name: texts.time.scale });
    await expect(within(scale).getByRole('img', { name: texts.time.mark({ title: 'Начало нарастания', seconds: '1,33' }) })).toBeInTheDocument();
    const fade = canvas.getByRole('spinbutton', { name: texts.time.title({ title: 'Начало затухания' }) });
    await expect(fade).toHaveValue(2.96);
    await userEvent.clear(fade);
    await userEvent.type(fade, '2');
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.steps[0]?.given.fade_start).toBe(0.6761), WAIT);
    // Шкала ставит кадр под указателем в любом месте, по строке песни тоже.
    const at = (element: HTMLElement): number => {
      const rect = scale.getBoundingClientRect();
      const line = element.getBoundingClientRect();
      return Math.round(((line.left + line.width / 2 - rect.left) / rect.width) * 71);
    };
    const line = within(scale).getByTitle(texts.time.line({ text: 'Город ждёт рассвета', start: '1,50' }));
    const target = line.getBoundingClientRect();
    await userEvent.pointer([
      { keys: '[MouseLeft]', target: line, coords: { clientX: target.left + target.width / 2, clientY: target.top + target.height / 2 } }
    ]);
    const expected = at(line);
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.frame).toBe(expected), WAIT);
    await expect(scale).toHaveAttribute('aria-valuenow', String(expected));
    // С клавиатуры шкала — ползунок: Home — первый кадр.
    scale.focus();
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.frame).toBe(0), WAIT);
    await userEvent.click(canvas.getByRole('button', { name: texts.time.toFrame({ title: 'Полная сила' }) }));
    await expect(canvas.getByRole('spinbutton', { name: texts.time.title({ title: 'Полная сила' }) })).toHaveValue(0);
    await waitFor(() => expect(effectsPageInspection().previews.at(-1)?.steps[0]?.given.end).toBe(0), WAIT);
  }
};

export const UnappliedLeave: Story = {
  name: 'Смена плана · непримененный черновик спрашивает и сохраняется до ухода со страницы',
  tags: ['ci'],
  parameters: { songframe: effectsPageOptions({ shot: 'M02' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = body(canvasElement);
    await canvas.findByText(texts.status.none);
    await userEvent.click(canvas.getByRole('button', { name: texts.add }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Зерно' }));
    await canvas.findByText(texts.unapplied);
    // Стрелка к соседнему плану спрашивает; «Остаться» оставляет план и черновик.
    await userEvent.click(canvas.getByRole('button', { name: texts.nextShot }));
    const dialog = await screen.findByRole('dialog', { name: texts.leave.title({ shot: 'M02' }) });
    await userEvent.click(within(dialog).getByRole('button', { name: texts.leave.stay }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: texts.leave.title({ shot: 'M02' }) })).toBeNull());
    await expect(await canvas.findByRole('button', { name: /^Зерно/ })).toBeVisible();
    // Выбор в панели «Планы» тоже спрашивает; переход оставляет черновик с отметкой на карточке.
    let drawer = await openShots(canvasElement);
    await userEvent.click(drawer.getByRole('button', { name: /^M01/ }));
    const confirm = await screen.findByRole('dialog', { name: texts.leave.title({ shot: 'M02' }) });
    await userEvent.click(within(confirm).getByRole('button', { name: texts.leave.go({ shot: 'M01' }) }));
    await canvas.findByText(texts.status.fresh);
    await expect(canvas.queryByText(texts.unapplied)).toBeNull();
    drawer = await openShots(canvasElement);
    const card = drawer.getByRole('button', { name: /^M02/ });
    await expect(within(card).getByText(texts.unapplied)).toBeVisible();
    // M01 без правок: переход без вопроса, черновик M02 на месте.
    await userEvent.click(card);
    await canvas.findByText(texts.unapplied);
    await expect(screen.queryByRole('dialog', { name: texts.leave.title({ shot: 'M01' }) })).toBeNull();
    await expect(await canvas.findByRole('button', { name: /^Зерно/ })).toBeVisible();
  }
};

export const StickyPreview: Story = {
  name: 'Превью и шкала закреплены · карточки прокручиваются под панелью',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(texts.status.fresh);
    const panel = canvas.getByTestId('effect-preview-panel');
    const top = panel.getBoundingClientRect().top;
    // Прокрутка к последней карточке: панель с кадром и шкалой остаётся на месте.
    const last = canvas.getByRole('button', { name: texts.removeStep({ title: 'Зерно' }) });
    last.scrollIntoView({ block: 'end' });
    await waitFor(() => expect(panel.getBoundingClientRect().top).toBeLessThanOrEqual(top));
    const rect = panel.getBoundingClientRect();
    await expect(rect.top).toBeGreaterThanOrEqual(0);
    await expect(within(panel).getByRole('slider', { name: texts.time.scale })).toBeVisible();
    await expect(last.getBoundingClientRect().top).toBeGreaterThanOrEqual(rect.bottom);
  }
};
