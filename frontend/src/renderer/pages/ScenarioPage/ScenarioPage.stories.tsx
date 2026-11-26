/** Целая страница «Сценарий» на локальной модели: переходы к планам, блок частей, закреплённые панели и сохранность черновика. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { componentsTexts } from '@shared/texts/components';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import { scenarioTexts } from '@shared/texts/scenario';
import { schemesTexts } from '@shared/texts/schemes';
import {
  SCENARIO_PAGE_READ_ERROR,
  ScenarioPageStory,
  scenarioPageActionProblem,
  scenarioPageOptions,
  scenarioCameraWindowInspection,
  scenarioFrameRequests,
  scenarioCameraWindowMessage,
  scenarioStateInspection
} from '../../testing/scenarioPageStories';
import { formatDateTime } from '../../format';

const meta = {
  title: 'Страницы/Сценарий',
  component: ScenarioPageStory,
  parameters: { songframe: scenarioPageOptions(), controls: { disable: true } },
  // Свёрнутость отчёта проверки хранится в окне: каждая история начинает с выбора по умолчанию.
  beforeEach: () => {
    try {
      localStorage.removeItem('songframe.scenarioCheck.reportOpen');
    } catch {
      // Хранилище недоступно: значение и так по умолчанию.
    }
  }
} satisfies Meta<typeof ScenarioPageStory>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];
type Screen = ReturnType<typeof within>;

// Прокрутка к плану, фокус диалогов и ввод текста в Docs сдвигали бы общую страницу: такие истории открываются только в Canvas.
const CANVAS_ONLY = ['!autodocs'];
const PROPOSAL_ACTION = 'Герой останавливается под дождём и смотрит на окно.';

const documentOf = (context: Context): Document => context.canvasElement.ownerDocument;
const screenOf = (context: Context): Screen => within(documentOf(context).body);

async function ready(context: Context, timeout = 4000): Promise<Screen> {
  const screen = screenOf(context);
  await screen.findByRole('heading', { name: navigationTexts.pages.scenario }, { timeout });
  return screen;
}
/** Раскрывает свёрнутую панель «Камера» справа от карты: крупность, угол обзора и высота. */
async function openCameraFields(scope: Screen): Promise<void> {
  const panel = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-camera-fields]');
    if (!found) throw new Error('Нет панели «Камера» справа от карты.');
    return found;
  });
  const summary = within(panel).getByRole('button', { name: new RegExp(`^${viewpointTexts.cameraSettings}`) });
  if (summary.getAttribute('aria-expanded') !== 'true') await userEvent.click(summary);
  await waitFor(() => expect(scope.getByRole('combobox', { name: viewpointTexts.size })).toBeVisible());
}
const editorHeading = (screen: Screen, shot: string) => screen.findByRole('heading', { name: shot, level: 6 }, { timeout: 3000 });
const field = (screen: Screen, name: string): HTMLInputElement => screen.getByRole('textbox', { name }) as HTMLInputElement;
const row = (context: Context, shot: string): HTMLElement => {
  const element = documentOf(context).querySelector<HTMLElement>(`[data-shot-id="${shot}"]`);
  if (!element) throw new Error(`Строка ${shot} не найдена в списке планов.`);
  return element;
};

/** План выбирается с клавиатуры: фокус на строке списка и Enter. */
async function selectByKeyboard(context: Context, shot: string): Promise<void> {
  row(context, shot).focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(row(context, shot)).toHaveAttribute('aria-current', 'true'));
  await editorHeading(screenOf(context), shot);
}

/** Цель прокрутки видна в окне и не закрыта шапкой и закреплённой панелью действий. */
async function expectRevealed(context: Context, element: Element): Promise<void> {
  const bar = documentOf(context).querySelector('[data-page-action-bar="top"]')!;
  await waitFor(
    () => {
      const rect = element.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(bar.getBoundingClientRect().bottom - 1);
      expect(rect.top).toBeLessThan(window.innerHeight);
    },
    { timeout: 3000 }
  );
}

const unsavedChip = (screen: Screen) => screen.queryByText(commonTexts.unsavedChanges);
/** Заголовок раскрываемого блока «Общие правила и части» (три части у обычного сценария). */
const partsBlock = (screen: Screen) => screen.getByRole('button', { name: scenarioTexts.treatment.title({ count: 3 }) });
const saveButton = (screen: Screen) => screen.getByRole('button', { name: commonTexts.save });

export const Overview: Story = {
  name: 'Обычный сценарий · первый план выбран, части свёрнуты, сохранять нечего',
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M01');
    await expect(row(context, 'M01')).toHaveAttribute('aria-current', 'true');
    // С планами блок частей свёрнут: на виду список планов; кнопок построения каркаса нет.
    await expect(partsBlock(screen)).toHaveAttribute('aria-expanded', 'false');
    await expect(screen.getByRole('button', { name: scenarioTexts.toolbar.recalculateBounds })).toBeEnabled();
    await expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
    await expect(saveButton(screen)).toBeDisabled();
    await expect(saveButton(screen)).toHaveAttribute('title', expect.stringContaining(scenarioTexts.toolbar.noChanges));
  }
};

export const StateColumnHeadings: Story = {
  name: 'Состояние героев и мира · заметные заголовки колонок «Первый кадр» и «Последний кадр»',
  tags: ['ci'],
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M01');
    const before = within(await screen.findByTestId('state-column-before'));
    const after = within(screen.getByTestId('state-column-after'));
    await expect(before.getByRole('heading', { name: scenarioTexts.state.beforeHeading })).toBeVisible();
    await expect(before.getByText(scenarioTexts.state.beforeHeadingHint)).toBeVisible();
    await expect(after.getByRole('heading', { name: scenarioTexts.state.afterHeading })).toBeVisible();
    await expect(after.getByText(scenarioTexts.state.afterHeadingHint)).toBeVisible();
  }
};

export const OpenShotFromRoute: Story = {
  name: 'Переход по ?shot=M03 · смена плана на открытой странице без потери правок',
  tags: CANVAS_ONLY,
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M03' }) },
  play: async (context) => {
    const screen = await ready(context);
    const heading = await editorHeading(screen, 'M03');
    await expect(row(context, 'M03')).toHaveAttribute('aria-current', 'true');
    await expectRevealed(context, heading);
    const reads = screen.getByTestId('page-model-reads').textContent;
    await userEvent.type(field(screen, scenarioTexts.fields.action), ' Правка M03.');
    await expect(unsavedChip(screen)).toBeInTheDocument();
    // Ссылка на открытой странице только выбирает план в черновике: сценарий не перечитывается.
    await userEvent.click(screen.getByRole('link', { name: 'Ссылка на план M05' }));
    await waitFor(() => expect(screen.getByTestId('story-route')).toHaveTextContent('/project/scenario?shot=M05'));
    await expectRevealed(context, await editorHeading(screen, 'M05'));
    await expect(screen.getByTestId('page-model-reads').textContent).toBe(reads);
    await selectByKeyboard(context, 'M03');
    await expect(field(screen, scenarioTexts.fields.action).value).toContain('Правка M03.');
    await expect(screen.getByTestId('page-model-shot-M03')).not.toHaveTextContent('Правка M03.');
    await expect(unsavedChip(screen)).toBeInTheDocument();
  }
};

export const OpenShotState: Story = {
  name: 'Источник значения врезки · переход к блоку состояния другого плана',
  tags: CANVAS_ONLY,
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M02' }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M02');
    await userEvent.type(field(screen, scenarioTexts.fields.camera), ' Правка M02.');
    // Унаследованное без изменений значение видно только при показе полного состояния.
    const onlyChanges = await screen.findByLabelText(scenarioTexts.brief.onlyChanges, undefined, { timeout: 3000 });
    await expect(onlyChanges).toBeChecked();
    await userEvent.click(onlyChanges);
    const source = scenarioTexts.brief.planSource({ shot: 'M01', phase: 'after' });
    const links = await screen.findAllByRole('button', { name: source }, { timeout: 3000 });
    // Уход на «Кастинг» потерял бы черновик: переход туда объясняет причину, а переход внутри страницы доступен.
    await waitFor(() => {
      const cast = screen.getAllByRole('button', { name: navigationTexts.pages.cast })[0];
      expect(cast).toBeDisabled();
      expect(cast).toHaveAttribute('title', expect.stringContaining(scenarioTexts.leave.scenesDirty));
    });
    await userEvent.click(links[0]);
    await editorHeading(screen, 'M01');
    const entity = documentOf(context).querySelector('[data-state-entity="after:hero"]');
    await expect(entity).not.toBeNull();
    await waitFor(() => expect(within(entity as HTMLElement).getAllByRole('button')[0]).toHaveAttribute('aria-expanded', 'true'));
    await expectRevealed(context, entity!);
    await selectByKeyboard(context, 'M02');
    await expect(field(screen, scenarioTexts.fields.camera).value).toContain('Правка M02.');
    await expect(screen.getByTestId('page-model-shot-M02')).not.toHaveTextContent('Правка M02.');
  }
};

export const StaticShotToggle: Story = {
  name: 'Сборка из опор · взаимоисключение с липсинком и производным планом',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M02' }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M02');
    const still = screen.getByRole('checkbox', { name: scenarioTexts.fields.staticShot });
    const lipsync = screen.getByRole('checkbox', { name: scenarioTexts.fields.lipsync });
    await expect(still).not.toBeChecked();
    await userEvent.click(still);
    await expect(still).toBeChecked();
    // У сборки из опор нет генерации видео: липсинк и сборка из другого плана закрыты.
    await expect(lipsync).toBeDisabled();
    await expect(screen.getByRole('combobox', { name: scenarioTexts.fields.derivedFrom })).toHaveClass('Mui-disabled');
    await expect(unsavedChip(screen)).toBeInTheDocument();
    await userEvent.click(still);
    await expect(lipsync).toBeEnabled();
    await userEvent.click(lipsync);
    await expect(screen.getByRole('checkbox', { name: scenarioTexts.fields.staticShot })).toBeDisabled();
  }
};

export const AcceptedShotLocked: Story = {
  name: 'Принятый M02 · постановка закрыта, соседняя граница тоже',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M02', accepted: ['M02'] }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M02');
    // Причина блокировки и путь к изменению видны над полями.
    // Заголовок подсказки повторяется под границей: её закрывает принятие самого плана.
    const titles = await screen.findAllByText(scenarioTexts.accepted.lockedTitle({ shot: 'M02' }));
    await expect(titles[0].closest('[role="alert"]')).not.toBeNull();
    await expect(screen.getByText(scenarioTexts.accepted.lockedHint)).toBeVisible();
    await expect(field(screen, scenarioTexts.fields.action)).toBeDisabled();
    await expect(field(screen, scenarioTexts.fields.camera)).toBeDisabled();
    await expect(screen.getByRole('combobox', { name: scenarioTexts.state.inherit })).toHaveAttribute('aria-disabled', 'true');
    await expect(screen.queryByRole('button', { name: scenarioTexts.delta.addEntity })).not.toBeInTheDocument();
    await expect(screen.getByRole('button', { name: scenarioTexts.shot.split })).toBeDisabled();
    // У M01 граница — начало принятого M02: она и объединение закрыты с причиной, остальная постановка открыта.
    await selectByKeyboard(context, 'M01');
    await expect(screen.queryByText(scenarioTexts.accepted.lockedTitle({ shot: 'M01' }))).not.toBeInTheDocument();
    await expect(field(screen, scenarioTexts.fields.action)).toBeEnabled();
    await expect(screen.getByText(scenarioTexts.accepted.boundaryReason({ shot: 'M02' }))).toBeVisible();
    await expect(screen.getByRole('button', { name: scenarioTexts.shot.mergeNext })).toHaveAttribute(
      'title',
      expect.stringContaining(scenarioTexts.accepted.mergeReason({ shot: 'M02' }))
    );
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
  }
};

const viewpointTexts = scenarioTexts.viewpoint;
const viewpointBlock = (screen: Screen) => screen.getByRole('button', { name: new RegExp(viewpointTexts.title) });

/** Щелчок по мини-схеме в доле её ширины и высоты. */
const clickPreview = (preview: Element, x: number, y: number): void => {
  const box = preview.getBoundingClientRect();
  const at = { clientX: box.left + box.width * x, clientY: box.top + box.height * y, pointerId: 1 };
  fireEvent.pointerDown(preview, at);
  fireEvent.pointerUp(preview, at);
};
const previewOf = async (screen: Screen, scope: Screen = screen): Promise<SVGSVGElement> =>
  (await scope.findByRole('application', { name: viewpointTexts.preview({ title: 'Ворота' }) })) as unknown as SVGSVGElement;

export const ViewpointCoordinates: Story = {
  name: 'Точка съёмки · числовой ввод места и направления камеры',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M03' }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M03');
    await userEvent.click(viewpointBlock(screen));
    await userEvent.click(await screen.findByRole('button', { name: viewpointTexts.create }));
    const map = within(await screen.findByRole('dialog', { name: viewpointTexts.fullscreenTitle({ shot: 'M03' }) }));
    const preview = await previewOf(screen, map);
    clickPreview(preview, 0.3, 0.5);
    await waitFor(() => expect(preview.querySelector('[data-camera]')).not.toBeNull());
    await userEvent.click(within(map.getByRole('group', { name: viewpointTexts.target })).getByRole('button', { name: /Герой/ }));
    clickPreview(preview, 0.7, 0.5);
    await waitFor(() => expect(preview.querySelector('[data-subject="hero"]')).not.toBeNull());
    // Факты кадра запрашиваются по текущей расстановке: по ним видно, что числа записаны в точку.
    const agentFacts = document.querySelector<HTMLElement>('[data-agent-facts]')!;
    await userEvent.click(within(agentFacts).getByRole('button', { name: new RegExp(viewpointTexts.agentFacts) }));
    const camera = within(map.getByRole('group', { name: `${viewpointTexts.coords}: ${viewpointTexts.camera}` }));
    const x = camera.getByRole('spinbutton', { name: viewpointTexts.coordX });
    await userEvent.clear(x);
    await userEvent.type(x, '2.5{Enter}');
    await waitFor(() => expect(scenarioFrameRequests().at(-1)?.camera?.start?.[0]).toBe(2.5));
    // Направление числом становится своим направлением камеры, как поворот ромбом на схеме.
    const heading = camera.getByRole('spinbutton', { name: viewpointTexts.headingField });
    await userEvent.clear(heading);
    await userEvent.type(heading, '101{Enter}');
    await waitFor(() => expect(scenarioFrameRequests().at(-1)?.heading?.start).toBe(101));
    await expect(document.querySelector('[data-viewpoint-row="camera"]')).toHaveTextContent(viewpointTexts.headingOwn);
    // Неподвижная камера: полей конца нет, пока не выбран последний кадр. С ним поля конца показывают место первого
    // кадра, ввод создаёт конец пути и не трогает начало.
    await expect(camera.queryByRole('spinbutton', { name: viewpointTexts.coordXEnd })).toBeNull();
    await userEvent.click(within(map.getByRole('group', { name: viewpointTexts.phase })).getByRole('button', { name: viewpointTexts.phases.end }));
    const xEnd = camera.getByRole('spinbutton', { name: viewpointTexts.coordXEnd });
    await expect(xEnd).toHaveValue(2.5);
    await expect(camera.getByRole('spinbutton', { name: viewpointTexts.headingFieldEnd })).toHaveValue(101);
    await userEvent.clear(xEnd);
    await userEvent.type(xEnd, '3.5{Enter}');
    await waitFor(() => expect(scenarioFrameRequests().at(-1)?.camera?.end?.[0]).toBe(3.5));
    await expect(scenarioFrameRequests().at(-1)?.camera?.start?.[0]).toBe(2.5);
    await expect(camera.getByRole('spinbutton', { name: viewpointTexts.coordX })).toHaveValue(2.5);
    // У героя — только место: направление задаёт камера.
    const hero = within(map.getByRole('group', { name: new RegExp(`^${viewpointTexts.coords}: Герой`) }));
    await expect(hero.queryByRole('spinbutton', { name: viewpointTexts.headingField })).toBeNull();
    const y = hero.getByRole('spinbutton', { name: viewpointTexts.coordY });
    await userEvent.clear(y);
    await userEvent.type(y, '-1{Enter}');
    await waitFor(() => expect(scenarioFrameRequests().at(-1)?.subjects?.[0]?.start?.[1]).toBe(-1));
  }
};

export const ViewpointCopiedFromShot: Story = {
  name: 'Точка съёмки · «Взять с плана» переносит расстановку последнего кадра другого плана',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M03', placed: ['M01'] }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M03');
    await userEvent.click(viewpointBlock(screen));
    // Кнопка стоит рядом с «Задать точку съёмки»; в меню — только планы с точкой съёмки.
    await userEvent.click(await screen.findByRole('button', { name: viewpointTexts.copyFrom }));
    const items = await screen.findAllByRole('menuitem');
    await expect(items.map((item: HTMLElement) => item.textContent)).toEqual([expect.stringMatching(/^M01 · /)]);
    await userEvent.click(items[0]);
    // Карта открывается сразу: камера и герой стоят там же, где у M01.
    const map = within(await screen.findByRole('dialog', { name: viewpointTexts.fullscreenTitle({ shot: 'M03' }) }));
    // Расстановка M01 сразу в черновике сценария.
    await waitFor(() => expect(scenarioStateInspection().draft).toContain('"camera":{"start":[0,-8]}'));
    await expect(scenarioStateInspection().draft).toContain('"subjects":[{"entity":"hero","start":[0,3]}]');
    const camera = within(map.getByRole('group', { name: new RegExp(`^${viewpointTexts.coords}: ${viewpointTexts.camera}`) }));
    await expect(camera.getByRole('spinbutton', { name: viewpointTexts.coordY })).toHaveValue(-8);
    const hero = within(map.getByRole('group', { name: new RegExp(`^${viewpointTexts.coords}: Герой`) }));
    await expect(hero.getByRole('spinbutton', { name: viewpointTexts.coordY })).toHaveValue(3);
  }
};

export const ViewpointVehicleFacing: Story = {
  name: 'Точка съёмки · стоящая машина передом к камере, своё направление числом',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M03', placed: ['M03'], vehicleHero: true }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M03');
    await userEvent.click(viewpointBlock(screen));
    await userEvent.click(await screen.findByRole('button', { name: viewpointTexts.openMap }));
    const map = within(await screen.findByRole('dialog', { name: viewpointTexts.fullscreenTitle({ shot: 'M03' }) }));
    const agentFacts = document.querySelector<HTMLElement>('[data-agent-facts]')!;
    await userEvent.click(within(agentFacts).getByRole('button', { name: new RegExp(viewpointTexts.agentFacts) }));
    // Машина к югу от камеры не смотрит: без своего направления она стоит передом к камере — на юг, 270°.
    const hero = within(map.getByRole('group', { name: new RegExp(`^${viewpointTexts.coords}: Герой`) }));
    const facing = hero.getByRole('spinbutton', { name: viewpointTexts.facingField });
    await expect(facing).toHaveValue(270);
    await userEvent.clear(facing);
    await userEvent.type(facing, '0{Enter}');
    await waitFor(() => expect(scenarioFrameRequests().at(-1)?.subjects?.[0]?.facing).toBe(0));
    // Пустое поле возвращает направление по умолчанию.
    await userEvent.clear(facing);
    await userEvent.type(facing, '{Enter}');
    await waitFor(() => expect(scenarioFrameRequests().at(-1)?.subjects?.[0]?.facing).toBeUndefined());
    await expect(facing).toHaveValue(270);
  }
};

export const ViewpointReferenceRemoved: Story = {
  name: 'Точка съёмки · герой, убранный из референсов, уходит и с карты',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M03' }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M03');
    await userEvent.click(viewpointBlock(screen));
    await userEvent.click(await screen.findByRole('button', { name: viewpointTexts.create }));
    let map = within(await screen.findByRole('dialog', { name: viewpointTexts.fullscreenTitle({ shot: 'M03' }) }));
    let preview = await previewOf(screen, map);
    clickPreview(preview, 0.3, 0.5);
    await waitFor(() => expect(preview.querySelector('[data-camera]')).not.toBeNull());
    await userEvent.click(within(map.getByRole('group', { name: viewpointTexts.target })).getByRole('button', { name: /Герой/ }));
    clickPreview(preview, 0.7, 0.5);
    await waitFor(() => expect(preview.querySelector('[data-subject="hero"]')).not.toBeNull());
    await userEvent.click(map.getByRole('button', { name: commonTexts.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Референс убирается крестиком на его чипе в «В кадре (референсы)».
    const references = screen.getByRole('combobox', { name: scenarioTexts.shot.references }).closest('.MuiAutocomplete-root') as HTMLElement;
    const chip = within(references).getByRole('button', { name: /Герой/ });
    await userEvent.click(chip.querySelector('.MuiChip-deleteIcon')!);
    await waitFor(() => expect(within(references).queryByRole('button', { name: /Герой/ })).toBeNull());
    // На карте нет ни точки героя, ни его строки; камера осталась на месте.
    await userEvent.click(screen.getByRole('button', { name: viewpointTexts.openMap }));
    map = within(await screen.findByRole('dialog', { name: viewpointTexts.fullscreenTitle({ shot: 'M03' }) }));
    preview = await previewOf(screen, map);
    await expect(preview.querySelector('[data-camera]')).not.toBeNull();
    await expect(preview.querySelector('[data-subject="hero"]')).toBeNull();
    await expect(map.queryByRole('group', { name: new RegExp(`^${viewpointTexts.coords}: Герой`) })).toBeNull();
  }
};

export const ViewpointSet: Story = {
  name: 'Точка съёмки · карта во весь экран: камера и герои, дом со схемы, сторона по точкам, движение, свой угол и запись',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M03' }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M03');
    // Свёрнутый блок показывает бейдж «не задана»; раскрытие читает схемы локаций.
    await expect(viewpointBlock(screen)).toHaveTextContent(viewpointTexts.badgeUnset);
    await userEvent.click(viewpointBlock(screen));
    await userEvent.click(await screen.findByRole('button', { name: viewpointTexts.create }));
    // Новая точка сразу открывает карту во весь экран: в блоке сценария плана только кнопка «Открыть карту».
    const map = within(await screen.findByRole('dialog', { name: viewpointTexts.fullscreenTitle({ shot: 'M03' }) }));
    // Дом нарисован на схеме объектом со ссылкой на референс: его не ставят точкой, строка показывает его со схемы.
    await expect(within(map.getByRole('group', { name: viewpointTexts.target })).queryByRole('button', { name: /Дом/ })).toBeNull();
    await expect(document.querySelector('[data-viewpoint-linked="house"]')).toHaveTextContent(viewpointTexts.linked);
    // Камера слева, герой справа на той же высоте: камера смотрит на восток и сама получает сторону «с запада».
    const preview = await previewOf(screen, map);
    // Как в редакторе схем: строки камеры и героев слева от карты, свёрнутые поля камеры справа.
    const rowsBox = document.querySelector('[data-viewpoint-rows]')!.getBoundingClientRect();
    const mapBox = preview.getBoundingClientRect();
    const fieldsBox = document.querySelector('[data-camera-fields]')!.getBoundingClientRect();
    await expect(rowsBox.right).toBeLessThanOrEqual(mapBox.left);
    await expect(fieldsBox.left).toBeGreaterThanOrEqual(mapBox.right);
    await expect(map.queryByRole('combobox', { name: viewpointTexts.size })).toBeNull();
    clickPreview(preview, 0.3, 0.5);
    await waitFor(() => expect(preview.querySelector('[data-camera]')).not.toBeNull());
    await userEvent.click(within(map.getByRole('group', { name: viewpointTexts.target })).getByRole('button', { name: /Герой/ }));
    clickPreview(preview, 0.7, 0.5);
    await waitFor(() => expect(preview.querySelector('[data-subject="hero"]')).not.toBeNull());
    await expect(await map.findByText(viewpointTexts.sideFromPoints({ side: viewpointTexts.sides.west }))).toBeVisible();
    // С камерой у дома есть расстояние до ближайшего края.
    await expect(document.querySelector('[data-viewpoint-linked="house"]')).toHaveTextContent(/м от камеры до ближайшего края/);
    await expect(map.getByRole('button', { name: viewpointTexts.sides.south })).toBeDisabled();
    await expect(document.querySelector('[data-viewpoint-row="hero"]')).toHaveTextContent(viewpointTexts.lead);
    await expect(document.querySelector('[data-viewpoint-row="hero"] [data-out-of-frame]')).toBeNull();
    // «Что получит агент»: факты кадра текущей, ещё не сохранённой расстановки (модель истории отвечает упрощённо).
    const agentFacts = document.querySelector<HTMLElement>('[data-agent-facts]')!;
    await expect(agentFacts.getBoundingClientRect().left).toBeGreaterThanOrEqual(mapBox.right);
    await userEvent.click(within(agentFacts).getByRole('button', { name: new RegExp(viewpointTexts.agentFacts) }));
    const facts = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-agent-frame]');
      if (!found) throw new Error('Нет фактов кадра.');
      return found;
    });
    await expect(facts).toHaveTextContent(viewpointTexts.agentLead);
    await expect(facts).toHaveTextContent(/Герой/);
    await expect(scenarioFrameRequests().at(-1)?.subjects?.[0]?.entity).toBe('hero');
    await userEvent.click(within(facts).getByRole('button', { name: viewpointTexts.agentShowJson }));
    await expect(document.querySelector('[data-agent-json]')).toHaveTextContent('"in_frame": true');
    // «Скопировать» кладёт в буфер тот же JSON, что показан.
    const writes: string[] = [];
    const original = navigator.clipboard?.writeText;
    if (navigator.clipboard) navigator.clipboard.writeText = async (text: string) => void writes.push(text);
    try {
      await userEvent.click(within(facts).getByRole('button', { name: viewpointTexts.agentCopyJson }));
      await waitFor(() => expect(writes).toEqual([document.querySelector('[data-agent-json]')?.textContent]));
    } finally {
      if (navigator.clipboard && original) navigator.clipboard.writeText = original;
    }
    // Последний кадр камеры: камера проезжает вниз по схеме, путь и сектор конца видны пунктиром.
    await userEvent.click(within(map.getByRole('group', { name: viewpointTexts.target })).getByRole('button', { name: viewpointTexts.camera }));
    await userEvent.click(map.getByRole('button', { name: viewpointTexts.phases.end }));
    clickPreview(preview, 0.3, 0.8);
    await waitFor(() => expect(preview.querySelector('[data-camera-end]')).not.toBeNull());
    await expect(document.querySelector('[data-viewpoint-row="camera"]')).toHaveTextContent(/движется на/);
    // Правка точки пересчитывает факты: панель запрашивает их по новой расстановке.
    await waitFor(() => expect(scenarioFrameRequests().at(-1)?.camera?.end).toBeDefined());
    // Крупность меняет угол по умолчанию; свой угол хранится отдельно и возвращается кнопкой.
    await openCameraFields(map);
    await userEvent.click(map.getByRole('combobox', { name: viewpointTexts.size }));
    await userEvent.click(await screen.findByRole('option', { name: viewpointTexts.sizes.close }));
    const fov = map.getByRole('spinbutton', { name: viewpointTexts.fov }) as HTMLInputElement;
    await expect(fov.value).toBe('25');
    await userEvent.clear(fov);
    await userEvent.type(fov, '16');
    // Угол применяется по уходу из поля: промежуточные «1» не обрезаются до наименьшего угла.
    await userEvent.tab();
    await expect(map.getByText(viewpointTexts.fovOwn({ fov: 25 }))).toBeVisible();
    // Второй герой далеко в стороне: камера целится между героями, при узком угле оба вне кадра.
    await userEvent.click(map.getByRole('button', { name: viewpointTexts.phases.start }));
    await userEvent.click(within(map.getByRole('group', { name: viewpointTexts.target })).getByRole('button', { name: /Сосед/ }));
    clickPreview(preview, 0.7, 0.1);
    await waitFor(() => expect(document.querySelector('[data-viewpoint-row="neighbor"] [data-out-of-frame="start"]')).not.toBeNull());
    await expect(document.querySelector('[data-viewpoint-row="hero"] [data-out-of-frame="start"]')).not.toBeNull();
    await expect(document.querySelector('[data-viewpoint-row="hero"]')).toHaveTextContent(viewpointTexts.lead);
    // Своё направление: ромб посередине дуги поворачивает камеру прямо на героя — он в первом кадре, сосед нет.
    // Камера при этом уезжает вниз, не поворачиваясь, поэтому на последнем кадре герой может выйти из кадра.
    const rotor = preview.querySelector('[data-heading-handle="start"]')!;
    const heroMark = preview.querySelector('[data-subject="hero"] circle')!.getBoundingClientRect();
    const target = { clientX: heroMark.left + heroMark.width / 2, clientY: heroMark.top + heroMark.height / 2, pointerId: 1 };
    fireEvent.pointerDown(rotor, target);
    fireEvent.pointerMove(preview, target);
    fireEvent.pointerUp(preview, target);
    await waitFor(() => expect(document.querySelector('[data-viewpoint-row="hero"] [data-out-of-frame="start"]')).toBeNull());
    await expect(document.querySelector('[data-viewpoint-row="neighbor"] [data-out-of-frame="start"]')).not.toBeNull();
    await expect(document.querySelector('[data-viewpoint-row="camera"]')).toHaveTextContent(viewpointTexts.headingOwn);
    // «Прицел на героев» возвращает автоматическое направление.
    await userEvent.click(map.getByRole('button', { name: viewpointTexts.headingAuto }));
    await waitFor(() => expect(document.querySelector('[data-viewpoint-row="hero"] [data-out-of-frame="start"]')).not.toBeNull());
    await expect(map.queryByRole('button', { name: viewpointTexts.headingAuto })).toBeNull();
    // Расстановка уже во временном файле: падение программы её не потеряет.
    await waitFor(() => expect(scenarioStateInspection().draft).toContain('"entity":"hero"'));
    await userEvent.click(map.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1'));
    // Сохранение удаляет временный файл.
    await waitFor(() => expect(scenarioStateInspection().draft).toBeNull());
    const saved = scenarioStateInspection().saved.scenes!.scenes.find((shot) => shot.id === 'M03')!.viewpoint!;
    await expect(saved).toMatchObject({ location: 'gate', side: 'west', size: 'close', fov: 16 });
    await expect(saved.camera?.end).toHaveLength(2);
    await expect(saved.subjects?.map((subject) => subject.entity)).toEqual(['hero', 'neighbor']);
    // После закрытия карты бейдж блока говорит итог расстановки.
    await userEvent.click(map.getByRole('button', { name: commonTexts.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(viewpointBlock(screen)).toHaveTextContent(viewpointTexts.badge({ side: 'С запада', size: 'Крупный', placed: true }));
    const openMap = screen.getByRole('button', { name: viewpointTexts.openMap });
    await expect(openMap).toBeVisible();
    // «Убрать точку съёмки» стоит в одной строке с «Открыть карту», а не под ней.
    const remove = screen.getByRole('button', { name: viewpointTexts.remove });
    const middle = (element: HTMLElement): number => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    await expect(Math.abs(middle(remove) - middle(openMap))).toBeLessThan(2);
    await expect(remove.getBoundingClientRect().left).toBeGreaterThan(openMap.getBoundingClientRect().right);
  }
};

export const ViewpointFullscreen: Story = {
  name: 'Точка съёмки во весь экран · сектор под курсором, перетаскивание, масштаб ползунком, «Сохранить» в шапке',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M03' }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M03');
    await userEvent.click(viewpointBlock(screen));
    await userEvent.click(await screen.findByRole('button', { name: viewpointTexts.create }));
    const dialog = within(await screen.findByRole('dialog', { name: viewpointTexts.fullscreenTitle({ shot: 'M03' }) }));
    const preview = await previewOf(screen, dialog);
    const box = preview.getBoundingClientRect();
    const at = (x: number, y: number) => ({ clientX: box.left + box.width * x, clientY: box.top + box.height * y, pointerId: 1 });
    // Пока выбрана камера, под курсором её будущий сектор — до щелчка видно, что попадёт в кадр.
    fireEvent.pointerMove(preview, at(0.5, 0.8));
    await waitFor(() => expect(preview.querySelector('[data-ghost]')).not.toBeNull());
    // React узнаёт об уходе указателя по pointerout с целью вне схемы.
    fireEvent.pointerOut(preview, { relatedTarget: document.body });
    await waitFor(() => expect(preview.querySelector('[data-ghost]')).toBeNull());
    await userEvent.click(within(dialog.getByRole('group', { name: viewpointTexts.target })).getByRole('button', { name: /Сосед/ }));
    clickPreview(preview, 0.5, 0.4);
    await waitFor(() => expect(preview.querySelector('[data-subject="neighbor"] [data-mark="start"]')).not.toBeNull());
    // У соседа нет роста в кастинге: фигура условная, строка это показывает.
    await expect(dialog.getByText(viewpointTexts.heightUnknown)).toBeVisible();
    // Поставленного героя можно перетащить: метка переезжает, схема под ней не сдвигается.
    const mark = preview.querySelector('[data-subject="neighbor"] [data-mark="start"]')!;
    const before = mark.getAttribute('cx');
    fireEvent.pointerDown(mark, at(0.5, 0.4));
    fireEvent.pointerMove(preview, at(0.6, 0.3));
    fireEvent.pointerUp(preview, at(0.6, 0.3));
    await waitFor(() => expect(preview.querySelector('[data-subject="neighbor"] [data-mark="start"]')!.getAttribute('cx')).not.toBe(before));
    // На последнем кадре перетаскивание неподвижного героя задаёт конец пути, начало остаётся на месте.
    const placed = preview.querySelector('[data-subject="neighbor"] [data-mark="start"]')!.getAttribute('cx');
    await userEvent.click(within(dialog.getByRole('group', { name: viewpointTexts.phase })).getByRole('button', { name: viewpointTexts.phases.end }));
    fireEvent.pointerDown(preview.querySelector('[data-subject="neighbor"] [data-mark="start"]')!, at(0.6, 0.3));
    fireEvent.pointerMove(preview, at(0.7, 0.3));
    fireEvent.pointerUp(preview, at(0.7, 0.3));
    await waitFor(() => expect(preview.querySelector('[data-subject="neighbor"] [data-mark="end"]')).not.toBeNull());
    await expect(preview.querySelector('[data-subject="neighbor"] [data-mark="start"]')!.getAttribute('cx')).toBe(placed);
    await userEvent.click(within(dialog.getByRole('group', { name: viewpointTexts.phase })).getByRole('button', { name: viewpointTexts.phases.start }));
    await expect(dialog.queryByRole('button', { name: schemesTexts.fit })).toBeNull();
    // Масштаб — ползунком, не колесом: колесо листает страницу.
    fireEvent.wheel(preview, { deltaY: 100, ...at(0.5, 0.5) });
    await expect(dialog.queryByRole('button', { name: schemesTexts.fit })).toBeNull();
    dialog.getByRole('slider', { name: schemesTexts.previewZoom }).focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    const fit = await dialog.findByRole('button', { name: schemesTexts.fit });
    // Перетаскивание пустого места сдвигает схему и ничего не ставит.
    await userEvent.click(within(dialog.getByRole('group', { name: viewpointTexts.target })).getByRole('button', { name: viewpointTexts.camera }));
    fireEvent.pointerDown(preview, at(0.3, 0.7));
    fireEvent.pointerMove(preview, at(0.4, 0.75));
    fireEvent.pointerUp(preview, at(0.4, 0.75));
    await expect(preview.querySelector('[data-camera]')).toBeNull();
    await userEvent.click(fit);
    await waitFor(() => expect(dialog.queryByRole('button', { name: schemesTexts.fit })).toBeNull());
    // Высота камеры: кнопка типовой высоты и своя высота на последнем кадре (кран).
    await openCameraFields(dialog);
    const presets = within(dialog.getByLabelText(viewpointTexts.cameraHeightPresets));
    await userEvent.click(presets.getByRole('button', { name: viewpointTexts.cameraHeightPreset({ name: viewpointTexts.heightPresets.drone, metres: '10' }) }));
    await expect(dialog.getByRole('spinbutton', { name: viewpointTexts.cameraHeight })).toHaveValue(10);
    const end = dialog.getByRole('spinbutton', { name: viewpointTexts.cameraHeightEnd });
    await userEvent.type(end, '2.5{Enter}');
    // Наклон ползунками: круто вниз на первом кадре, к последнему камера поднимает взгляд; итог — в заголовке панели.
    const tiltSlider = (phase: 'start' | 'end'): HTMLElement =>
      dialog.getAllByRole('slider').find((slider) => slider.closest(`[data-camera-tilt-phase="${phase}"]`))!;
    tiltSlider('start').focus();
    await userEvent.keyboard('{Home}');
    tiltSlider('end').focus();
    await userEvent.keyboard('{Home}{ArrowRight}{ArrowRight}{ArrowRight}');
    await expect(dialog.getByText(viewpointTexts.tiltOwnMoves)).toBeVisible();
    await expect(document.querySelector('[data-camera-fields]')).toHaveTextContent('наклон −90° → −87°');
    // «Сохранить» в шапке окна записывает сценарий; закрытие окна ничего не спрашивает.
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1'));
    await expect(scenarioStateInspection().saved.scenes!.scenes.find((shot) => shot.id === 'M03')!.viewpoint!.camera_height).toEqual({ start: 10, end: 2.5 });
    await expect(scenarioStateInspection().saved.scenes!.scenes.find((shot) => shot.id === 'M03')!.viewpoint!.tilt).toEqual({ start: -90, end: -87 });
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Расстановка живёт только в окне карты; бейдж блока говорит, что герои на схеме.
    await expect(document.querySelector('[data-viewpoint-row]')).toBeNull();
    await expect(viewpointBlock(screen)).toHaveTextContent(viewpointTexts.badge({ side: 'С юга', size: 'Общий', placed: true }));
  }
};

export const ViewpointCameraWindow: Story = {
  name: 'Вид из камеры в отдельном окне · кнопка в шапке карты, кадры следуют за картой, зум из окна, закрытие',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M03' }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M03');
    await userEvent.click(viewpointBlock(screen));
    await userEvent.click(await screen.findByRole('button', { name: viewpointTexts.create }));
    const dialog = within(await screen.findByRole('dialog', { name: viewpointTexts.fullscreenTitle({ shot: 'M03' }) }));
    // Встроенного вида в карте нет: он только в отдельном окне, кнопка — в шапке рядом с «Сохранить».
    await expect(document.querySelector('[data-camera-frame]')).toBeNull();
    await userEvent.click(dialog.getByRole('button', { name: viewpointTexts.cameraOpen }));
    await expect(await dialog.findByRole('button', { name: viewpointTexts.cameraClose })).toBeVisible();
    await waitFor(() => expect(scenarioCameraWindowInspection().states).toHaveLength(1));
    const [first] = scenarioCameraWindowInspection().states;
    await expect(first.title).toBe(viewpointTexts.cameraWindowTitle({ shot: 'M03', location: 'Старые ворота' }));
    await expect(first).toMatchObject({ editable: true, viewpoint: { location: 'gate' }, heights: { hero: 1.8 } });
    // Правка в карте сразу уходит в окно.
    await openCameraFields(dialog);
    const presets = within(dialog.getByLabelText(viewpointTexts.cameraHeightPresets));
    await userEvent.click(presets.getByRole('button', { name: viewpointTexts.cameraHeightPreset({ name: viewpointTexts.heightPresets.drone, metres: '10' }) }));
    await waitFor(() => expect(scenarioCameraWindowInspection().states.at(-1)!.viewpoint.camera_height).toEqual({ start: 10 }));
    // Наклон ползунком тоже сразу уходит в окно; «Наклон по герою» возвращает автоматический.
    const tilt = dialog.getAllByRole('slider').find((slider) => slider.closest('[data-camera-tilt-phase="start"]'))!;
    tilt.focus();
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(scenarioCameraWindowInspection().states.at(-1)!.viewpoint.tilt).toEqual({ start: -90 }));
    await userEvent.click(dialog.getByRole('button', { name: viewpointTexts.tiltReset }));
    await waitFor(() => expect(scenarioCameraWindowInspection().states.at(-1)!.viewpoint.tilt).toBeUndefined());
    // Зум в окне меняет угол обзора точки: поле карты и следующее состояние окна.
    scenarioCameraWindowMessage({ type: 'fov', fov: 16 });
    await waitFor(() => expect((dialog.getByRole('spinbutton', { name: viewpointTexts.fov }) as HTMLInputElement).value).toBe('16'));
    await waitFor(() => expect(scenarioCameraWindowInspection().states.at(-1)!.viewpoint.fov).toBe(16));
    // Кнопка в шапке закрывает окно.
    await userEvent.click(dialog.getByRole('button', { name: viewpointTexts.cameraClose }));
    await expect(await dialog.findByRole('button', { name: viewpointTexts.cameraOpen })).toBeVisible();
    await expect(scenarioCameraWindowInspection().open).toBe(false);
    // Закрытие карты закрывает и отдельное окно.
    await userEvent.click(dialog.getByRole('button', { name: viewpointTexts.cameraOpen }));
    await waitFor(() => expect(scenarioCameraWindowInspection().open).toBe(true));
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(scenarioCameraWindowInspection().open).toBe(false));
  }
};

export const ViewpointAcceptedUnlock: Story = {
  name: 'Точка съёмки принятого M02 · закрыта, открывается после подтверждения с риском',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M02', accepted: ['M02'] }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M02');
    await userEvent.click(viewpointBlock(screen));
    await expect(await screen.findByText(viewpointTexts.lockedHint)).toBeVisible();
    // Закрытая точка не показывает действий правки: вход один — «Изменить точку съёмки».
    await expect(screen.queryByRole('button', { name: viewpointTexts.create })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: viewpointTexts.unlock }));
    const dialog = within(await screen.findByRole('dialog', { name: viewpointTexts.unlockTitle({ shot: 'M02' }) }));
    await expect(dialog.getByText(viewpointTexts.unlockText)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: viewpointTexts.unlockConfirm }));
    await waitFor(() => expect(screen.queryByText(viewpointTexts.lockedHint)).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: viewpointTexts.create }));
    const map = within(await screen.findByRole('dialog', { name: viewpointTexts.fullscreenTitle({ shot: 'M02' }) }));
    await userEvent.click(map.getByRole('button', { name: commonTexts.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(viewpointBlock(screen)).toHaveTextContent(viewpointTexts.badge({ side: 'С юга', size: 'Общий', placed: false }));
    // Остальная постановка принятого плана остаётся закрытой.
    await expect(field(screen, scenarioTexts.fields.camera)).toBeDisabled();
  }
};

export const ViewpointAcceptedPlaced: Story = {
  name: 'Расставленная точка съёмки принятого M02 · карта скрыта, пока точка закрыта',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M02', accepted: ['M02'], placed: ['M02'] }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M02');
    await userEvent.click(viewpointBlock(screen));
    await expect(await screen.findByText(viewpointTexts.lockedHint)).toBeVisible();
    await expect(screen.queryByRole('button', { name: viewpointTexts.openMap })).toBeNull();
    await expect(screen.queryByRole('button', { name: viewpointTexts.remove })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: viewpointTexts.unlock }));
    const dialog = within(await screen.findByRole('dialog', { name: viewpointTexts.unlockTitle({ shot: 'M02' }) }));
    await userEvent.click(dialog.getByRole('button', { name: viewpointTexts.unlockConfirm }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // После подтверждения карта и «Убрать точку съёмки» возвращаются.
    await expect(await screen.findByRole('button', { name: viewpointTexts.openMap })).toBeVisible();
    await expect(screen.getByRole('button', { name: viewpointTexts.remove })).toBeVisible();
  }
};

export const MergeAndSplit: Story = {
  name: 'Объединение и деление · коды остальных планов не меняются',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M01', videoProvider: true }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M01');
    // Объединение M01 по M03: окно предупреждает о длине больше предела запроса видео и называет исчезающие коды.
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.shot.mergeNext }));
    const merge = await screen.findByRole('dialog', { name: scenarioTexts.shot.mergeTitle({ shot: 'M01' }) });
    await userEvent.click(within(merge).getByRole('combobox', { name: scenarioTexts.shot.mergeUntil }));
    await userEvent.click(await screen.findByRole('option', { name: scenarioTexts.shot.mergeOption({ id: 'M03', seconds: '12.0' }) }));
    await expect(within(merge).getByText(scenarioTexts.shot.mergeTooLong({ seconds: '12.0', max: 10 }))).toBeVisible();
    await expect(within(merge).getByText(/Коды M02, M03 исчезнут/)).toBeVisible();
    await userEvent.click(within(merge).getByRole('button', { name: scenarioTexts.shot.mergeConfirm }));
    await waitFor(() => expect(documentOf(context).querySelector('[data-shot-id="M02"]')).toBeNull());
    await expect(documentOf(context).querySelector('[data-shot-id="M03"]')).toBeNull();
    await expect(row(context, 'M04')).toBeInTheDocument();
    await expect(field(screen, scenarioTexts.shot.original).value).toContain(' / ');
    // Разные действия склеены с пометкой: поле подсвечено и объясняет, что сделать, в списке план помечен «доделать».
    await expect(field(screen, scenarioTexts.fields.action).value).toMatch(/^ЗАПОЛНИТЬ: свести в одну постановку — /);
    await expect(screen.getAllByText(scenarioTexts.shot.fillMarker).length).toBeGreaterThan(0);
    await expect(within(row(context, 'M01')).getByText(scenarioTexts.shot.unfilled)).toBeVisible();
    // Деление объединённого плана идёт по началу строки песни; новая половина получает свободный код M01.1.
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.shot.split }));
    const split = await screen.findByRole('dialog', { name: scenarioTexts.shot.splitTitle({ shot: 'M01' }) });
    await expect(within(split).getByText(/по началу строки песни/)).toBeVisible();
    await userEvent.click(within(split).getByRole('button', { name: scenarioTexts.shot.splitConfirm }));
    await editorHeading(screen, 'M01.1');
    await expect(row(context, 'M01.1')).toHaveAttribute('aria-current', 'true');
    await expect(field(screen, scenarioTexts.fields.action).value).toMatch(/^ЗАПОЛНИТЬ: разделить между M01 и M01\.1 — /);
    await expect(row(context, 'M04')).toBeInTheDocument();
    await expect(unsavedChip(screen)).toBeInTheDocument();
  }
};

export const BriefOutsidePlan: Story = {
  name: 'Врезка · сущности вне плана свёрнуты и не идут агенту',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M02' }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M02');
    // В M02 в кадре только герой: сосед, дом и ворота вычислены, но во врезку агенту не входят.
    const summary = await screen.findByRole('button', { name: new RegExp(scenarioTexts.brief.outsidePlan({ count: 3 })) }, { timeout: 3000 });
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect(screen.getByText(scenarioTexts.brief.outsidePlanHint)).toBeVisible();
    // Вопросы сверки и текст для агента — только о герое плана.
    await expect(screen.queryAllByText(/^(Паша|Ворота):/)).toHaveLength(0);
    const outside = within(summary.closest('.MuiAccordion-root') as HTMLElement);
    await expect(outside.getByText('Сосед Паша')).not.toBeVisible();

    // Раскрытие показывает их состояние, чтобы сверить непрерывность, не меняя врезку.
    await userEvent.click(summary);
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(outside.getByText('Сосед Паша')).toBeVisible());
    await expect(outside.getByText('Старые ворота')).toBeVisible();

    // «Текст для агента» — такой же раздел врезки: раскрывается по заголовку и показывает абзацы промпта.
    const agentText = screen.getByRole('button', { name: scenarioTexts.brief.agentText });
    await expect(agentText).toHaveAttribute('aria-expanded', 'false');
    await expect(screen.queryByText(scenarioTexts.brief.agentTextHint)).not.toBeInTheDocument();
    await userEvent.click(agentText);
    await expect(agentText).toHaveAttribute('aria-expanded', 'true');
    await expect(await screen.findByText(scenarioTexts.brief.agentTextHint)).toBeVisible();
  }
};

export const PartsWithShots: Story = {
  name: 'Общие правила и части · правка логлайна и плана — один сценарий, одно сохранение',
  tags: ['!autodocs', 'ci'],
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M01');
    await userEvent.click(partsBlock(screen));
    await expect(partsBlock(screen)).toHaveAttribute('aria-expanded', 'true');
    // На код части ссылаются планы: у части с планами он закрыт, удаление тоже.
    const codes = screen.getAllByRole('textbox', { name: scenarioTexts.fields.code });
    await expect(codes[0]).toHaveAttribute('readonly');
    await expect(screen.getAllByText(scenarioTexts.treatment.partShots({ count: 2 }))).toHaveLength(3);
    await expect(screen.getByRole('button', { name: scenarioTexts.treatment.deletePart({ title: 'Возвращение', id: 'intro' }) })).toBeDisabled();

    const logline = field(screen, scenarioTexts.fields.logline);
    await userEvent.clear(logline);
    await userEvent.type(logline, 'Черновик логлайна.');
    await userEvent.type(field(screen, scenarioTexts.fields.action), ' Первая правка.');
    await expect(unsavedChip(screen)).toBeInTheDocument();
    await expect(screen.getByText(scenarioTexts.workflow.treatmentApproved, { exact: true })).toBeInTheDocument();
    await userEvent.click(saveButton(screen));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1 (production).'));
    await expect(screen.getByTestId('page-model-logline')).toHaveTextContent('Черновик логлайна.');
    await expect(screen.getByTestId('page-model-shot-M01')).toHaveTextContent('Первая правка.');
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
    // Утверждение пары включает части сценария: после их записи пару нужно утвердить заново.
    await screen.findByText(scenarioTexts.workflow.treatmentUnapproved, { exact: true }, { timeout: 3000 });
    await expect(screen.getByText(scenarioTexts.workflow.scenesNeedReview(['treatment'], 'pair'))).toBeInTheDocument();
  }
};

export const PartDirectionKeepAccepted: Story = {
  name: 'Правка части · по каждому принятому плану «Переснять» или «Оставить принятым»',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ variant: 'produced' }) },
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.click(partsBlock(screen));
    // Направление первой части задевает оба её плана; принятые M01 и M02 получают выбор, по умолчанию — переснять.
    const direction = screen.getAllByRole('textbox', { name: scenarioTexts.treatment.direction })[0];
    await userEvent.type(direction, ' Дождь стихает.');
    await userEvent.click(saveButton(screen));
    const dialog = within(await screen.findByRole('dialog', { name: scenarioTexts.save.productionTitle }));
    await expect(dialog.getByText(scenarioTexts.save.choiceHint)).toBeInTheDocument();
    const group = (shot: string) => within(dialog.getByRole('radiogroup', { name: shot }));
    await expect(group('M01').getByRole('radio', { name: scenarioTexts.check.dialog.reshoot })).toBeChecked();
    await expect(group('M02').getByRole('radio', { name: scenarioTexts.check.dialog.reshoot })).toBeChecked();
    await userEvent.click(group('M02').getByRole('radio', { name: scenarioTexts.check.dialog.keep }));
    await expect(dialog.getByText(scenarioTexts.save.keepHint)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1 (production). Оставлены принятыми: M02.'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
  }
};

export const SaveProducedShots: Story = {
  name: 'Сохранение сценария · принятые планы требуют подтверждения',
  tags: CANVAS_ONLY,
  parameters: { songframe: scenarioPageOptions({ variant: 'produced' }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M01');
    await userEvent.type(field(screen, scenarioTexts.fields.action), ' Правка принятого плана.');
    await userEvent.click(saveButton(screen));
    const production = within(await screen.findByRole('dialog', { name: scenarioTexts.save.productionTitle }));
    await expect(production.getByText('M01')).toBeInTheDocument();
    await userEvent.click(production.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 0.');
    await expect(unsavedChip(screen)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.toolbar.saveWithoutProduction }));
    const keep = within(await screen.findByRole('dialog', { name: scenarioTexts.save.keepTitle }));
    await userEvent.click(keep.getByRole('button', { name: scenarioTexts.toolbar.saveWithoutProduction }));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1 (keep).'));
    await expect(screen.getByTestId('page-model-shot-M01')).toHaveTextContent('Правка принятого плана.');

    // У плана без материалов «без производства» бессмысленно: причина видна в подсказке, обычное сохранение идёт без диалога.
    await selectByKeyboard(context, 'M03');
    await userEvent.type(field(screen, scenarioTexts.fields.action), ' Правка нового плана.');
    await waitFor(
      () => {
        const button = screen.getByRole('button', { name: scenarioTexts.toolbar.saveWithoutProduction });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute('title', expect.stringContaining(scenarioTexts.save.keepNothingReason));
      },
      { timeout: 3000 }
    );
    await userEvent.click(saveButton(screen));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 2 (keep, production).'));
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(screen.getByTestId('page-model-shot-M03')).toHaveTextContent('Правка нового плана.');
  }
};

export const ShotStatusInList: Story = {
  name: 'Список планов · статус производства бейджем, как на «Производстве»: попытка устарела и проблема различаются',
  tags: ['ci'],
  parameters: { songframe: scenarioPageOptions({ variant: 'produced' }) },
  play: async (context) => {
    await ready(context);
    const status = async (shot: string) => within(row(context, shot)).findByTestId('shot-status');
    await expect(await status('M01')).toHaveTextContent(componentsTexts.shot.states.completed);
    await expect(await status('M02')).toHaveTextContent(componentsTexts.shot.states.completed);
    // Устаревшая после правки постановки попытка и повреждённый пакет — разные метки.
    await expect(await status('M03')).toHaveTextContent(componentsTexts.shot.states.outdated);
    await expect(await status('M04')).toHaveTextContent(componentsTexts.shot.states.unknown);
  }
};

export const RecalculateBounds: Story = {
  name: 'Пересчёт границ · постановка прежняя · принятые планы в списке сохранения',
  tags: ['ci'],
  parameters: { songframe: scenarioPageOptions({ variant: 'produced' }) },
  play: async (context) => {
    const screen = await ready(context);
    const action = screen.getByTestId('page-model-shot-M01').textContent ?? '';
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.toolbar.recalculateBounds }));
    await screen.findByText(scenarioTexts.notice.boundsRecalculated({ count: 2 }));
    await expect(screen.getByTestId('page-model-scaffold')).toHaveTextContent('Пересчётов границ: 1 (--json).');
    // Черновик не записан: постановка в модели прежняя, правку нужно сохранить.
    await expect(unsavedChip(screen)).toBeInTheDocument();
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 0.');
    await expect(field(screen, scenarioTexts.fields.action).value).not.toContain('ЗАПОЛНИТЬ');
    await userEvent.click(saveButton(screen));
    const production = within(await screen.findByRole('dialog', { name: scenarioTexts.save.productionTitle }));
    await expect(production.getByText('M01')).toBeInTheDocument();
    await expect(production.getByText('M02')).toBeInTheDocument();
    await userEvent.click(production.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1 (production).'));
    await expect(screen.getByTestId('page-model-shot-M01')).toHaveTextContent(action);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Повторный пересчёт ничего не меняет.
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.toolbar.recalculateBounds }));
    await screen.findByText(scenarioTexts.notice.boundsUnchanged);
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
  }
};

export const RecalculateBoundsLeadPause: Story = {
  name: 'Пересчёт границ · отказ называет паузу перед строкой и совет для частей',
  tags: ['ci'],
  parameters: { songframe: scenarioPageOptions({ leadPause: true }) },
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.toolbar.recalculateBounds }));
    const notice = scenarioTexts.notice;
    await screen.findByText(
      notice.boundsCountChanged({
        part: 'Куплет у калитки',
        was: 2,
        now: 3,
        cause: notice.boundsCause.leadPause({ seconds: '2.6', line: 3 }),
        fix: notice.boundsFix.moveStart({ at: '10.6' })
      })
    );
    // Отказ ничего не меняет: черновик сценария прежний, сохранять нечего.
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
    await expect(screen.getByTestId('page-model-scaffold')).toHaveTextContent('Пересчётов границ: 1 (--json).');
  }
};

export const RecalculateBoundsLineMoved: Story = {
  name: 'Пересчёт границ · строка ушла в соседнюю часть · отказ при том же числе планов',
  tags: ['ci'],
  parameters: { songframe: scenarioPageOptions({ lineMoved: true }) },
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.toolbar.recalculateBounds }));
    const notice = scenarioTexts.notice;
    await screen.findByText(
      notice.boundsLineMoved({
        line: 3,
        text: 'Скрипит знакомая калитка',
        start: '7',
        end: '8.8',
        to: 'Возвращение',
        from: 'Куплет у калитки',
        fix: notice.boundsFix.movePartStart({ part: 'Куплет у калитки', at: '7' })
      })
    );
    // Сценарий не тронут: строка осталась в своём плане, сохранять нечего.
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 0.');
  }
};

export const WorkflowWithManualEditing: Story = {
  name: 'Процесс с агентом · панель рядом с ручной правкой и сохранением',
  tags: ['!autodocs', 'ci'],
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M01');
    // Сценарный проход агента ведёт рабочая панель страницы.
    await expect(screen.getByText(scenarioTexts.workflow.title)).toBeVisible();
    await expect(await screen.findByRole('button', { name: scenarioTexts.workflow.createScenes })).toBeVisible();
    await userEvent.type(field(screen, scenarioTexts.fields.action), ' Ручная правка.');
    await userEvent.click(saveButton(screen));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1 (production).'));
    await expect(screen.getByTestId('page-model-shot-M01')).toHaveTextContent('Ручная правка.');
  }
};

export const RegistryProblems: Story = {
  name: 'Проблемы планов · сохранение заблокировано до исправления',
  tags: CANVAS_ONLY,
  play: async (context) => {
    const screen = await ready(context);
    const action = field(screen, scenarioTexts.fields.action);
    await userEvent.clear(action);
    const chip = await screen.findByRole('button', { name: scenarioTexts.toolbar.problems({ count: 1 }) }, { timeout: 3000 });
    await expect(saveButton(screen)).toBeDisabled();
    await expect(saveButton(screen)).toHaveAttribute('title', expect.stringContaining(scenarioTexts.toolbar.fixRegistry({ count: 1 })));
    await userEvent.click(chip);
    await expectRevealed(context, screen.getByText(scenarioPageActionProblem('M01')));
    await userEvent.type(field(screen, scenarioTexts.fields.action), 'Герой ждёт у ворот.');
    await waitFor(() => expect(screen.queryByRole('button', { name: scenarioTexts.toolbar.problems({ count: 1 }) })).not.toBeInTheDocument(), {
      timeout: 3000
    });
    await expect(saveButton(screen)).toBeEnabled();
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 0.');
  }
};

export const ReferencesStale: Story = {
  name: 'Карта референсов устарела · сохранение без правок обновляет её',
  tags: CANVAS_ONLY,
  parameters: { songframe: scenarioPageOptions({ referencesStale: true }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M01');
    // Кастинг получил референс после записи сценария: правок нет, но сохранение доступно — только оно обновит карту.
    await expect(screen.getByText(scenarioTexts.main.referencesRefresh)).toBeVisible();
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
    await expect(saveButton(screen)).toBeEnabled();
    await userEvent.click(saveButton(screen));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1 (production).'));
    await waitFor(() => expect(screen.queryByText(scenarioTexts.main.referencesRefresh)).not.toBeInTheDocument());
    await expect(saveButton(screen)).toBeDisabled();
    await expect(saveButton(screen)).toHaveAttribute('title', expect.stringContaining(scenarioTexts.toolbar.noChanges));
  }
};

/** «Создать сценарий» спрашивает подтверждение; согласие запускает агента. */
async function confirmScenes(screen: ReturnType<typeof within>, button: HTMLElement): Promise<void> {
  await userEvent.click(button);
  const confirmation = within(await screen.findByRole('dialog', { name: scenarioTexts.workflow.confirmTitle.scenes }));
  await userEvent.click(confirmation.getByRole('button', { name: scenarioTexts.workflow.createScenes }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: scenarioTexts.workflow.confirmTitle.scenes })).not.toBeInTheDocument());
}

export const AgentWithDrafts: Story = {
  name: 'Запуск агента с несохранёнными правками · решение и пауза редактирования',
  tags: ['!autodocs', 'ci'],
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.type(field(screen, scenarioTexts.fields.action), ' Правка до агента.');
    await confirmScenes(screen, await screen.findByRole('button', { name: scenarioTexts.workflow.createScenes }));
    const conflict = within(await screen.findByRole('dialog', { name: commonTexts.unsavedChanges }));
    await expect(conflict.getByText(scenarioTexts.drafts.changed)).toBeInTheDocument();
    await userEvent.click(conflict.getByRole('button', { name: scenarioTexts.drafts.returnToEditor }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('page-model-agent')).toHaveTextContent('Запусков агента: 0.');
    await expect(field(screen, scenarioTexts.fields.action).value).toContain('Правка до агента.');

    await confirmScenes(screen, screen.getByRole('button', { name: scenarioTexts.workflow.createScenes }));
    const again = within(await screen.findByRole('dialog', { name: commonTexts.unsavedChanges }));
    await userEvent.click(again.getByRole('button', { name: scenarioTexts.drafts.saveAndContinue }));
    await waitFor(() => expect(screen.getByTestId('page-model-agent')).toHaveTextContent('Запусков агента: 1.'));
    // Пока диалог закрывается, остальная страница скрыта от вспомогательных технологий.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('page-model-shot-M01')).toHaveTextContent('Правка до агента.');
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1 (production).');
    await screen.findByText(scenarioTexts.page.agentEditingPaused);
    await expect(field(screen, scenarioTexts.fields.action).closest('[inert]')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: commonTexts.stop }));
    await waitFor(() => expect(screen.queryByText(scenarioTexts.page.agentEditingPaused)).not.toBeInTheDocument(), { timeout: 3000 });
    await expect(screen.getByTestId('page-model-agent')).toHaveTextContent('Остановок: 1.');
    await expect(field(screen, scenarioTexts.fields.action).closest('[inert]')).toBeNull();
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
  }
};

/** Открывает сравнение готового предложения и подтверждает применение сценария. */
async function applyScenes(context: Context): Promise<void> {
  const screen = screenOf(context);
  await userEvent.click(await screen.findByRole('button', { name: scenarioTexts.workflow.reviewProposal }));
  const proposal = within(await screen.findByRole('dialog', { name: /Предложение для сценария/ }));
  // Перевод фокуса MUI должен закончиться до вложенного подтверждения.
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  await userEvent.click(proposal.getByRole('button', { name: scenarioTexts.proposal.applyScenes }));
  const confirm = within(await screen.findByRole('dialog', { name: `${scenarioTexts.proposal.applyScenes}?` }));
  await userEvent.click(confirm.getByRole('button', { name: commonTexts.apply }));
}

export const ApplyScenesProposal: Story = {
  name: 'Применение прохода сценария · правки отменяются, записываются только планы',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ variant: 'proposal' }) },
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.click(partsBlock(screen));
    const logline = field(screen, scenarioTexts.fields.logline);
    await userEvent.clear(logline);
    await userEvent.type(logline, 'Правка логлайна до применения.');
    await applyScenes(context);
    // Запись правок сделала бы предложение устаревшим: остаются только отмена правок или возврат к редактору.
    const dialog = await screen.findByRole('dialog', { name: commonTexts.unsavedChanges });
    const conflict = within(dialog);
    const save = conflict.getByRole('button', { name: scenarioTexts.drafts.saveAndContinue });
    await expect(save).toBeDisabled();
    await expect(save).toHaveAttribute('title', expect.stringContaining(scenarioTexts.drafts.applyNeedsSaved));
    await expect(conflict.getByText(scenarioTexts.drafts.applyNeedsSaved)).toBeInTheDocument();
    await expect(screen.getByTestId('page-model-agent')).toHaveTextContent('Применений: 0.');
    await userEvent.click(conflict.getByRole('button', { name: scenarioTexts.drafts.discardAndContinue }));
    await waitFor(() => expect(screen.getByTestId('page-model-agent')).toHaveTextContent('Применений: 1.'), { timeout: 3000 });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('page-model-shot-M01')).toHaveTextContent(PROPOSAL_ACTION);
    await expect(screen.getByTestId('page-model-logline')).toHaveTextContent('Герой возвращается к старым воротам.');
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 0.');
    await expect(field(screen, scenarioTexts.fields.logline)).toHaveValue('Герой возвращается к старым воротам.');
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
    await waitFor(() => expect(field(screen, scenarioTexts.fields.action)).toHaveValue(PROPOSAL_ACTION));
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
  }
};

export const ProposalStaleAfterSave: Story = {
  name: 'Сохранение сценария до применения · предложение устарело, применить нельзя',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ variant: 'proposal' }) },
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.type(field(screen, scenarioTexts.fields.action), ' Правка до применения.');
    await userEvent.click(saveButton(screen));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1 (production).'));
    // Опрос панели приносит признак устаревшего предложения из сверки хешей документов.
    await screen.findByText(scenarioTexts.workflow.proposalStale, undefined, { timeout: 3000 });
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.reviewProposal }));
    const proposal = within(await screen.findByRole('dialog', { name: /Предложение для сценария/ }));
    await expect(proposal.getByText(scenarioTexts.proposal.sourcesChanged)).toBeInTheDocument();
    const apply = proposal.getByRole('button', { name: scenarioTexts.proposal.applyScenes });
    await expect(apply).toBeDisabled();
    await expect(apply).toHaveAttribute('title', expect.stringContaining(scenarioTexts.proposal.staleReason));
    await userEvent.click(proposal.getByRole('button', { name: scenarioTexts.proposal.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('page-model-agent')).toHaveTextContent('Применений: 0.');
    await expect(screen.getByTestId('page-model-shot-M01')).toHaveTextContent('Правка до применения.');
    await expect(screen.getByTestId('page-model-shot-M01')).not.toHaveTextContent(PROPOSAL_ACTION);
    await expect(screen.getByRole('button', { name: scenarioTexts.workflow.newProposal })).toBeEnabled();
  }
};

const checkPanel = async (screen: Screen) => {
  const heading = await screen.findByRole('heading', { name: scenarioTexts.check.title }, { timeout: 3000 });
  return within(heading.closest('.MuiPaper-root') as HTMLElement);
};

/** Заголовок блока проверки: Accordion, как «Общие правила и части», раскрывается щелчком по заголовку. */
const checkSummary = (panel: Screen) => panel.getByRole('button', { name: new RegExp(`^${scenarioTexts.check.title}`) });

/** Раскрывает свёрнутый по умолчанию блок проверки щелчком по его заголовку. */
const expandCheck = async (panel: Screen) => {
  await expect(checkSummary(panel)).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(checkSummary(panel));
  await expect(checkSummary(panel)).toHaveAttribute('aria-expanded', 'true');
};

export const CheckReport: Story = {
  name: 'Проверка сценария · отчёт: важные проблемы первыми, переход к блоку состояния плана',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ check: 'report' }) },
  play: async (context) => {
    const screen = await ready(context);
    const panel = await checkPanel(screen);
    await expect(panel.getByText(scenarioTexts.check.statusIssues({ count: 3 }))).toBeInTheDocument();
    // Готовый отчёт по умолчанию свёрнут до заголовка со статусом и раскрывается по заголовку.
    await expect(panel.queryByText('Герой в сухой куртке под дождём')).not.toBeInTheDocument();
    await expandCheck(panel);
    // Важность задаёт порядок: проблема состояния записана в отчёте последней, а показана первой.
    const summaries = panel.getAllByRole('button', { expanded: false });
    await expect(summaries[0]).toHaveTextContent('Герой в сухой куртке под дождём');
    await expect(summaries[2]).toHaveTextContent('Камера меняет сторону');
    await userEvent.click(summaries[0]);
    await expect(await panel.findByText(scenarioTexts.check.fix)).toBeVisible();
    await expect(panel.getByText(scenarioTexts.check.entities({ names: 'Герой у ворот' }))).toBeInTheDocument();
    await userEvent.click(panel.getByRole('button', { name: scenarioTexts.check.openShot({ shot: 'M02' }) }));
    await editorHeading(screen, 'M02');
    await expect(row(context, 'M02')).toHaveAttribute('aria-current', 'true');
    // У героя в первом кадре M02 нет своих изменений: переход прокручивает к блоку состояния плана.
    await expectRevealed(context, await screen.findByRole('heading', { name: scenarioTexts.state.title }, { timeout: 3000 }));
    // Проблема сюжета ведёт к постановке плана, а не к блоку состояния.
    await userEvent.click(panel.getByRole('button', { name: /Сосед появляется раньше куплета/ }));
    await userEvent.click(await panel.findByRole('button', { name: scenarioTexts.check.openShot({ shot: 'M04' }) }));
    await editorHeading(screen, 'M04');
    await expect(row(context, 'M04')).toHaveAttribute('aria-current', 'true');
  }
};

export const CheckRunAndStale: Story = {
  name: 'Проверка сценария · запуск, готовый отчёт и устаревание после сохранения сценария',
  tags: ['!autodocs', 'ci'],
  play: async (context) => {
    const screen = await ready(context);
    const panel = await checkPanel(screen);
    await expect(panel.getByText(scenarioTexts.check.statusNone)).toBeInTheDocument();
    await userEvent.click(panel.getByRole('button', { name: scenarioTexts.check.start }));
    // Пока агент проверяет, правка сценария закрыта, а повторный запуск недоступен.
    await panel.findByText(scenarioTexts.check.statusRunning, undefined, { timeout: 3000 });
    await screen.findByText(scenarioTexts.page.agentEditingPaused, undefined, { timeout: 3000 });
    await panel.findByText(scenarioTexts.check.statusIssues({ count: 3 }), undefined, { timeout: 4000 });
    await expect(await screen.findByText(scenarioTexts.check.finished({ count: 3 }))).toBeInTheDocument();
    // Завершившаяся проверка сама раскрывает отчёт.
    await waitFor(() => expect(checkSummary(panel)).toHaveAttribute('aria-expanded', 'true'));
    await expect(panel.getByText('Герой в сухой куртке под дождём')).toBeInTheDocument();
    await expect(screen.getByTestId('page-model-agent')).toHaveTextContent('Проверок сценария: 1.');
    await waitFor(() => expect(screen.queryByText(scenarioTexts.page.agentEditingPaused)).not.toBeInTheDocument());
    await userEvent.type(field(screen, scenarioTexts.fields.action), ' Правка после проверки.');
    await userEvent.click(saveButton(screen));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1 (production).'));
    await panel.findByText(scenarioTexts.check.statusStale, undefined, { timeout: 3000 });
    await expect(panel.getByText(scenarioTexts.check.stale)).toBeInTheDocument();
    await expect(panel.getByRole('button', { name: scenarioTexts.check.restart })).toBeEnabled();
  }
};

export const CheckFix: Story = {
  name: 'Проверка сценария · исправить: правка состояния, M02 переснять, M03 оставить принятым',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ check: 'report', accepted: ['M02', 'M03'] }) },
  play: async (context) => {
    const screen = await ready(context);
    const panel = await checkPanel(screen);
    await expandCheck(panel);
    // Отметить можно только проблему с правками, а без отметки «Исправить выбранные» недоступна.
    await expect(panel.getByRole('button', { name: scenarioTexts.check.fixSelected({ count: 0 }) })).toBeDisabled();
    await userEvent.click(panel.getByRole('checkbox', { name: scenarioTexts.check.select({ title: 'Герой в сухой куртке под дождём' }) }));
    await expect(panel.queryAllByRole('checkbox')).toHaveLength(1);
    await userEvent.click(panel.getByRole('button', { name: scenarioTexts.check.fixSelected({ count: 1 }) }));
    const dialog = within(await screen.findByRole('dialog', { name: scenarioTexts.check.dialog.title }));
    const table = within(await dialog.findByRole('table', { name: scenarioTexts.check.dialog.changes }));
    await expect(table.getByText('сухая')).toBeInTheDocument();
    await expect(table.getByText('мокрая, тёмная от дождя')).toBeInTheDocument();
    await expect(table.getByText(scenarioTexts.check.dialog.phases.before)).toBeInTheDocument();
    await expect(dialog.getByText(`M02 · ${scenarioTexts.check.dialog.direct}`)).toBeInTheDocument();
    await expect(dialog.getByText(`M03 · ${scenarioTexts.check.dialog.inherited}`)).toBeInTheDocument();
    // По умолчанию задетые принятые планы переснимаются; M03 пользователь оставляет принятым.
    const m03 = within(dialog.getByRole('radiogroup', { name: `M03 · ${scenarioTexts.check.dialog.inherited}` }));
    await expect(m03.getByRole('radio', { name: scenarioTexts.check.dialog.reshoot })).toBeChecked();
    await userEvent.click(m03.getByRole('radio', { name: scenarioTexts.check.dialog.keep }));
    await expect(dialog.getByText(scenarioTexts.check.dialog.keepHint)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.check.dialog.apply }));
    await waitFor(() => expect(screen.getByTestId('page-model-agent')).toHaveTextContent('Правок проверки: 2 (оставлены: M03).'));
    await expect(await screen.findByText(scenarioTexts.check.applied({ count: 1 }))).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: scenarioTexts.check.dialog.title })).not.toBeInTheDocument());
    // Исправленная проблема остаётся в отчёте с отметкой, отчёт не устаревает, а число нерешённых уменьшается.
    await expect(await panel.findByText(scenarioTexts.check.fixed)).toBeInTheDocument();
    await expect(panel.getByText(scenarioTexts.check.statusIssues({ count: 2 }))).toBeInTheDocument();
    await expect(panel.queryByText(scenarioTexts.check.stale)).not.toBeInTheDocument();
    await expect(panel.queryByRole('button', { name: /Исправить выбранные/ })).not.toBeInTheDocument();
  }
};

export const CheckRevise: Story = {
  name: 'Проверка сценария · плашка проблем у плана, переход к отчёту и доработка с агентом',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ check: 'report', route: '/project/scenario?shot=M04' }) },
  play: async (context) => {
    const screen = await ready(context);
    const panel = await checkPanel(screen);
    await editorHeading(screen, 'M04');
    const notice = (await screen.findByText(scenarioTexts.check.shotNotice({ shot: 'M04' }))).closest('[role="alert"]') as HTMLElement;
    await expect(within(notice).getByText(/Сосед появляется раньше куплета/)).toBeInTheDocument();
    await userEvent.click(within(notice).getByRole('button', { name: scenarioTexts.check.toReport }));
    // Переход раскрывает проблему в отчёте: у проблемы сюжета нет правок, вместо «Исправить» — доработка агентом.
    const revise = await panel.findByRole('button', { name: scenarioTexts.check.revise });
    await expect(panel.queryByRole('button', { name: scenarioTexts.check.fixButton })).not.toBeInTheDocument();
    await userEvent.click(revise);
    const dialog = within(await screen.findByRole('dialog', { name: scenarioTexts.revise.dialogTitle }));
    await expect(dialog.getByText(scenarioTexts.revise.context({ ids: ['M04'] }))).toBeInTheDocument();
    const note = dialog.getByRole('textbox', { name: scenarioTexts.revise.note }) as HTMLTextAreaElement;
    await expect(note.value).toContain('Сосед появляется раньше куплета');
    await expect(note.value).toContain('Что сделать: Перенесите разговор');
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.revise.prepare }));
    await waitFor(() => expect(screen.getByTestId('page-model-agent')).toHaveTextContent('Запусков агента: 1.'));
    // Применённая доработка, запущенная из проблемы, отмечает её исправленной: плашка у плана исчезает.
    await applyScenes(context);
    await waitFor(() => expect(screen.getByTestId('page-model-agent')).toHaveTextContent('Применений: 1.'));
    await expect(await panel.findByText(scenarioTexts.check.fixed)).toBeInTheDocument();
    await expect(panel.getByText(scenarioTexts.check.statusIssues({ count: 2 }))).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(scenarioTexts.check.shotNotice({ shot: 'M04' }))).not.toBeInTheDocument());
  }
};

export const CheckResolve: Story = {
  name: 'Проверка сценария · «Решено вручную» закрывает проблему, «Вернуть в работу» открывает снова',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ check: 'report' }) },
  play: async (context) => {
    const screen = await ready(context);
    const panel = await checkPanel(screen);
    await expandCheck(panel);
    await userEvent.click(panel.getByRole('button', { name: /Сосед появляется раньше куплета/ }));
    await userEvent.click(await panel.findByRole('button', { name: scenarioTexts.check.resolve }));
    // Отметка видна в заголовке проблемы и уменьшает число нерешённых, сценарий не записывается.
    await expect(await panel.findByText(scenarioTexts.check.resolvedHint)).toBeInTheDocument();
    await expect(panel.getByText(scenarioTexts.check.statusIssues({ count: 2 }))).toBeInTheDocument();
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 0');
    await userEvent.click(panel.getByRole('button', { name: scenarioTexts.check.unresolve }));
    await expect(await panel.findByText(scenarioTexts.check.statusIssues({ count: 3 }))).toBeInTheDocument();
    await expect(panel.queryByText(scenarioTexts.check.resolvedHint)).not.toBeInTheDocument();
    // Щелчок по заголовку сворачивает блок до заголовка со статусом.
    await userEvent.click(checkSummary(panel));
    await waitFor(() => expect(panel.queryByText(/Сосед появляется раньше куплета/)).not.toBeInTheDocument());
    await expect(checkSummary(panel)).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.getByText(scenarioTexts.check.statusIssues({ count: 3 }))).toBeInTheDocument();
  }
};

export const CheckReviewed: Story = {
  name: 'Проверка сценария · «Все проблемы разобраны» сворачивает устаревший отчёт, «Вернуть в работу» раскрывает',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ check: 'staleReport' }) },
  play: async (context) => {
    const screen = await ready(context);
    const panel = await checkPanel(screen);
    await expect(panel.getByText(scenarioTexts.check.statusStale)).toBeInTheDocument();
    await expandCheck(panel);
    await expect(panel.getByText(scenarioTexts.check.stale)).toBeInTheDocument();
    // Отказ от подтверждения ничего не отмечает.
    await userEvent.click(panel.getByRole('button', { name: scenarioTexts.check.resolveAll }));
    let dialog = within(await screen.findByRole('dialog', { name: scenarioTexts.check.resolveAllTitle }));
    await expect(dialog.getByText(scenarioTexts.check.resolveAllDescription({ count: 3 }))).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(panel.getByText(scenarioTexts.check.statusStale)).toBeInTheDocument();
    // Согласие отмечает все проблемы и сворачивает отчёт с предупреждением до строки с датой проверки.
    await userEvent.click(panel.getByRole('button', { name: scenarioTexts.check.resolveAll }));
    dialog = within(await screen.findByRole('dialog', { name: scenarioTexts.check.resolveAllTitle }));
    await userEvent.click(dialog.getByRole('button', { name: scenarioTexts.check.resolveAllConfirm }));
    // Пока окно подтверждения закрывается, страница под ним скрыта от вспомогательных технологий.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(await panel.findByText(scenarioTexts.check.statusReviewed)).toBeInTheDocument();
    await expect(panel.getByText(scenarioTexts.check.reviewed({ date: formatDateTime('2026-10-30T09:01:00.000Z') }))).toBeVisible();
    await expect(panel.queryByText(scenarioTexts.check.stale)).not.toBeInTheDocument();
    await expect(panel.queryByText(/Сосед появляется раньше куплета/)).not.toBeInTheDocument();
    await expect(panel.queryByText(scenarioTexts.check.openCount({ count: 3 }))).not.toBeInTheDocument();
    await expect(panel.queryByRole('button', { name: scenarioTexts.check.resolveAll })).not.toBeInTheDocument();
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 0');
    // Отчёт раскрывается по запросу; снятая отметка возвращает обычный вид устаревшего отчёта.
    await userEvent.click(panel.getByRole('button', { name: scenarioTexts.check.showReport }));
    await userEvent.click(await panel.findByRole('button', { name: /Сосед появляется раньше куплета/ }));
    await userEvent.click(await panel.findByRole('button', { name: scenarioTexts.check.unresolve }));
    await expect(await panel.findByText(scenarioTexts.check.statusStale)).toBeInTheDocument();
    await expect(panel.getByText(scenarioTexts.check.stale)).toBeInTheDocument();
    await expect(panel.getByText(scenarioTexts.check.openCount({ count: 1 }))).toBeInTheDocument();
    await expect(panel.getByRole('button', { name: scenarioTexts.check.resolveAll })).toBeEnabled();
  }
};

export const CheckClean: Story = {
  name: 'Проверка сценария · проблем не найдено',
  parameters: { songframe: scenarioPageOptions({ check: 'clean' }) },
  play: async (context) => {
    const panel = await checkPanel(await ready(context));
    await expect(panel.getByText(scenarioTexts.check.statusClean)).toBeInTheDocument();
    await expandCheck(panel);
    await expect(panel.getByText(scenarioTexts.check.clean)).toBeInTheDocument();
  }
};

export const Loading: Story = {
  name: 'Загрузка · общий индикатор до ответа',
  parameters: { songframe: scenarioPageOptions({ variant: 'loading' }) },
  play: async (context) => {
    const screen = screenOf(context);
    await screen.findByRole('progressbar', { name: commonTexts.pageLoading });
    await expect(screen.queryByRole('heading', { name: navigationTexts.pages.scenario })).not.toBeInTheDocument();
    await ready(context);
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: commonTexts.pageLoading })).not.toBeInTheDocument());
    await expect(screen.getByTestId('page-model-reads')).toHaveTextContent('Чтений сценария: 1.');
  }
};

export const LoadError: Story = {
  name: 'Ошибка чтения · «Повторить» восстанавливает страницу',
  parameters: { songframe: scenarioPageOptions({ variant: 'loadError' }) },
  play: async (context) => {
    const screen = screenOf(context);
    const alert = await screen.findByRole('alert');
    await expect(alert).toHaveTextContent(SCENARIO_PAGE_READ_ERROR);
    await expect(screen.queryByRole('heading', { name: navigationTexts.pages.scenario })).not.toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: commonTexts.retry }));
    await ready(context);
    await editorHeading(screen, 'M01');
    await expect(screen.queryByText(SCENARIO_PAGE_READ_ERROR)).not.toBeInTheDocument();
    await expect(screen.getByTestId('page-model-reads')).toHaveTextContent('Чтений сценария: 2.');
  }
};

export const LongRegistry: Story = {
  name: 'Длинный сценарий · закреплённые панель и список, поиск и клавиатура',
  tags: CANVAS_ONLY,
  parameters: { songframe: scenarioPageOptions({ variant: 'long', route: '/project/scenario?shot=M37', links: ['M02', 'M38'] }) },
  play: async (context) => {
    const doc = documentOf(context);
    const screen = await ready(context);
    await expectRevealed(context, await editorHeading(screen, 'M37'));
    // Строка выбранного плана видна внутри собственной прокрутки списка.
    const list = row(context, 'M37').parentElement!;
    await waitFor(() => {
      const item = row(context, 'M37').getBoundingClientRect();
      const box = list.getBoundingClientRect();
      expect(item.top).toBeGreaterThanOrEqual(box.top - 1);
      expect(item.bottom).toBeLessThanOrEqual(box.bottom + 1);
    });

    const search = screen.getByRole('searchbox', { name: scenarioTexts.list.search });
    await userEvent.type(search, 'M38');
    await screen.findByText(scenarioTexts.list.foundShots({ shown: 1, total: 40 }));
    await selectByKeyboard(context, 'M38');
    await userEvent.clear(search);
    await screen.findByText(scenarioTexts.list.shots({ count: 40 }));

    // После прокрутки окна панель действий стоит под шапкой, а в две колонки и список закреплён под ней.
    const sticky = search.closest('.MuiPaper-root')!.parentElement!;
    const grid = sticky.parentElement!;
    window.scrollTo({ top: grid.getBoundingClientRect().top + window.scrollY + 300, behavior: 'instant' });
    const header = doc.querySelector('header')!;
    const bar = doc.querySelector('[data-page-action-bar="top"]')!;
    // Планы делятся на две колонки с брейкпоинта lg (1200 px окна): шире список закреплён под панелью, уже — уходит вверх вместе со страницей.
    const wide = window.innerWidth >= 1200;
    await waitFor(() => {
      const barBottom = bar.getBoundingClientRect().bottom;
      expect(Math.abs(bar.getBoundingClientRect().top - header.getBoundingClientRect().bottom)).toBeLessThanOrEqual(1);
      if (wide) {
        expect(getComputedStyle(sticky).position).toBe('sticky');
        expect(Math.abs(sticky.getBoundingClientRect().top - (barBottom + 16))).toBeLessThanOrEqual(2);
      } else {
        expect(getComputedStyle(sticky).position).toBe('static');
        expect(getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/)).toHaveLength(1);
        expect(sticky.getBoundingClientRect().bottom).toBeLessThan(barBottom);
      }
    });
    await expect(saveButton(screen)).toBeVisible();
    await expect(doc.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  }
};

export const NoShots: Story = {
  name: 'Сценарий из одних частей · блок частей раскрыт, планы создаст агент',
  tags: CANVAS_ONLY,
  parameters: { songframe: scenarioPageOptions({ variant: 'noShots' }) },
  play: async (context) => {
    const screen = await ready(context);
    await expect(partsBlock(screen)).toHaveAttribute('aria-expanded', 'true');
    await expect(screen.getByText(scenarioTexts.page.noShots)).toBeVisible();
    // Без планов пересчитывать нечего, а «без производства» не имеет смысла.
    await expect(screen.queryByRole('button', { name: scenarioTexts.toolbar.recalculateBounds })).not.toBeInTheDocument();
    await expect(screen.queryByRole('button', { name: scenarioTexts.toolbar.saveWithoutProduction })).not.toBeInTheDocument();
    // Пока части не утверждены вместе с кастингом, второй проход закрыт.
    await expect(await screen.findByRole('button', { name: scenarioTexts.workflow.createScenes })).toBeDisabled();
    await expect(screen.getAllByRole('textbox', { name: scenarioTexts.fields.code })[0]).not.toHaveAttribute('readonly');
    await userEvent.type(field(screen, scenarioTexts.fields.logline), ' Черновик.');
    await userEvent.click(saveButton(screen));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1 (production).'));
    await expect(screen.getByTestId('page-model-shots')).toHaveTextContent('Сохранённых планов: 0.');
    await expect(screen.getByTestId('page-model-logline')).toHaveTextContent('Черновик.');
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
  }
};

export const TreatmentDraftWithProblems: Story = {
  name: 'Черновик частей · общая граница частей · сохраняется с проблемами',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ variant: 'noShots' }) },
  play: async (context) => {
    const screen = await ready(context);
    await expect(screen.queryByText(scenarioTexts.treatment.problemsTitle)).not.toBeInTheDocument();
    // Общая граница соседних частей правится одним полем: конец первой части сдвигает начало второй, стык не рвётся.
    const values = (name: string) => screen.getAllByRole('spinbutton', { name }).map((input: HTMLElement) => (input as HTMLInputElement).value);
    const firstEnd = screen.getAllByRole('spinbutton', { name: scenarioTexts.fields.endSeconds })[0];
    await userEvent.clear(firstEnd);
    await userEvent.type(firstEnd, '7.5');
    await expect(values(scenarioTexts.fields.startSeconds)).toEqual(['0', '7.5', '16']);
    const secondStart = screen.getAllByRole('spinbutton', { name: scenarioTexts.fields.startSeconds })[1];
    await userEvent.clear(secondStart);
    await userEvent.type(secondStart, '8');
    await expect(values(scenarioTexts.fields.endSeconds)).toEqual(['8', '16', '24']);
    // Конец последней части раньше конца трека: соседа нет, черновик получает проблему.
    const end = screen.getAllByRole('spinbutton', { name: scenarioTexts.fields.endSeconds })[2];
    await userEvent.clear(end);
    await userEvent.type(end, '23');
    const title = await screen.findByText(scenarioTexts.treatment.problemsTitle, {}, { timeout: 3000 });
    const alert = (title as HTMLElement).closest('[role="alert"]') as HTMLElement;
    await expect(within(alert).getByText(scenarioTexts.treatment.problemsHint)).toBeVisible();
    await waitFor(() =>
      expect(
        within(alert)
          .getAllByRole('listitem')
          .map((item) => item.textContent)
      ).toEqual([scenarioTexts.main.treatmentDurationMismatch({ end: '23.00', duration: '24.00' })])
    );
    await expect(saveButton(screen)).toBeEnabled();
    await userEvent.click(saveButton(screen));
    // Сохранение черновика — не ошибка: уведомление объясняет, а список остаётся над частями.
    await screen.findByText(scenarioTexts.notice.treatmentSavedDraft, {}, { timeout: 3000 });
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 1 (production).');
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
    await expect(screen.getByText(scenarioTexts.treatment.problemsTitle)).toBeVisible();
    await expect(screen.getByRole('button', { name: scenarioTexts.toolbar.problems({ count: 1 }) })).toBeInTheDocument();
    // Конец последней части снова совпадает с концом трека: список снимается, сохранение проходит обычным образом.
    await userEvent.clear(end);
    await userEvent.type(end, '24');
    await waitFor(() => expect(screen.queryByText(scenarioTexts.treatment.problemsTitle)).not.toBeInTheDocument(), { timeout: 3000 });
    await userEvent.click(saveButton(screen));
    await screen.findByText(scenarioTexts.notice.scenesSaved, { exact: true }, { timeout: 3000 });
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений сценария: 2 (production, production).');
  }
};

export const PartsFromTimingJoined: Story = {
  name: 'Части из разметки · промежутки и перекрытия карты закрываются, части встык',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ variant: 'noShots', gappedTiming: true }) },
  play: async (context) => {
    const screen = await ready(context);
    // Сохранённые части скопировали границы карты как есть: проблемы видны сразу.
    const title = await screen.findByText(scenarioTexts.treatment.problemsTitle, {}, { timeout: 3000 });
    const alert = (title as HTMLElement).closest('[role="alert"]') as HTMLElement;
    await waitFor(() => expect(within(alert).getAllByRole('listitem')).toHaveLength(4));
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.toolbar.partsFromTiming }));
    const confirm = within(await screen.findByRole('dialog'));
    await userEvent.click(confirm.getByRole('button', { name: scenarioTexts.toolbar.replacePartsConfirm }));
    await waitFor(() => expect(screen.queryByText(scenarioTexts.treatment.problemsTitle)).not.toBeInTheDocument(), { timeout: 3000 });
    const values = (name: string) => screen.getAllByRole('spinbutton', { name }).map((input: HTMLElement) => (input as HTMLInputElement).value);
    await expect(values(scenarioTexts.fields.startSeconds)).toEqual(['0', '8.1', '16.1']);
    await expect(values(scenarioTexts.fields.endSeconds)).toEqual(['8.1', '16.1', '24']);
    await userEvent.click(saveButton(screen));
    await screen.findByText(scenarioTexts.notice.scenesSaved, { exact: true }, { timeout: 3000 });
  }
};

export const StateFieldInheritance: Story = {
  name: 'Состояние · отмена изменения, явное снятие и сохранность других планов',
  tags: ['ci', '!autodocs'],
  parameters: { songframe: scenarioPageOptions({ failScenesSaveOnce: true }) },
  play: async (context) => {
    const screen = await ready(context);
    const texts = componentsTexts.stateEditor;
    const before = scenarioStateInspection();
    const entity = documentOf(context).querySelector<HTMLElement>('[data-state-entity="after:hero"]')!;
    const scope = within(entity);
    await userEvent.click(scope.getAllByRole('button')[0]);
    // Врезка вычисляется с задержкой после загрузки: наследование проверяется по готовому снимку.
    await scope.findByText(texts.inherited({ value: 'спокоен' }), {}, { timeout: 3000 });
    await expect(scope.getByRole('combobox', { name: 'Куртка' })).toHaveValue('мокрая');
    await userEvent.click(scope.getByRole('button', { name: texts.undoProperty({ label: 'Куртка' }) }));
    let dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: texts.undo }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(scope.getByRole('combobox', { name: 'Куртка' })).toHaveAttribute('placeholder', 'сухая'));
    await expect(scenarioStateInspection()).toEqual(before);
    await userEvent.click(scope.getByRole('button', { name: texts.removeProperty({ label: 'Куртка' }) }));
    dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: texts.remove }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(scope.getByRole('combobox', { name: 'Куртка' })).toBeDisabled();
    await userEvent.click(saveButton(screen));
    await screen.findByText('Не удалось сохранить сценарий. Изменения состояния остались в форме.');
    await expect(scenarioStateInspection()).toEqual(before);
    await expect(scope.getByRole('combobox', { name: 'Куртка' })).toBeDisabled();
    await userEvent.click(saveButton(screen));
    await waitFor(() => expect(scenarioStateInspection().saves).toEqual(['production']));
    const saved = scenarioStateInspection().saved.scenes!;
    await expect(saved.scenes[0].state_changes.after?.hero).toEqual({ coat: null });
    await expect(saved.scenes.slice(1)).toEqual(before.saved.scenes!.scenes.slice(1));
    await expect(scenarioStateInspection().saved.cast).toEqual(before.saved.cast);
    await selectByKeyboard(context, 'M02');
    await selectByKeyboard(context, 'M01');
    const reopened = within(documentOf(context).querySelector<HTMLElement>('[data-state-entity="after:hero"]')!);
    await userEvent.click(reopened.getAllByRole('button')[0]);
    await expect(reopened.getByRole('combobox', { name: 'Куртка' })).toBeDisabled();
    await userEvent.click(reopened.getByRole('button', { name: texts.restoreProperty({ label: 'Куртка' }) }));
    await waitFor(() => expect(reopened.getByRole('combobox', { name: 'Куртка' })).toHaveAttribute('placeholder', 'сухая'));
    await expect(scenarioStateInspection().saved.scenes!.scenes[0].state_changes.after?.hero).toEqual({ coat: null });
    // После проверки блока возвращаемся к панели страницы: соседняя кнопка не остаётся наполовину под sticky-шапкой.
    documentOf(context).defaultView!.scrollTo({ top: 0, behavior: 'instant' });
    await waitFor(() => expect(documentOf(context).defaultView!.scrollY).toBe(0));
  }
};

/** Пустой сценарий объясняет действие через сущность агента, независимо от текущего каталога исполнителей. */
export const NeutralAgentTreatment: Story = {
  name: 'Нейтральная подсказка агента · сценария нет · ручное создание',
  tags: ['ci', '!autodocs'],
  parameters: { songframe: scenarioPageOptions({ variant: 'noScenario' }) },
  play: async (context) => {
    const screen = await ready(context);
    const hint = await screen.findByText(scenarioTexts.treatment.emptyHint);
    await expect(hint).toBeVisible();
    await expect(hint).toHaveTextContent('поручите первый проход агенту кнопкой «Создать части»');
    await expect(hint).not.toHaveTextContent(/Claude|Codex/);
    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.treatment.createManually }));
    await expect(await screen.findByRole('textbox', { name: scenarioTexts.fields.logline })).toBeVisible();
    await expect(screen.getByRole('button', { name: scenarioTexts.treatment.title({ count: 0 }) })).toHaveAttribute('aria-expanded', 'true');
    await expect(screen.getByText(scenarioTexts.page.noShots)).toBeVisible();
  }
};

export const ViewpointDraftRestore: Story = {
  name: 'Точка съёмки · черновик прошлого запуска восстанавливает расстановку',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M03', leftDraft: true }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M03');
    await expect(await screen.findByText(commonTexts.draft.title)).toBeVisible();
    await expect(viewpointBlock(screen)).toHaveTextContent(viewpointTexts.badgeUnset);
    await userEvent.click(screen.getByRole('button', { name: commonTexts.draft.restore }));
    await expect(viewpointBlock(screen)).toHaveTextContent(viewpointTexts.badge({ side: 'С юга', size: 'Средний', placed: true }));
    await expect(unsavedChip(screen)).toBeInTheDocument();
    await expect(screen.queryByText(commonTexts.draft.title)).toBeNull();
  }
};
