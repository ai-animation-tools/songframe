/** Страница «Схемы»: локации кастинга, вкладки видов, холст редактора и запись черновика. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { schemesTexts } from '@shared/texts/schemes';
import { schemesPageOptions, schemesStorySnapshot } from '../../testing/schemesPageStories';
import { SchemesPage } from './SchemesPage';

const meta = { title: 'Страницы/Схемы', component: SchemesPage, tags: ['!autodocs'], parameters: { songframe: schemesPageOptions() } } satisfies Meta<
  typeof SchemesPage
>;
export default meta;
type Story = StoryObj<typeof meta>;

type Canvas = ReturnType<typeof within>;
const canvasOf = async (canvas: Canvas, title: string): Promise<SVGSVGElement> =>
  (await canvas.findByRole('application', { name: schemesTexts.canvasLabel({ title }) })) as unknown as SVGSVGElement;
const saveButton = (canvas: Canvas): HTMLElement => canvas.getByRole('button', { name: commonTexts.save });

export const Overview: Story = {
  name: 'Вид сверху · все фигуры, локация без вида сверху отмечена',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const svg = await canvasOf(canvas, 'Перекрёсток сверху');
    for (const id of ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7']) await expect(svg.querySelector(`[data-object-id="${id}"]`)).not.toBeNull();
    await expect(within(svg as unknown as HTMLElement).getByText('Длинный дом')).toBeInTheDocument();
    const street = canvasElement.querySelector<HTMLElement>('[data-location-id="street"]')!;
    await expect(within(street).getByText(schemesTexts.withoutTop)).toBeVisible();
    await expect(saveButton(canvas)).toBeDisabled();
    await expect(canvas.getByText(schemesTexts.noSelection)).toBeVisible();
  }
};

export const CreateSideView: Story = {
  name: 'Новая схема вида с запада · черновик и запись',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvasOf(canvas, 'Перекрёсток сверху');
    await userEvent.click(canvas.getByRole('tab', { name: new RegExp(schemesTexts.views.west) }));
    await expect(await canvas.findByText(schemesTexts.createTitle({ view: schemesTexts.views.west }))).toBeVisible();
    await userEvent.type(canvas.getByRole('textbox', { name: schemesTexts.createName }), 'Сквер с запада');
    await userEvent.click(canvas.getByRole('button', { name: schemesTexts.create }));
    await canvasOf(canvas, 'Сквер с запада');
    await expect(canvas.getByText(schemesTexts.viewHints.west)).toBeVisible();
    await expect(canvas.getByText(commonTexts.unsavedChanges)).toBeVisible();
    await userEvent.click(saveButton(canvas));
    await waitFor(() => expect(schemesStorySnapshot().saves).toBe(1));
    await expect(schemesStorySnapshot().document.schemes.map((scheme) => scheme.view)).toEqual(['top', 'west']);
  }
};

export const DrawAndEdit: Story = {
  name: 'Рисование прямоугольников подряд · ручки размера и запись',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const svg = await canvasOf(canvas, 'Перекрёсток сверху');
    await userEvent.click(canvas.getByRole('button', { name: schemesTexts.tools.rect }));
    await expect(canvas.getByText(schemesTexts.toolHints.rect)).toBeVisible();
    // Ввод в поле свойств прокручивает страницу: положение холста берётся заново перед каждым жестом.
    const frame = async (fromX: number, fromY: number, toX: number, toY: number): Promise<void> => {
      svg.scrollIntoView({ block: 'center' });
      const box = svg.getBoundingClientRect();
      await userEvent.pointer([
        { keys: '[MouseLeft>]', target: svg, coords: { clientX: box.left + fromX, clientY: box.top + fromY } },
        { target: svg, coords: { clientX: box.left + toX, clientY: box.top + toY } },
        { keys: '[/MouseLeft]', target: svg, coords: { clientX: box.left + toX, clientY: box.top + toY } }
      ]);
    };
    await frame(60, 60, 160, 120);
    // Новая фигура выбрана, а инструмент остался прямоугольником: следующую можно рисовать сразу.
    const name = await canvas.findByRole('textbox', { name: schemesTexts.objectName });
    await expect((name as HTMLInputElement).value).toBe(schemesTexts.newObject({ number: 8 }));
    await expect(canvas.getByText(schemesTexts.toolHints.rect)).toBeVisible();
    await userEvent.clear(name);
    await userEvent.type(name, 'Киоск');
    await userEvent.type(canvas.getByRole('spinbutton', { name: schemesTexts.height }), '3');
    await frame(60, 160, 120, 220);
    await waitFor(() =>
      expect((canvas.getByRole('textbox', { name: schemesTexts.objectName }) as HTMLInputElement).value).toBe(schemesTexts.newObject({ number: 9 }))
    );
    // Esc возвращает выбор, у выбранного прямоугольника появляются ручки рамки: правый нижний угол тянется вправо.
    svg.scrollIntoView({ block: 'center' });
    svg.focus({ preventScroll: true });
    await userEvent.keyboard('{Escape}');
    await expect(canvas.getByText(schemesTexts.toolHints.select)).toBeVisible();
    await expect(svg.querySelectorAll('[data-handle]')).toHaveLength(8);
    const corner = svg.querySelector<SVGGElement>('[data-handle="1"]')!.getBoundingClientRect();
    const [cx, cy] = [corner.left + corner.width / 2, corner.top + corner.height / 2];
    await userEvent.pointer([
      { keys: '[MouseLeft>]', target: svg.querySelector('[data-handle="1"] rect')!, coords: { clientX: cx, clientY: cy } },
      { target: svg, coords: { clientX: cx + 60, clientY: cy } }
    ]);
    await expect(svg.querySelector('[data-size-label]')).not.toBeNull();
    await userEvent.pointer({ keys: '[/MouseLeft]', target: svg, coords: { clientX: cx + 60, clientY: cy } });
    await userEvent.click(saveButton(canvas));
    await waitFor(() => expect(schemesStorySnapshot().saves).toBe(1));
    const [kiosk, second] = schemesStorySnapshot().document.schemes[0].objects.slice(-2);
    await expect(kiosk).toMatchObject({ name: 'Киоск', height: 3, shape: { type: 'rect' } });
    // Квадрат из второй рамки стал шире, высота не изменилась.
    await expect(second.shape.type === 'rect' && second.shape.size[0] > second.shape.size[1]).toBe(true);
  }
};

export const LineHitArea: Story = {
  name: 'Тонкая линия выбирается щелчком рядом · подпись клетки',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const svg = await canvasOf(canvas, 'Перекрёсток сверху');
    await expect(svg.querySelector('[data-scale-label]')?.textContent).toMatch(/^Клетка \d+(,\d+)? м/);
    const line = svg.querySelector<SVGPathElement>('[data-object-id="o3"] path[stroke-width]')!.getBoundingClientRect();
    // Щелчок в 6 пикселях от линии ограждения.
    await userEvent.pointer({
      keys: '[MouseLeft]',
      target: svg.querySelector('[data-object-id="o3"] [data-hit-area]')!,
      coords: { clientX: line.left + line.width / 2 + 6, clientY: line.top + line.height / 2 }
    });
    const name = await canvas.findByRole('textbox', { name: schemesTexts.objectName });
    await expect((name as HTMLInputElement).value).toBe('Ограждение');
  }
};

export const ObjectColor: Story = {
  name: 'Цвет объекта · любой цвет и сброс к цвету по умолчанию',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const svg = await canvasOf(canvas, 'Перекрёсток сверху');
    const pick = async (id: string): Promise<HTMLInputElement> => {
      fireEvent.pointerDown(svg.querySelector(`[data-object-id="${id}"] path`)!, { pointerId: 1 });
      fireEvent.pointerUp(svg, { pointerId: 1 });
      return (await canvas.findByLabelText(schemesTexts.color)) as HTMLInputElement;
    };
    // У сквера свой цвет: его можно сбросить. Дому задаётся произвольный цвет из системной палитры.
    let color = await pick('o5');
    await expect(color.value).toBe('#4caf50');
    await userEvent.click(canvas.getByRole('button', { name: schemesTexts.colorReset }));
    await expect(canvas.queryByRole('button', { name: schemesTexts.colorReset })).toBeNull();
    color = await pick('o2');
    fireEvent.input(color, { target: { value: '#123abc' } });
    await userEvent.click(saveButton(canvas));
    await waitFor(() => expect(schemesStorySnapshot().saves).toBe(1));
    const objects = schemesStorySnapshot().document.schemes[0].objects;
    await expect(objects.find((object) => object.id === 'o5')?.color).toBeUndefined();
    await expect(objects.find((object) => object.id === 'o2')?.color).toBe('#123abc');
  }
};

export const EmptyProject: Story = {
  name: 'Схем ещё нет · создание вида сверху',
  tags: ['ci'],
  parameters: { songframe: schemesPageOptions({ empty: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(schemesTexts.createTitle({ view: schemesTexts.views.top }))).toBeVisible();
    await expect(canvas.getAllByText(schemesTexts.withoutTop)).toHaveLength(2);
  }
};

export const Damaged: Story = {
  name: 'Повреждённый файл · запись недоступна',
  tags: ['ci'],
  parameters: { songframe: schemesPageOptions({ damaged: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(schemesTexts.damaged)).toBeVisible();
    await expect(saveButton(canvas)).toBeDisabled();
  }
};

export const NoLocations: Story = {
  name: 'В кастинге нет локаций · подсказка',
  parameters: { songframe: schemesPageOptions({ noLocations: true }) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(/В кастинге нет локаций/)).toBeVisible();
  }
};
