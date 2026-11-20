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
  name: 'Схема · все фигуры, локация без схемы отмечена',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const svg = await canvasOf(canvas, 'Перекрёсток');
    for (const id of ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7']) await expect(svg.querySelector(`[data-object-id="${id}"]`)).not.toBeNull();
    await expect(within(svg as unknown as HTMLElement).getByText('Длинный дом')).toBeInTheDocument();
    const street = canvasElement.querySelector<HTMLElement>('[data-location-id="street"]')!;
    await expect(within(street).getByText(schemesTexts.withoutScheme)).toBeVisible();
    await expect(saveButton(canvas)).toBeDisabled();
    await expect(canvas.getByText(schemesTexts.noSelection)).toBeVisible();
  }
};

export const CreateScheme: Story = {
  name: 'Новая схема второй локации · черновик и запись',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvasOf(canvas, 'Перекрёсток');
    await expect(canvas.getByText(schemesTexts.objectsCount({ count: 7 }))).toBeVisible();
    await userEvent.click(canvasElement.querySelector<HTMLElement>('[data-location-id="street"]')!);
    await expect(await canvas.findByText(schemesTexts.createTitle)).toBeVisible();
    // Вкладок сторон нет: у локации одна схема.
    await expect(canvas.queryByRole('tab')).toBeNull();
    await userEvent.type(canvas.getByRole('textbox', { name: schemesTexts.createName }), 'Улица');
    await userEvent.click(canvas.getByRole('button', { name: schemesTexts.create }));
    await canvasOf(canvas, 'Улица');
    await expect(canvas.getByText(commonTexts.unsavedChanges)).toBeVisible();
    await expect(canvas.getByText(schemesTexts.objectsCount({ count: 0 }))).toBeVisible();
    await userEvent.click(saveButton(canvas));
    await waitFor(() => expect(schemesStorySnapshot().saves).toBe(1));
    await expect(schemesStorySnapshot().document.schemes.map((scheme) => scheme.location)).toEqual(['crossing', 'street']);
    await expect(canvas.queryByText(schemesTexts.withoutScheme)).toBeNull();
  }
};

export const DrawAndEdit: Story = {
  name: 'Рисование прямоугольников подряд · ручки размера и запись',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const svg = await canvasOf(canvas, 'Перекрёсток');
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
    const svg = await canvasOf(canvas, 'Перекрёсток');
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
    const svg = await canvasOf(canvas, 'Перекрёсток');
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
  name: 'Схем ещё нет · создание схемы',
  tags: ['ci'],
  parameters: { songframe: schemesPageOptions({ empty: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(schemesTexts.createTitle)).toBeVisible();
    await expect(canvas.getAllByText(schemesTexts.withoutScheme)).toHaveLength(2);
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

export const Fullscreen: Story = {
  name: 'Во весь экран · правки в окне, «Сохранить» в шапке, закрытие без вопросов',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await canvasOf(canvas, 'Перекрёсток');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.fullscreen.open }));
    const dialog = within(await page.findByRole('dialog', { name: schemesTexts.fullscreenTitle({ location: 'Перекрёсток' }) }));
    await canvasOf(dialog, 'Перекрёсток');
    // В окне нет кнопки «Во весь экран», а холст выше, чем на странице.
    await expect(dialog.queryByRole('button', { name: commonTexts.fullscreen.open })).toBeNull();
    const title = dialog.getByRole('textbox', { name: schemesTexts.schemeTitle });
    await userEvent.type(title, ' вечером');
    // Правка в окне сразу уходит во временный файл.
    await waitFor(() => expect(schemesStorySnapshot().draft).toContain('Перекрёсток вечером'));
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(schemesStorySnapshot().saves).toBe(1));
    // Закрытие ничего не теряет и не спрашивает.
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.close }));
    await waitFor(() => expect(page.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(schemesStorySnapshot().document.schemes[0].title).toBe('Перекрёсток вечером');
    // Сохранение удаляет временный файл.
    await waitFor(() => expect(schemesStorySnapshot().draft).toBeNull());
    await canvasOf(canvas, 'Перекрёсток вечером');
  }
};

export const DraftRestore: Story = {
  name: 'Черновик прошлого запуска · продолжить, правки вернулись',
  tags: ['ci'],
  parameters: { songframe: schemesPageOptions({ leftDraft: 'same' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(commonTexts.draft.title)).toBeVisible();
    await expect(canvas.queryByText(commonTexts.draft.baseChanged)).toBeNull();
    // Пока решение не принято, черновик не перезаписывается сохранённой схемой.
    await expect(schemesStorySnapshot().draft).toContain('Перекрёсток из черновика');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.draft.restore }));
    await canvasOf(canvas, 'Перекрёсток из черновика');
    await expect(canvas.queryByText(commonTexts.draft.title)).toBeNull();
    await expect(canvas.getByText(commonTexts.unsavedChanges)).toBeVisible();
    await expect(saveButton(canvas)).toBeEnabled();
  }
};

export const DraftDiscard: Story = {
  name: 'Черновик при изменившемся файле · предупреждение, отказ подтверждается',
  tags: ['ci'],
  parameters: { songframe: schemesPageOptions({ leftDraft: 'changed' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByText(commonTexts.draft.baseChanged)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.draft.discard }));
    const confirm = within(await page.findByRole('dialog', { name: commonTexts.draft.discardTitle }));
    await userEvent.click(confirm.getByRole('button', { name: commonTexts.draft.discard }));
    await waitFor(() => expect(schemesStorySnapshot().draft).toBeNull());
    await expect(canvas.queryByText(commonTexts.draft.title)).toBeNull();
    await canvasOf(canvas, 'Перекрёсток');
    await expect(saveButton(canvas)).toBeDisabled();
  }
};

export const RememberView: Story = {
  name: 'Масштаб схемы запоминается · другая локация и окно во весь экран его не сбрасывают',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const scaleOf = (root: ParentNode): string => root.querySelector('[data-scale-label]')!.textContent ?? '';
    const svg = await canvasOf(canvas, 'Перекрёсток');
    const fitted = scaleOf(svg);
    const box = svg.getBoundingClientRect();
    for (let index = 0; index < 8; index++) fireEvent.wheel(svg, { deltaY: -100, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 });
    await waitFor(() => expect(scaleOf(svg)).not.toBe(fitted));
    const zoomed = scaleOf(svg);
    // Другая локация и обратно: редактор создаётся заново, вид берётся из запомненного.
    await userEvent.click(canvasElement.querySelector<HTMLElement>('[data-location-id="street"]')!);
    await userEvent.click(canvasElement.querySelector<HTMLElement>('[data-location-id="crossing"]')!);
    await waitFor(async () => expect(scaleOf(await canvasOf(canvas, 'Перекрёсток'))).toBe(zoomed));
    // Во весь экран холст больше, но масштаб тот же.
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.fullscreen.open }));
    const dialog = within(await page.findByRole('dialog', { name: schemesTexts.fullscreenTitle({ location: 'Перекрёсток' }) }));
    await expect(scaleOf(await canvasOf(dialog, 'Перекрёсток'))).toBe(zoomed);
    // «Показать всё» возвращает вписанный вид.
    await userEvent.click(dialog.getByRole('button', { name: schemesTexts.fit }));
    await waitFor(async () => expect(scaleOf(await canvasOf(dialog, 'Перекрёсток'))).not.toBe(zoomed));
  }
};

export const Volume: Story = {
  name: 'Объём · гребень у дома в свойствах, вид объёма в 3D и запись',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const svg = await canvasOf(canvas, 'Перекрёсток');
    const volume = schemesTexts.volume;
    fireEvent.pointerDown(svg.querySelector('[data-object-id="o2"] path')!, { pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    // Объём: поля только допустимых форм; у дома (прямоугольник) — гребень, скат и шатёр.
    await userEvent.click(await canvas.findByRole('combobox', { name: volume.top }));
    const options = within(await page.findByRole('listbox'));
    await expect(options.getAllByRole('option').map((option) => option.textContent)).toEqual([
      volume.topForms.none,
      volume.topForms.ridge,
      volume.topForms.slope,
      volume.topForms.tent
    ]);
    await userEvent.click(options.getByRole('option', { name: volume.topForms.ridge }));
    const rise = canvas.getByRole('spinbutton', { name: volume.rise }) as HTMLInputElement;
    await userEvent.clear(rise);
    await userEvent.type(rise, '4');
    await userEvent.click(canvas.getByRole('combobox', { name: volume.axis }));
    await userEvent.click(await page.findByRole('option', { name: volume.axes.y }));
    // Вид объёма: сцена построена, подпись дома над его верхом, стрелка севера и подсказка про клетку земли.
    await userEvent.click(canvas.getByRole('button', { name: schemesTexts.displayVolume }));
    const view = await waitFor(() => {
      const element = canvasElement.querySelector<HTMLElement>('[data-volume-view]');
      if (!element) throw new Error('нет вида объёма');
      return element;
    });
    await expect(Number(view.dataset.triangles)).toBeGreaterThan(20);
    await expect(within(view).getByText('Длинный дом')).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: schemesTexts.tools.rect })).toBeDisabled();
    // Выбор в объёме: щелчок мимо объектов снимает выбор, щелчок по дому под его подписью снова открывает свойства.
    const scene = within(view).getByRole('application', { name: schemesTexts.volumeView.label({ title: 'Перекрёсток' }) });
    const click = (x: number, y: number): void => {
      fireEvent.pointerDown(scene, { clientX: x, clientY: y, pointerId: 1 });
      fireEvent.pointerUp(scene, { clientX: x, clientY: y, pointerId: 1 });
    };
    await expect(view.querySelector('[data-volume-label="o2"]')).toHaveStyle({ fontWeight: '600' });
    const sceneBox = scene.getBoundingClientRect();
    click(sceneBox.left + 4, sceneBox.top + 4);
    await waitFor(() => expect(canvas.queryByRole('combobox', { name: volume.top })).toBeNull());
    const label = view.querySelector('[data-volume-label="o2"]')!.getBoundingClientRect();
    click(label.left + label.width / 2, label.bottom + 14);
    await expect(await canvas.findByRole('combobox', { name: volume.top })).toHaveTextContent(volume.topForms.ridge);
    // Облёт с клавиатуры не ломает сцену.
    within(view)
      .getByRole('application', { name: schemesTexts.volumeView.label({ title: 'Перекрёсток' }) })
      .focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}+');
    await expect(canvasElement.querySelector('[data-volume-view]')).toHaveAttribute('data-orbit', '225,40');
    // Поворот запоминается: после плана объём открывается тем же видом.
    await userEvent.click(canvas.getByRole('button', { name: schemesTexts.displayPlan }));
    await userEvent.click(canvas.getByRole('button', { name: schemesTexts.displayVolume }));
    await waitFor(() => expect(canvasElement.querySelector('[data-volume-view]')).toHaveAttribute('data-orbit', '225,40'));
    await userEvent.click(saveButton(canvas));
    await waitFor(() => expect(schemesStorySnapshot().saves).toBe(1));
    const house = schemesStorySnapshot().document.schemes[0].objects.find((object) => object.id === 'o2');
    await expect(house?.top).toEqual({ form: 'ridge', rise: 4, axis: 'y' });
    await userEvent.click(canvas.getByRole('button', { name: schemesTexts.displayPlan }));
    await canvasOf(canvas, 'Перекрёсток');
  }
};
