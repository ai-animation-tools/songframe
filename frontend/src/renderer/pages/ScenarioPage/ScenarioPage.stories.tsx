/** Целая страница «Сценарий» на локальной модели: переходы к планам, блок частей, закреплённые панели и сохранность черновика. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { componentsTexts } from '@shared/texts/components';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import { scenarioTexts } from '@shared/texts/scenario';
import {
  SCENARIO_PAGE_READ_ERROR,
  ScenarioPageStory,
  scenarioPageActionProblem,
  scenarioPageOptions,
  scenarioStateInspection
} from '../../testing/scenarioPageStories';

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

export const BriefOutsidePlan: Story = {
  name: 'Врезка · сущности вне плана свёрнуты и не идут агенту',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ route: '/project/scenario?shot=M02' }) },
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M02');
    // В M02 в кадре только герой: сосед и ворота вычислены, но во врезку агенту не входят.
    const summary = await screen.findByRole('button', { name: new RegExp(scenarioTexts.brief.outsidePlan({ count: 2 })) }, { timeout: 3000 });
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
  name: 'Список планов · статус производства бейджем, как на «Производстве»',
  tags: ['ci'],
  parameters: { songframe: scenarioPageOptions({ variant: 'produced' }) },
  play: async (context) => {
    await ready(context);
    const status = async (shot: string) => within(row(context, shot)).findByTestId('shot-status');
    await expect(await status('M01')).toHaveTextContent(componentsTexts.shot.states.completed);
    await expect(await status('M02')).toHaveTextContent(componentsTexts.shot.states.completed);
    await expect(await status('M03')).toHaveTextContent(componentsTexts.shot.states.planned);
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

export const AgentWithDrafts: Story = {
  name: 'Запуск агента с несохранёнными правками · решение и пауза редактирования',
  tags: ['!autodocs', 'ci'],
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.type(field(screen, scenarioTexts.fields.action), ' Правка до агента.');
    await userEvent.click(await screen.findByRole('button', { name: scenarioTexts.workflow.createScenes }));
    const conflict = within(await screen.findByRole('dialog', { name: commonTexts.unsavedChanges }));
    await expect(conflict.getByText(scenarioTexts.drafts.changed)).toBeInTheDocument();
    await userEvent.click(conflict.getByRole('button', { name: scenarioTexts.drafts.returnToEditor }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByTestId('page-model-agent')).toHaveTextContent('Запусков агента: 0.');
    await expect(field(screen, scenarioTexts.fields.action).value).toContain('Правка до агента.');

    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.workflow.createScenes }));
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

/** Раскрывает свёрнутый по умолчанию отчёт проверки кнопкой в строке статуса. */
const expandCheck = async (panel: Screen) => {
  const toggle = panel.getByRole('button', { name: scenarioTexts.check.expandReport });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(toggle);
  await expect(panel.getByRole('button', { name: scenarioTexts.check.collapseReport })).toHaveAttribute('aria-expanded', 'true');
};

export const CheckReport: Story = {
  name: 'Проверка сценария · отчёт: важные проблемы первыми, переход к блоку состояния плана',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ check: 'report' }) },
  play: async (context) => {
    const screen = await ready(context);
    const panel = await checkPanel(screen);
    await expect(panel.getByText(scenarioTexts.check.statusIssues({ count: 3 }))).toBeInTheDocument();
    // Готовый отчёт по умолчанию свёрнут до строки статуса и раскрывается кнопкой.
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
    await expect(await panel.findByRole('button', { name: scenarioTexts.check.collapseReport })).toHaveAttribute('aria-expanded', 'true');
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
    const dialog = within(await screen.findByRole('dialog', { name: scenarioTexts.revise.title }));
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
    // Свёрнутый отчёт оставляет строку статуса и «Проверить заново».
    await userEvent.click(panel.getByRole('button', { name: scenarioTexts.check.collapseReport }));
    await waitFor(() => expect(panel.queryByText(/Сосед появляется раньше куплета/)).not.toBeInTheDocument());
    await expect(panel.getByRole('button', { name: scenarioTexts.check.restart })).toBeInTheDocument();
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
