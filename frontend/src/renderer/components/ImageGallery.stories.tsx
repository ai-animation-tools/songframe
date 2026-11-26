/** Общий просмотр изображений: увеличение ползунком, перетаскивание и сравнение опор наложением на синтетических кадрах. */
import { useState, type ReactElement } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@mui/material';
import { commonTexts } from '@shared/texts/common';
import { componentsTexts } from '@shared/texts/components';
import { ImageGallery, type GalleryImage } from './ImageGallery';

const texts = componentsTexts.gallery;

/** Две опоры одного кадра: на второй предметы сдвинуты, неподвижный столб — на месте. */
const FRAMES: GalleryImage[] = [
  { imagePath: '/mock/frames/story-frame-a.png', label: 'K01 · Первый кадр' },
  { imagePath: '/mock/frames/story-frame-b.png', label: 'K02 · Последний кадр' }
];
/** Снимок другой пропорции: сравнение с ним предупреждает, а не растягивает слой. */
const SQUARE: GalleryImage = { imagePath: '/mock/frames/story-frame-square.png', label: 'Схема композиции: квадратный снимок' };

function GalleryStory({ compare }: { compare?: boolean | GalleryImage[] }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outlined" onClick={() => setOpen(true)}>
        {texts.openLarge({ label: FRAMES[0].label })}
      </Button>
      {open ? <ImageGallery kind="Опора" images={FRAMES} initialIndex={0} compare={compare} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const meta = {
  title: 'Общие/Просмотр изображений',
  component: GalleryStory,
  // Диалог управляет фокусом, поэтому play выполняется только в отдельном Canvas.
  tags: ['!autodocs'],
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof GalleryStory>;
export default meta;
type Story = StoryObj<typeof meta>;

async function openGallery(canvasElement: HTMLElement): Promise<HTMLElement> {
  await userEvent.click(within(canvasElement).getByRole('button', { name: texts.openLarge({ label: FRAMES[0].label }) }));
  const dialog = await within(canvasElement.ownerDocument.body).findByRole('dialog');
  await waitFor(() => expect(within(dialog).getByRole('slider', { name: componentsTexts.imageZoom.label })).toBeEnabled());
  return dialog;
}

const zoomValue = (dialog: HTMLElement): string | null => dialog.querySelector('[data-zoom-value]')?.getAttribute('data-zoom-value') ?? null;
const viewport = (dialog: HTMLElement): HTMLElement => dialog.querySelector<HTMLElement>('[data-zoom-viewport]')!;
const overlay = (dialog: HTMLElement): HTMLImageElement | null => dialog.querySelector<HTMLImageElement>('[data-zoom-overlay]');

export const Zoom: Story = {
  name: 'Увеличение · вписать → до 300%, двойной щелчок 1:1, перетаскивание, масштаб при листании, сброс при закрытии',
  tags: ['!autodocs', 'ci'],
  play: async ({ canvasElement }) => {
    const dialog = await openGallery(canvasElement);
    const fit = Number(zoomValue(dialog));
    await expect(fit).toBeLessThan(100);
    await expect(viewport(dialog)).toHaveAttribute('data-zoom-viewport', 'fit');
    await expect(within(dialog).queryByRole('combobox', { name: texts.compareWith })).not.toBeInTheDocument();

    const slider = within(dialog).getByRole('slider', { name: componentsTexts.imageZoom.label });
    slider.focus();
    await userEvent.keyboard('{End}');
    await expect(zoomValue(dialog)).toBe('300');
    // Стрелки ползунка меняют масштаб, а не листают изображения.
    await userEvent.keyboard('{ArrowLeft}');
    const zoomed = zoomValue(dialog);
    await expect(Number(zoomed)).toBeLessThan(300);
    await expect(Number(zoomed)).toBeGreaterThan(280);
    await expect(within(dialog).getByText(FRAMES[0].label)).toBeVisible();
    await expect(viewport(dialog)).toHaveAttribute('data-zoom-viewport', 'pannable');

    const area = viewport(dialog);
    const before = area.scrollLeft;
    const rect = area.getBoundingClientRect();
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: area, coords: { clientX: rect.left + 200, clientY: rect.top + 200 } },
      { target: area, coords: { clientX: rect.left + 100, clientY: rect.top + 150 } },
      { keys: '[/MouseLeft]', target: area }
    ]);
    await expect(area.scrollLeft).toBeGreaterThan(before);

    await userEvent.click(within(dialog).getByRole('button', { name: texts.nextImage }));
    await expect(within(dialog).getByText(FRAMES[1].label)).toBeVisible();
    await expect(zoomValue(dialog)).toBe(zoomed);

    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.close }));
    await waitFor(() => expect(within(canvasElement.ownerDocument.body).queryByRole('dialog')).not.toBeInTheDocument());
    const reopened = await openGallery(canvasElement);
    await expect(Number(zoomValue(reopened))).toBe(fit);
    // Двойной щелчок по картинке — ровно 1:1, второй — снова вписать.
    await userEvent.dblClick(viewport(reopened));
    await expect(zoomValue(reopened)).toBe('100');
    await userEvent.dblClick(viewport(reopened));
    await expect(Number(zoomValue(reopened))).toBe(fit);
  }
};

export const Compare: Story = {
  name: 'Сравнение опор · слой поверх, прозрачность, мигание клавишей С, «Разница»',
  tags: ['!autodocs', 'ci'],
  args: { compare: true },
  play: async ({ canvasElement }) => {
    const dialog = await openGallery(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(dialog).getByRole('combobox', { name: texts.compareWith }));
    const listbox = await screen.findByRole('listbox');
    // Текущая опора не предлагается как слой для сравнения с самой собой.
    await expect(within(listbox).queryByRole('option', { name: FRAMES[0].label })).not.toBeInTheDocument();
    await userEvent.click(within(listbox).getByRole('option', { name: FRAMES[1].label }));
    await waitFor(() => expect(overlay(dialog)).not.toBeNull());
    await expect(overlay(dialog)).toHaveAttribute('alt', texts.compareLayer({ label: FRAMES[1].label }));
    await expect(getComputedStyle(overlay(dialog)!).opacity).toBe('0.5');
    await expect(within(dialog).getByText(texts.compareOpacity({ percent: 50 }))).toBeVisible();

    await userEvent.keyboard('c');
    await expect(getComputedStyle(overlay(dialog)!).opacity).toBe('1');
    await userEvent.keyboard('c');
    await expect(getComputedStyle(overlay(dialog)!).opacity).toBe('0');
    // Зажатая клавиша переключает один раз: автоповтор не мигает слоем.
    // user-event не ставит repeat у повторных keydown: зажатие собирается как у браузера — первое нажатие и автоповтор.
    const focused = canvasElement.ownerDocument.activeElement ?? dialog;
    for (let press = 0; press < 6; press += 1) {
      focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', repeat: press > 0, bubbles: true, cancelable: true }));
    }
    focused.dispatchEvent(new KeyboardEvent('keyup', { key: 'c', code: 'KeyC', bubbles: true }));
    // React применяет обновление дискретного события в микрозадаче: ждём её, а не проверяем синхронно.
    await waitFor(() => expect(getComputedStyle(overlay(dialog)!).opacity).toBe('1'));
    await userEvent.keyboard('c');
    await expect(getComputedStyle(overlay(dialog)!).opacity).toBe('0');

    await userEvent.click(within(dialog).getByRole('switch', { name: texts.compareDifference }));
    await expect(overlay(dialog)).toHaveAttribute('data-zoom-overlay', 'difference');
    await expect(getComputedStyle(overlay(dialog)!).mixBlendMode).toBe('difference');
    await expect(getComputedStyle(overlay(dialog)!).opacity).toBe('1');
    await expect(dialog.querySelector('[data-zoom-aspect]')).toBeNull();

    // Переход на опору, выбранную слоем, снимает сравнение: с собой не сравнивают.
    await userEvent.click(within(dialog).getByRole('button', { name: texts.nextImage }));
    await waitFor(() => expect(overlay(dialog)).toBeNull());
  }
};

export const CompareAspect: Story = {
  name: 'Сравнение со снимком другой пропорции · предупреждение без растягивания',
  tags: ['!autodocs', 'ci'],
  args: { compare: [SQUARE] },
  play: async ({ canvasElement }) => {
    const dialog = await openGallery(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(dialog).getByRole('combobox', { name: texts.compareWith }));
    await userEvent.click(await screen.findByRole('option', { name: SQUARE.label }));
    await waitFor(() => expect(dialog.querySelector('[data-zoom-aspect]')).not.toBeNull());
    await expect(within(dialog).getByText(componentsTexts.imageZoom.aspect)).toBeVisible();
    await expect(getComputedStyle(overlay(dialog)!).objectFit).toBe('contain');
  }
};

/** Открыт сразу: снимок обеих тем со слоем сравнения для ручного осмотра. */
export const CompareOpen: Story = {
  name: 'Сравнение открыто · вид диалога',
  render: () => <ImageGallery kind="Опора" images={FRAMES} initialIndex={0} compare={[SQUARE]} onClose={() => undefined} />
};
