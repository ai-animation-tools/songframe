/** Целая страница «Сценарий» на локальной модели: переходы к планам, вкладки, закреплённые панели и сохранность черновиков. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import { scenarioTexts } from '@shared/texts/scenario';
import { SCENARIO_PAGE_READ_ERROR, ScenarioPageStory, scenarioPageActionProblem, scenarioPageOptions } from '../../testing/scenarioPageStories';

const meta = {
  title: 'Страницы/Сценарий',
  component: ScenarioPageStory,
  parameters: { songframe: scenarioPageOptions(), controls: { disable: true } }
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
const treatmentTab = (screen: Screen) => screen.getByRole('tab', { name: scenarioTexts.toolbar.treatmentTab({ count: 3 }) });
const scenesTab = (screen: Screen) => screen.getByRole('tab', { name: scenarioTexts.toolbar.scenesTab({ count: 6 }) });
const saveButton = (screen: Screen) => screen.getByRole('button', { name: commonTexts.save });

export const Overview: Story = {
  name: 'Обычный реестр · первый план выбран, сохранять нечего',
  play: async (context) => {
    const screen = await ready(context);
    await editorHeading(screen, 'M01');
    await expect(row(context, 'M01')).toHaveAttribute('aria-current', 'true');
    await expect(scenesTab(screen)).toHaveAttribute('aria-selected', 'true');
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
    // Ссылка на открытой странице только выбирает план в черновике: реестр не перечитывается.
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

export const TabDrafts: Story = {
  name: 'Вкладки «Трактовка» и «Реестр» · черновики сохраняются независимо',
  tags: ['!autodocs', 'ci'],
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.click(treatmentTab(screen));
    const logline = field(screen, scenarioTexts.fields.logline);
    await userEvent.clear(logline);
    await userEvent.type(logline, 'Черновик логлайна.');
    await expect(unsavedChip(screen)).toBeInTheDocument();

    // Сохранение реестра не трогает черновик трактовки.
    await userEvent.click(scenesTab(screen));
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
    await userEvent.type(field(screen, scenarioTexts.fields.action), ' Первая правка.');
    await userEvent.click(saveButton(screen));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений реестра: 1 (production).'));
    await expect(screen.getByTestId('page-model-shot-M01')).toHaveTextContent('Первая правка.');
    await userEvent.click(treatmentTab(screen));
    await expect(field(screen, scenarioTexts.fields.logline)).toHaveValue('Черновик логлайна.');
    await expect(unsavedChip(screen)).toBeInTheDocument();
    await expect(screen.getByTestId('page-model-logline')).toHaveTextContent('Герой возвращается к старым воротам.');

    // И наоборот: черновик реестра переживает сохранение трактовки.
    await userEvent.click(scenesTab(screen));
    await userEvent.type(field(screen, scenarioTexts.fields.action), ' Вторая правка.');
    await userEvent.click(treatmentTab(screen));
    await expect(screen.getByText(scenarioTexts.workflow.treatmentApproved, { exact: true })).toBeInTheDocument();
    await userEvent.click(saveButton(screen));
    await waitFor(() => expect(screen.getByTestId('page-model-logline')).toHaveTextContent('Черновик логлайна.'));
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
    // Утверждение пары включает трактовку: после её записи пару нужно утвердить заново.
    await screen.findByText(scenarioTexts.workflow.treatmentUnapproved, { exact: true }, { timeout: 3000 });
    await expect(screen.getByText(scenarioTexts.workflow.scenesNeedReview)).toBeInTheDocument();
    await userEvent.click(scenesTab(screen));
    await expect(field(screen, scenarioTexts.fields.action).value).toContain('Первая правка. Вторая правка.');
    await expect(unsavedChip(screen)).toBeInTheDocument();
    await expect(screen.getByTestId('page-model-shot-M01')).not.toHaveTextContent('Вторая правка.');
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений трактовки: 1. Сохранений реестра: 1 (production).');
  }
};

export const SaveProducedShots: Story = {
  name: 'Сохранение реестра · принятые планы требуют подтверждения',
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
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений реестра: 0.');
    await expect(unsavedChip(screen)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: scenarioTexts.toolbar.saveWithoutProduction }));
    const keep = within(await screen.findByRole('dialog', { name: scenarioTexts.save.keepTitle }));
    await userEvent.click(keep.getByRole('button', { name: scenarioTexts.toolbar.saveWithoutProduction }));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений реестра: 1 (keep).'));
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
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений реестра: 2 (keep, production).'));
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(screen.getByTestId('page-model-shot-M03')).toHaveTextContent('Правка нового плана.');
  }
};

export const RegistryProblems: Story = {
  name: 'Проблемы реестра · сохранение заблокировано до исправления',
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
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений реестра: 0.');
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
    await expect(conflict.getByText(scenarioTexts.drafts.changed({ treatment: false, scenes: true }))).toBeInTheDocument();
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
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений реестра: 1 (production).');
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
  name: 'Применение прохода сценария · правки отменяются, записывается только реестр',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ variant: 'proposal' }) },
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.click(treatmentTab(screen));
    const logline = field(screen, scenarioTexts.fields.logline);
    await userEvent.clear(logline);
    await userEvent.type(logline, 'Правка трактовки до применения.');
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
    await expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений трактовки: 0. Сохранений реестра: 0.');
    await expect(field(screen, scenarioTexts.fields.logline)).toHaveValue('Герой возвращается к старым воротам.');
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
    await userEvent.click(scenesTab(screen));
    await waitFor(() => expect(field(screen, scenarioTexts.fields.action)).toHaveValue(PROPOSAL_ACTION));
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
  }
};

export const ProposalStaleAfterSave: Story = {
  name: 'Сохранение реестра до применения · предложение устарело, применить нельзя',
  tags: ['!autodocs', 'ci'],
  parameters: { songframe: scenarioPageOptions({ variant: 'proposal' }) },
  play: async (context) => {
    const screen = await ready(context);
    await userEvent.type(field(screen, scenarioTexts.fields.action), ' Правка до применения.');
    await userEvent.click(saveButton(screen));
    await waitFor(() => expect(screen.getByTestId('page-model-saves')).toHaveTextContent('Сохранений реестра: 1 (production).'));
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
  name: 'Длинный реестр · закреплённые панель и список, поиск и клавиатура',
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
    // Реестр делится на две колонки с брейкпоинта lg (1200 px окна): шире список закреплён под панелью, уже — уходит вверх вместе со страницей.
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

export const NoRegistry: Story = {
  name: 'Нет реестра · каркас только по сохранённой трактовке',
  tags: CANVAS_ONLY,
  parameters: { songframe: scenarioPageOptions({ variant: 'noRegistry' }) },
  play: async (context) => {
    const screen = await ready(context);
    await expect(screen.getByRole('tab', { name: scenarioTexts.toolbar.treatmentTab({ count: 3 }) })).toHaveAttribute('aria-selected', 'true');
    await expect(screen.getByRole('tab', { name: scenarioTexts.toolbar.scenesTab({ count: null }) })).toBeDisabled();
    const scaffold = () => screen.getByRole('button', { name: scenarioTexts.toolbar.buildScaffold });
    await expect(scaffold()).toBeEnabled();
    await userEvent.type(field(screen, scenarioTexts.fields.logline), ' Черновик.');
    await expect(scaffold()).toBeDisabled();
    await expect(scaffold()).toHaveAttribute('title', expect.stringContaining(scenarioTexts.prerequisites.savedDrafts));
    await userEvent.click(saveButton(screen));
    await waitFor(() => expect(scaffold()).toBeEnabled());
    await userEvent.click(scaffold());
    await editorHeading(screen, 'M01');
    await expect(screen.getByRole('tab', { name: scenarioTexts.toolbar.scenesTab({ count: 6 }) })).toHaveAttribute('aria-selected', 'true');
    await expect(screen.getByTestId('page-model-scaffold')).toHaveTextContent('Построений каркаса: 1 (--json).');
    await expect(screen.getByTestId('page-model-shots')).toHaveTextContent('Сохранённых планов: 6.');
    await expect(screen.getByTestId('page-model-logline')).toHaveTextContent('Черновик.');
    await expect(unsavedChip(screen)).not.toBeInTheDocument();
  }
};
