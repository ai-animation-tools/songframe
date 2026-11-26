/** Целая страница «Производство»: настоящий опрос, выбор плана и попытки, путь плана, якоря и переходы ответов на локальной модели API. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { expectImplicitCloseBlocked } from '../../testing/dialogStories';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { commonTexts } from '@shared/texts/common';
import { componentsTexts } from '@shared/texts/components';
import { navigationTexts } from '@shared/texts/navigation';
import { videoReviewTexts } from '@shared/texts/video-review';
import { productionTexts } from '@shared/texts/production';
import { mediaProviderInfo } from '@shared/media-providers';
import type { AcceptedKit, ShotProduction } from '@shared/types';
import { ANCHORS } from '../../components/linkTargets';
import { formatClock } from '../../format';
import { keyframePackage } from '../../testing/keyframeStories';
import { workflowAgentJob, workflowProposal } from '../../testing/productionWorkflowStories';
import { STORY_IMAGE_PATH, STORY_TRACK_PATH, STORY_VIDEO_PATH } from '../../testing/storybook';
import { preparedPackage, queuedPackage } from '../../testing/productionQueueStories';
import { receivingPackage, receivedPackage } from '../../testing/resultStories';
import {
  longPageShots,
  PAGE_ACTION_ERROR,
  PAGE_READ_ERROR,
  PAGE_REVIEW_ERROR,
  packageForShot,
  pageShot,
  ProductionPageStory,
  productionPageOptions,
  type ProductionPageModelOptions
} from '../../testing/productionPageStories';
import { attemptLabel } from './planPath';
import { emptySpend, spendEntry } from '../../testing/spendStories';

const texts = productionTexts;
const steps = texts.planPath;
const POLL_TIMEOUT = { timeout: 6000 };

/** Небольшой проект: план в работе с вопросом об опоре, производный, запланированный, устаревший и принятые. */
function baseShots(main: Partial<ShotProduction> = {}): ShotProduction[] {
  const waiting = keyframePackage({ keyframeNotes: [], description: 'Герой останавливается у ворот и смотрит на свет в окне.' });
  return [
    pageShot('M01', { title: 'Подъезд к даче', start: 0, end: 6 }),
    pageShot('M02', {
      state: 'progress',
      stageLabel: 'Опоры на согласовании',
      asset: null,
      attention: waiting.pendingDecision!.question,
      packages: [waiting],
      ...main
    }),
    pageShot('M03', { title: 'Ожидание у ворот', start: 17, end: 20, derivedFrom: 'M01', state: 'planned', stageLabel: 'Производный план', asset: null }),
    pageShot('M04', {
      title: 'Свет в окне',
      start: 20,
      end: 25,
      state: 'planned',
      stageLabel: 'Запланирован',
      asset: null,
      regenerateProblem: 'Нет сохранённого запроса для повтора.'
    }),
    pageShot('M05', { title: 'Дверь открывается', start: 25, end: 30, state: 'stale', stageLabel: 'Постановка изменена' }),
    pageShot('M06', { title: 'Финальный проход', start: 30, end: 36 })
  ];
}

const options = (model: Partial<ProductionPageModelOptions> = {}, route?: string, workspaceWidth?: number) =>
  productionPageOptions({ shots: () => baseShots(), ...model }, route, workspaceWidth);

const meta = {
  title: 'Страницы/Производство',
  component: ProductionPageStory,
  // Якоря прокручивают документ, диалоги переводят фокус, опрос идёт каждые 1800 мс: сценарии запускаются только в Canvas.
  tags: ['!autodocs'],
  parameters: { songframe: options(), controls: { disable: true } }
} satisfies Meta<typeof ProductionPageStory>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];

const screenOf = ({ canvasElement }: Context) => within(canvasElement.ownerDocument.body);
const route = (context: Context) => screenOf(context).getByTestId('story-route');
const counts = (context: Context) => screenOf(context).getByTestId('production-model');
const shotHeading = (context: Context, id: string) => screenOf(context).findByRole('heading', { name: id, level: 6 }, POLL_TIMEOUT);
const pageReady = (context: Context) => screenOf(context).findByRole('heading', { name: texts.productionToolbar.heading }, POLL_TIMEOUT);
const readCount = (context: Context) => Number(/Чтений: (\d+)/.exec(counts(context).textContent ?? '')?.[1]);
const selectedCard = (context: Context) => context.canvasElement.ownerDocument.querySelector<HTMLElement>('[aria-current="true"]');
const attemptSelect = (context: Context) => screenOf(context).getByRole('combobox', { name: new RegExp(texts.productionPage.packageLabel) });
const attemptName = (relative: string, stage: string) => texts.productionPage.queuedPrefix({ queued: false, relative, stage });
/** Шаг пути: разметка Stepper не задаёт ему роль, поэтому шаг ищется по служебному признаку. */
const planStep = (context: Context, key: string) => context.canvasElement.ownerDocument.querySelector<HTMLElement>(`[data-plan-step="${key}"]`)!;
/** Меню редких действий плана; пункты появляются в отдельном слое поверх страницы. */
async function openMenu(context: Context) {
  await userEvent.click(screenOf(context).getByRole('button', { name: steps.moreActions }));
  return within(await screenOf(context).findByRole('menu'));
}

export const Overview: Story = {
  tags: ['ci'],
  name: 'Обзор · план с вопросом выбран и открыт автоматически',
  play: async (context) => {
    const screen = screenOf(context);
    await shotHeading(context, 'M02');
    await expect(selectedCard(context)).toHaveTextContent('M02');
    // Единственная попытка открывается сама; вопрос об опоре виден без ручного выбора.
    await expect(await screen.findByText('Утвердить опору K02?')).toBeInTheDocument();
    await expect(attemptSelect(context)).toHaveTextContent(attemptName(attemptLabel(keyframePackage()), 'Опоры на согласовании'));
    await expect(await screen.findByText(steps.now({ text: steps.frameQuestion({ frame: 'K02' }) }))).toBeInTheDocument();
    await expect(context.canvasElement.ownerDocument.querySelector(`[data-anchor="${ANCHORS.productionWorkflow}"]`)).not.toBeNull();
    await expect(route(context)).toHaveTextContent(/^\/project\/production$/);
    // Текущий шаг открыт, будущий приглушён и не нажимается, пройденный открывается только для чтения.
    await expect(within(planStep(context, 'frames')).getByText('Утвердить опору K02?')).toBeInTheDocument();
    await expect(within(planStep(context, 'prompt')).getByText(steps.after.prompt)).toBeInTheDocument();
    await expect(within(planStep(context, 'prompt')).queryByRole('button')).not.toBeInTheDocument();
    const description = within(planStep(context, 'description'));
    await expect(description.queryByText(/Герой останавливается у ворот/)).not.toBeInTheDocument();
    await userEvent.click(description.getByRole('button', { name: new RegExp(steps.titles.description) }));
    await expect(await description.findByText(/Герой останавливается у ворот/)).toBeInTheDocument();
    await expect(description.queryByRole('button', { name: texts.productionWorkflowPanel.prepare })).not.toBeInTheDocument();
    await userEvent.click(description.getByRole('button', { name: new RegExp(steps.titles.description) }));
    await waitFor(() => expect(description.queryByText(/Герой останавливается у ворот/)).not.toBeInTheDocument());
  }
};

/** Описание принято, опоры ещё создаются: доработка переделает описание, а не опоры. */
const framesInProgress = keyframePackage({
  stage: 'keyframes',
  stageLabel: 'Опоры',
  pendingDecision: null,
  keyframeNotes: [],
  description: 'Герой останавливается у ворот и смотрит на свет в окне.',
  keyframes: keyframePackage().keyframes.map((frame) => ({ ...frame, imagePath: null, approved: false }))
});

export const RevisionInStageStep: Story = {
  tags: ['ci'],
  name: 'Доработка описания · задание и доработка в шаге «Описание», а не в шаге опор',
  parameters: {
    songframe: options({
      shots: () => baseShots({ stageLabel: 'Опоры', attention: null, packages: [framesInProgress] }),
      workflowView: (shot, packageDir) =>
        shot === 'M02' && packageDir
          ? {
              canRevise: true,
              reviseStage: 'description',
              job: workflowAgentJob({
                task: 'ai-clip-scene:M02:description',
                status: 'completed',
                phase: 'done',
                finishedAt: '2026-10-30T09:02:00.000Z',
                exitCode: 0
              }),
              proposal: workflowProposal('description', { status: 'applied' })
            }
          : {}
    })
  },
  play: async (context) => {
    await shotHeading(context, 'M02');
    const frames = within(planStep(context, 'frames'));
    await expect(await frames.findByText('K01', {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Шаг опор не показывает завершённое задание описания и его доработку.
    await expect(frames.queryByText('ai-clip-scene:M02:description')).not.toBeInTheDocument();
    await expect(frames.queryByRole('button', { name: /Доработать/ })).not.toBeInTheDocument();
    const description = within(planStep(context, 'description'));
    await expect(description.queryByText('ai-clip-scene:M02:description')).not.toBeInTheDocument();
    await userEvent.click(description.getByRole('button', { name: new RegExp(steps.titles.description) }));
    await expect(await description.findByText('ai-clip-scene:M02:description')).toBeInTheDocument();
    await userEvent.click(description.getByRole('button', { name: texts.productionWorkflowPanel.reviseOpenFor.description }));
    await expect(await description.findByRole('textbox', { name: texts.productionWorkflowPanel.noteFor.description })).toBeInTheDocument();
    await expect(description.getByRole('button', { name: texts.productionWorkflowPanel.revise })).toBeDisabled();
  }
};

export const FragmentPreview: Story = {
  tags: ['ci'],
  name: 'Фрагмент под музыку · из панели страницы',
  play: async (context) => {
    const screen = screenOf(context);
    const fragment = texts.fragmentPreview;
    await shotHeading(context, 'M02');
    await userEvent.click(screen.getByRole('button', { name: fragment.open }));
    // Вход — в шапке выбранного плана; панель страницы остаётся прежней.
    const dialog = within(await screen.findByRole('dialog', { name: fragment.title }));
    // Диапазон начинается с выбранного плана страницы.
    await expect(dialog.getByRole('combobox', { name: fragment.from })).toHaveTextContent('M02');
    await userEvent.click(dialog.getByRole('combobox', { name: fragment.to }));
    await userEvent.click(await screen.findByRole('option', { name: /^M04/ }));
    await userEvent.click(dialog.getByRole('button', { name: fragment.build }));
    await dialog.findByText(fragment.ready, undefined, POLL_TIMEOUT);
    await expect(dialog.getByLabelText(fragment.video)).toHaveAttribute('src', expect.stringContaining('media/story-video.mp4?v='));
    // Закрытие возвращает к плану; приёмка и попытки не менялись.
    await userEvent.click(dialog.getByRole('button', { name: fragment.close }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: fragment.title })).not.toBeInTheDocument());
    await expect(selectedCard(context)).toHaveTextContent('M02');
  }
};

export const ShotFromQuery: Story = {
  name: 'Адрес ?shot= · выбор плана и новая ссылка на открытой странице',
  args: { links: [{ label: 'Уведомление: открыть M05', to: '/project/production?shot=M05' }] },
  parameters: { songframe: options({}, '/project/production?shot=M04') },
  play: async (context) => {
    const screen = screenOf(context);
    // Без параметра был бы выбран план в работе M02.
    await shotHeading(context, 'M04');
    await expect(selectedCard(context)).toHaveTextContent('M04');
    await userEvent.click(screen.getByRole('button', { name: 'Уведомление: открыть M05' }));
    await waitFor(() => expect(route(context)).toHaveTextContent('/project/production?shot=M05'));
    await shotHeading(context, 'M05');
    await expect(selectedCard(context)).toHaveTextContent('M05');
    // Ручной выбор не переписывает адрес, а следующий опрос не возвращает план из параметра.
    await userEvent.click(screen.getByText('M01', { selector: 'p' }));
    const reads = readCount(context);
    await shotHeading(context, 'M01');
    await waitFor(() => expect(readCount(context)).toBeGreaterThan(reads), POLL_TIMEOUT);
    await expect(screen.getByRole('heading', { name: 'M01', level: 6 })).toBeInTheDocument();
    await expect(selectedCard(context)).toHaveTextContent('M01');
    await expect(route(context)).toHaveTextContent('/project/production?shot=M05');
  }
};

export const Anchors: Story = {
  tags: ['ci'],
  name: 'Якоря ?anchor= · подготовка плана и фильтр очереди',
  parameters: {
    songframe: options(
      { problems: ['Сохранённые запросы ждут решения в блоке «Очередь».', `Кандидаты M02 готовятся в блоке «${navigationTexts.blocks.productionFrames}».`] },
      `/project/production?shot=M02&anchor=${ANCHORS.productionWorkflow}`
    )
  },
  play: async (context) => {
    const screen = screenOf(context);
    const document = context.canvasElement.ownerDocument;
    const workflow = () => document.querySelector<HTMLElement>(`[data-anchor="${ANCHORS.productionWorkflow}"]`);
    const bar = () => document.querySelector<HTMLElement>('[data-page-action-bar="top"]')!;
    // Цель появляется после первого опроса: фокус, снятие параметра и место под закреплённой панелью.
    await waitFor(() => expect(document.activeElement).toBe(workflow()), POLL_TIMEOUT);
    await waitFor(() => expect(route(context)).toHaveTextContent(/^\/project\/production\?shot=M02$/));
    await waitFor(() => {
      const rect = workflow()!.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(bar().getBoundingClientRect().bottom - 1);
      expect(rect.top).toBeLessThan(window.innerHeight);
    });
    // Ссылка из сообщения на текущей странице сохраняет ?shot= и подсвечивает фильтр «Показать».
    const problems = within(screen.getByText(/Сохранённые запросы ждут решения/).closest<HTMLElement>('[role="alert"]')!);
    await userEvent.click(problems.getByRole('link', { name: '«Очередь»' }));
    const filter = document.querySelector<HTMLElement>(`[data-anchor="${ANCHORS.productionFilter}"]`)!;
    await waitFor(() => expect(filter).toHaveAttribute('data-anchor-highlight'));
    await waitFor(() => expect(route(context)).toHaveTextContent(/^\/project\/production\?shot=M02$/));
    // Повторный переход к тому же блоку снова переводит фокус.
    await userEvent.click(problems.getByRole('link', { name: `«${navigationTexts.blocks.productionFrames}»` }));
    await waitFor(() => expect(document.activeElement).toBe(workflow()));
    await waitFor(() => expect(route(context)).toHaveTextContent(/^\/project\/production\?shot=M02$/));
    await expect(screen.getByRole('heading', { name: 'M02', level: 6 })).toBeInTheDocument();
  }
};

/** Длинный список: панель действий под шапкой; при двух колонках карточка плана закреплена и прокручивается сама. */
async function checkLongLayout(context: Context, expectTwoColumns: boolean) {
  const document = context.canvasElement.ownerDocument;
  const view = document.defaultView!;
  const heading = await shotHeading(context, 'M18');
  const bar = document.querySelector<HTMLElement>('[data-page-action-bar="top"]')!;
  const header = document.querySelector('header')!;
  // Выбранная из адреса карточка прокручена в видимую часть и не спрятана под панелью.
  await waitFor(() => {
    const rect = selectedCard(context)!.getBoundingClientRect();
    expect(rect.top, 'выбранная карточка под панелью').toBeGreaterThanOrEqual(bar.getBoundingClientRect().bottom - 1);
    expect(rect.bottom, 'выбранная карточка в окне').toBeLessThanOrEqual(view.innerHeight + 1);
  });
  let grid = heading.parentElement;
  while (grid && view.getComputedStyle(grid).display !== 'grid') grid = grid.parentElement;
  const columns = view.getComputedStyle(grid!).gridTemplateColumns.split(' ').length;
  // Число колонок задаёт ширина содержимого контейнера workspace, а не окна.
  let workspace = grid!.parentElement!;
  while (view.getComputedStyle(workspace).containerName !== 'workspace') workspace = workspace.parentElement!;
  const style = view.getComputedStyle(workspace);
  const wide = workspace.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) >= 1100;
  // Широкая область: список, разделитель и план.
  await expect(columns).toBe(wide ? 3 : 1);
  // Область 1600 px в окне от 1200 px обязана дать две колонки.
  if (expectTwoColumns && view.innerWidth >= 1200) await expect(wide).toBe(true);
  let column = heading.parentElement!;
  while (column.parentElement !== grid) column = column.parentElement!;
  // Середина длинного списка: панель и колонка уже закреплены, конец сетки ещё не выталкивает колонку.
  view.scrollTo({ top: grid!.getBoundingClientRect().top + view.scrollY + grid!.scrollHeight / 2 - view.innerHeight / 2, behavior: 'instant' });
  await waitFor(() => expect(Math.abs(bar.getBoundingClientRect().top - header.getBoundingClientRect().bottom)).toBeLessThanOrEqual(1));
  await expect(screenOf(context).getByRole('button', { name: texts.productionToolbar.refresh })).toBeVisible();
  if (wide) {
    await expect(view.getComputedStyle(column).position).toBe('sticky');
    const rect = column.getBoundingClientRect();
    await expect(Math.abs(rect.top - (bar.getBoundingClientRect().bottom + 16))).toBeLessThanOrEqual(2);
    await expect(rect.bottom, 'колонка плана в окне').toBeLessThanOrEqual(view.innerHeight + 1);
    // Длинное содержимое плана прокручивается внутри колонки, документ остаётся на месте.
    const before = view.scrollY;
    await expect(column.scrollHeight).toBeGreaterThan(column.clientHeight);
    column.scrollTop = column.scrollHeight;
    await waitFor(() => expect(column.scrollTop).toBeGreaterThan(0));
    await expect(view.scrollY).toBe(before);
    // Разделитель расширяет список до предела: карточки планов встают в несколько колонок.
    const handle = screenOf(context).getByRole('separator', { name: commonTexts.listDetail.split });
    const cards = () => view.getComputedStyle(grid!.firstElementChild!.firstElementChild as HTMLElement).gridTemplateColumns.split(' ').length;
    await expect(cards()).toBe(1);
    handle.focus();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(cards()).toBeGreaterThanOrEqual(2));
    await expect(column.getBoundingClientRect().width).toBeGreaterThanOrEqual(600);
  } else {
    // Одна колонка: план идёт после списка и прокручивается вместе с документом.
    await expect(view.getComputedStyle(column).position).not.toBe('sticky');
    await expect(view.getComputedStyle(column).overflowY).not.toBe('auto');
    await expect(screenOf(context).queryByRole('separator', { name: commonTexts.listDetail.split })).not.toBeInTheDocument();
    await expect(column.getBoundingClientRect().top).toBeGreaterThanOrEqual(grid!.firstElementChild!.getBoundingClientRect().bottom);
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(view.innerWidth);
}

const longOptions = { shots: () => longPageShots() };
export const LongList: Story = {
  name: 'Длинный список и пути · закреплённая панель действий',
  parameters: { songframe: productionPageOptions(longOptions, '/project/production?shot=M18') },
  play: (context) => checkLongLayout(context, false)
};

export const TwoColumns: Story = {
  name: 'Две колонки (область 1600 px) · план закреплён, ширина списка меняется разделителем',
  parameters: { songframe: productionPageOptions(longOptions, '/project/production?shot=M18', 1600) },
  play: (context) => checkLongLayout(context, true)
};

export const Loading: Story = {
  name: 'Загрузка · общий индикатор до первого ответа',
  parameters: { songframe: options({ firstRead: 'delayed' }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByRole('progressbar', { name: commonTexts.pageLoading })).toBeInTheDocument();
    await expect(screen.queryByRole('heading', { name: texts.productionToolbar.heading })).not.toBeInTheDocument();
    await pageReady(context);
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: commonTexts.pageLoading })).not.toBeInTheDocument());
    await shotHeading(context, 'M02');
  }
};

export const ReadFailure: Story = {
  name: 'Ошибка первого чтения · уведомление и восстановление опросом',
  parameters: { songframe: options({ firstRead: 'failed' }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(PAGE_READ_ERROR)).toBeInTheDocument();
    await expect(screen.queryByRole('heading', { name: texts.productionToolbar.heading })).not.toBeInTheDocument();
    await pageReady(context);
    await shotHeading(context, 'M02');
    await expect(counts(context)).toHaveTextContent(/Чтений: [2-9]/);
  }
};

const approve = (frame: string) => texts.packageDecision.approve({ frame });
export const ApproveWithRetry: Story = {
  tags: ['ci'],
  name: 'Утверждение опоры · ошибка сохраняет вопрос, повтор с клавиатуры',
  parameters: { songframe: options({ failFirstAction: true }) },
  play: async (context) => {
    const screen = screenOf(context);
    await userEvent.click(await screen.findByRole('button', { name: approve('K02') }, POLL_TIMEOUT));
    // Ошибка видна в уведомлении и в статусе операции пакета.
    await expect(await screen.findAllByText(PAGE_ACTION_ERROR)).not.toHaveLength(0);
    await expect(screen.getByText('Утвердить опору K02?')).toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Утверждено опор: M02:K01.');
    // DisabledHint перемонтирует кнопку при смене причины блокировки: ищем её заново.
    await waitFor(() => expect(screen.getByRole('button', { name: approve('K02') })).toBeEnabled());
    screen.getByRole('button', { name: approve('K02') }).focus();
    await userEvent.keyboard('{Enter}');
    // Следующий снимок задаёт вопрос о K03; комплект плана при этом не принимается.
    await expect(await screen.findByText('Утвердить опору K03?', {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(await screen.findByText(texts.useProductionPage.frameApproved({ frame: 'K02' }))).toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Ответов: 2. Выборов оригинала: 0. Утверждено опор: M02:K01, M02:K02. Приёмок комплекта: 0.');
  }
};

const imageShots = () => baseShots({ stageLabel: 'Результат получен', attention: null, packages: [receivedPackage('image')] });
export const ImageOriginal: Story = {
  tags: ['ci'],
  name: 'Image original · выбор кандидата и отдельное утверждение опоры',
  parameters: { songframe: options({ shots: imageShots }) },
  play: async (context) => {
    const screen = screenOf(context);
    const select = await screen.findAllByRole('button', { name: texts.packageResult.select }, POLL_TIMEOUT);
    await userEvent.click(select[0]);
    // Выбор создаёт только кандидата K02 и вопрос о нём; утверждение — следующий отдельный ответ.
    await expect(await screen.findByText('Утвердить опору K02?', {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(await screen.findByText(texts.useProductionPage.candidateSelected)).toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Выборов оригинала: 1. Утверждено опор: M02:K01. Приёмок комплекта: 0.');
    for (const button of screen.getAllByRole('button', { name: texts.packageResult.select })) await expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: approve('K02') }));
    await expect(await screen.findByText(texts.useProductionPage.frameApproved({ frame: 'K02' }))).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Утвердить опору K02?')).not.toBeInTheDocument());
    await expect(counts(context)).toHaveTextContent('Ответов: 1. Выборов оригинала: 1. Утверждено опор: M02:K01, M02:K02. Приёмок комплекта: 0.');
  }
};

// У плана уже есть принятый комплект: приёмка требует явной замены.
const acceptShots = () => baseShots({ stageLabel: 'Результат получен', attention: null, asset: pageShot('M02').asset, packages: [receivedPackage('video')] });
export const AcceptResult: Story = {
  tags: ['ci'],
  name: 'Приёмка видео · замена комплекта, задание и следующий опрос',
  parameters: { songframe: options({ shots: () => acceptShots().filter((shot) => ['M01', 'M02'].includes(shot.id)) }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(texts.productionToolbar.accepted({ completed: 1, total: 2 }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    const review = within(await screen.findByRole('region', { name: videoReviewTexts.heading }));
    await waitFor(() => expect(review.getByRole('button', { name: videoReviewTexts.start })).toBeEnabled());
    await userEvent.click(review.getByRole('button', { name: videoReviewTexts.start }));
    await review.findByText(videoReviewTexts.status.preparing);
    await expect(screen.getByRole('button', { name: texts.verdictLabels.accept })).toBeEnabled();
    await review.findByText(videoReviewTexts.status.completed, {}, POLL_TIMEOUT);
    await expect(counts(context)).toHaveTextContent('Приёмок комплекта: 0. Отправок генерации: 0.');
    await expect(screen.getByText(texts.productionToolbar.accepted({ completed: 1, total: 2 }))).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: texts.verdictLabels.accept }));
    const dialog = within(await screen.findByRole('dialog', { name: texts.acceptResultDialog.title({ shot: 'M02' }) }));
    const confirm = dialog.getByRole('button', { name: texts.acceptResultDialog.replace });
    await expect(confirm).toBeDisabled();
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.acceptResultDialog.replaceCheckbox }));
    await expectImplicitCloseBlocked(screen.getByRole('dialog'));
    await expect(dialog.getByRole('checkbox', { name: texts.acceptResultDialog.replaceCheckbox })).toBeChecked();
    await expect(counts(context)).toHaveTextContent('Приёмок комплекта: 0.');
    // Выключенная кнопка обёрнута подсказкой причины: после отметки ищем заново включённую кнопку.
    await waitFor(() => expect(dialog.getByRole('button', { name: texts.acceptResultDialog.replace })).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', { name: texts.acceptResultDialog.replace }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(counts(context)).toHaveTextContent('Приёмок комплекта: 1.');
    // Ответ запуска ещё не принимает комплект: итог приходит со следующим опросом заданий и производства.
    await expect(screen.getByText(texts.productionToolbar.accepted({ completed: 1, total: 2 }))).toBeInTheDocument();
    await expect(await screen.findByText(texts.useProductionPage.jobDone({ title: 'Приёмка M02' }), {}, { timeout: 8000 })).toBeInTheDocument();
    await expect(await screen.findByText(texts.productionToolbar.accepted({ completed: 2, total: 2 }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Рабочие попытки очищены: выбирать больше нечего, вместо пути — принятый комплект с новым видео.
    await waitFor(() => expect(screen.queryByRole('combobox', { name: new RegExp(texts.productionPage.packageLabel) })).not.toBeInTheDocument());
    await expect(await screen.findByText(steps.finished)).toBeInTheDocument();
    await expect(await screen.findByText(texts.acceptedKit.heading)).toBeInTheDocument();
    await expect(context.canvasElement.ownerDocument.querySelectorAll('[data-plan-step]')).toHaveLength(0);
    await expect(context.canvasElement.ownerDocument.querySelector(`[data-anchor="${ANCHORS.productionWorkflow}"]`)).not.toBeNull();
  }
};

const multipleShots = () =>
  baseShots({
    packages: [keyframePackage({ keyframeNotes: [] }), preparedPackage('02'), queuedPackage('video')]
  });
export const MultiplePackages: Story = {
  name: 'Несколько попыток · переход из карточки плана и выбор с клавиатуры',
  parameters: { songframe: options({ shots: multipleShots }) },
  play: async (context) => {
    const screen = screenOf(context);
    // Попытка открывается сама: первая с открытым вопросом.
    const open = await screen.findAllByRole('button', { name: texts.productionShotCard.openPackage }, POLL_TIMEOUT);
    await expect(open).toHaveLength(1);
    await expect(await screen.findByText('Утвердить опору K02?')).toBeInTheDocument();
    const combobox = attemptSelect(context);
    await expect(combobox).toHaveTextContent(attemptName(steps.attempt({ number: '1' }), 'Опоры на согласовании'));
    combobox.focus();
    await userEvent.keyboard('{ArrowDown}');
    await screen.findByRole('listbox');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    await expect(combobox).toHaveTextContent('plan/awaiting/M02-video-01');
    await expect(await screen.findByText(texts.packageCard.queued)).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('button', { name: texts.productionShotCard.openPackage })).toHaveLength(2));
  }
};

export const AttemptMenu: Story = {
  tags: ['ci'],
  name: 'Меню плана · новая попытка, отмена повтора и удаление попытки',
  parameters: { songframe: options({ shots: multipleShots }) },
  play: async (context) => {
    const screen = screenOf(context);
    await screen.findByText('Утвердить опору K02?', {}, POLL_TIMEOUT);
    // Новая попытка возвращает путь к началу, не трогая сохранённые попытки.
    await userEvent.click((await openMenu(context)).getByRole('menuitem', { name: steps.newAttempt }));
    await expect(await within(planStep(context, 'description')).findByRole('button', { name: texts.productionWorkflowPanel.prepare })).toBeEnabled();
    await expect(attemptSelect(context)).toHaveTextContent(texts.productionPage.newPreparation);
    await expect(await screen.findByText(steps.now({ text: steps.prepareDescription }))).toBeInTheDocument();
    await userEvent.click(attemptSelect(context));
    await userEvent.click(await screen.findByRole('option', { name: attemptName(steps.attempt({ number: '1' }), 'Опоры на согласовании') }));
    await screen.findByText('Утвердить опору K02?', {}, POLL_TIMEOUT);
    // Повтор из меню только спрашивает подтверждение: без него ничего не создаётся.
    await userEvent.click((await openMenu(context)).getByRole('menuitem', { name: (name) => name.startsWith(steps.retryFromRequest) }));
    await screen.findByRole('dialog', { name: texts.regenerateDialog.title({ shot: 'M02' }) });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Удаление подтверждается отдельно; затем план открывается по общему правилу.
    await userEvent.click((await openMenu(context)).getByRole('menuitem', { name: (name) => name.startsWith(steps.deleteAttempt) }));
    const dialog = await screen.findByRole('dialog', { name: texts.packageCard.discard });
    await userEvent.click(within(dialog).getByRole('button', { name: texts.packageCard.delete }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Удалений попыток: 1.'));
    await waitFor(() => expect(attemptSelect(context)).not.toHaveTextContent(texts.productionPage.newPreparation), POLL_TIMEOUT);
    await expect(counts(context)).toHaveTextContent('Отправок генерации: 0.');
  }
};

export const RetryWithFrames: Story = {
  tags: ['ci'],
  name: 'Меню плана · новая попытка с теми же опорами открывается на видеопромпте',
  parameters: { songframe: options({ shots: multipleShots }) },
  play: async (context) => {
    const screen = screenOf(context);
    await screen.findByText('Утвердить опору K02?', {}, POLL_TIMEOUT);
    // Опору первой попытки ещё можно вернуть на месте: пункта нет.
    const menu = await openMenu(context);
    await expect(menu.queryByRole('menuitem', { name: steps.retryWithFrames })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(attemptSelect(context));
    await userEvent.click(await screen.findByRole('option', { name: attemptName(steps.attempt({ number: '2' }), 'Запрос подготовлен') }));
    await userEvent.click((await openMenu(context)).getByRole('menuitem', { name: steps.retryWithFrames }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Попыток с теми же опорами: 1.'));
    await waitFor(
      () => expect(attemptSelect(context)).toHaveTextContent(attemptName(steps.attempt({ number: '4' }), 'Видеопромпт на согласовании')),
      POLL_TIMEOUT
    );
    await expect(await screen.findByText('Утвердить видеопромпт?', {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(screen.getByText(texts.useProductionPage.attemptRetried({ relative: 'plan/batches/M02-attempt-02' }))).toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Отправок генерации: 0.');
  }
};

export const RetryFirstFrame: Story = {
  tags: ['ci'],
  name: 'Меню плана · новая попытка только с первой опорой: одна опора, видеопромпт заново, остальные опоры не утверждать',
  parameters: { songframe: options({ shots: multipleShots }) },
  play: async (context) => {
    const screen = screenOf(context);
    await screen.findByText('Утвердить опору K02?', {}, POLL_TIMEOUT);
    // Первая опора утверждена, остальные ещё нет: от них можно отказаться, не утверждая.
    await userEvent.click((await openMenu(context)).getByRole('menuitem', { name: steps.retryFirstFrame }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Попыток с первой опорой: 1.'));
    await waitFor(() => expect(attemptSelect(context)).toHaveTextContent(attemptName(steps.attempt({ number: '4' }), 'Опоры утверждены')), POLL_TIMEOUT);
    await expect(screen.getByText(texts.useProductionPage.attemptFirstFrame({ relative: 'plan/batches/M02-attempt-01' }))).toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Отправок генерации: 0.');
  }
};

/** Сборка из опор: обе опоры утверждены, попытка ждёт сборки; видеопромпта и запроса у плана нет. */
const staticShots = () =>
  baseShots({
    staticShot: true,
    // Прежнее принятое видео плана: сборка из опор заменяет его после подтверждения.
    asset: { dir: '/mock/Клип у старых ворот/assets/shots/M02', video: STORY_VIDEO_PATH, original: STORY_VIDEO_PATH },
    stageLabel: 'Опоры утверждены',
    attention: null,
    regenerateProblem: 'M02: план из опор собирается без запроса видео; для новой версии начните новую попытку.',
    packages: [
      keyframePackage({
        keyframeNotes: [],
        stage: 'prompt',
        stageLabel: 'Опоры утверждены',
        pendingDecision: null,
        keyframes: [
          { id: 'K01', role: 'first', time_seconds: 0, imagePath: `${STORY_IMAGE_PATH}?frame=K01`, approved: true },
          { id: 'K02', role: 'middle', time_seconds: 2.5, imagePath: `${STORY_IMAGE_PATH}?frame=K02`, approved: true }
        ]
      })
    ]
  });
export const StaticShotAssembly: Story = {
  tags: ['ci'],
  name: 'Сборка из опор: момент смены, предпросмотр, устаревание и приёмка',
  parameters: { songframe: options({ shots: staticShots }) },
  play: async (context) => {
    const screen = screenOf(context);
    const shotTexts = texts.staticShot;
    let panel = within(await screen.findByTestId('static-shot-panel', {}, POLL_TIMEOUT));
    // Путь сборки из опор: видеопромпта, запроса и генерации нет, текущий шаг — сборка.
    await expect(planStep(context, 'prompt')).toBeNull();
    await expect(planStep(context, 'request')).toBeNull();
    await expect(screen.getByText(steps.now({ text: steps.assemble }))).toBeInTheDocument();
    await expect(screen.getByText(shotTexts.badge)).toBeInTheDocument();
    // Сервис видео плану не нужен: пункта своего видео и повтора по запросу нет.
    const menu = await openMenu(context);
    await expect(menu.queryByRole('menuitem', { name: steps.ownVideo })).not.toBeInTheDocument();
    await expect(menu.queryByRole('menuitem', { name: steps.retryFromRequest })).not.toBeInTheDocument();
    await expect(menu.queryByRole('menuitem', { name: steps.retryFirstFrame })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    // Без предпросмотра принимать нечего; момент смены по времени опоры: 2,5 с — кадр 75.
    await expect(panel.queryByRole('button', { name: shotTexts.accept })).not.toBeInTheDocument();
    const moment = panel.getAllByRole('spinbutton', { name: shotTexts.fromFrame })[1];
    await expect(moment).toHaveValue(75);
    await expect(panel.getAllByRole('spinbutton', { name: shotTexts.fromFrame })[0]).toHaveAttribute('readonly');
    // Смена позже конца плана не проходит проверку: сборка недоступна с причиной.
    await userEvent.clear(moment);
    await userEvent.type(moment, '900');
    await expect(panel.getByRole('button', { name: shotTexts.build })).toBeDisabled();
    await userEvent.clear(moment);
    await userEvent.type(moment, '60');
    await expect(panel.getByText(shotTexts.fromHint({ seconds: texts.productionSpeechPanel.seconds(2) }))).toBeInTheDocument();
    await expect(panel.getByText(shotTexts.dirty)).toBeInTheDocument();
    // Наезд может закончиться раньше плана: по умолчанию движение идёт весь план.
    await userEvent.click(panel.getByRole('button', { name: shotTexts.params }));
    await expect(panel.getByRole('spinbutton', { name: 'Конец движения камеры, доля плана' })).toHaveValue(1);
    // Сборка сохраняет черновик и запускает задание; предпросмотр появляется после его завершения.
    await userEvent.click(panel.getByRole('button', { name: shotTexts.build }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Сборок из опор: 1.'));
    // Переход к другому плану и обратно во время сборки: панель снова следит за идущим заданием.
    await userEvent.click(screen.getByText('M01', { selector: 'p' }));
    await shotHeading(context, 'M01');
    await userEvent.click(screen.getByText('M02', { selector: 'p' }));
    const reopened = within(await screen.findByTestId('static-shot-panel', {}, POLL_TIMEOUT));
    await waitFor(() => expect(reopened.getByRole('button', { name: shotTexts.build })).toBeDisabled());
    await expect(await reopened.findByText(shotTexts.fresh, {}, { timeout: 8000 })).toBeInTheDocument();
    panel = reopened;
    await expect(panel.queryByText(shotTexts.dirty)).not.toBeInTheDocument();
    // Правка после сборки делает предпросмотр устаревшим: принять его нельзя, пока он не собран заново.
    await userEvent.clear(panel.getAllByRole('spinbutton', { name: shotTexts.fromFrame })[1]);
    await userEvent.type(panel.getAllByRole('spinbutton', { name: shotTexts.fromFrame })[1], '50');
    await expect(panel.getByText(shotTexts.stale)).toBeInTheDocument();
    await expect(panel.getByRole('button', { name: shotTexts.accept })).toBeDisabled();
    await userEvent.click(panel.getByRole('button', { name: commonTexts.resetChanges }));
    await expect(panel.getAllByRole('spinbutton', { name: shotTexts.fromFrame })[1]).toHaveValue(60);
    // У плана уже есть принятое видео: приёмка просит подтвердить замену.
    await waitFor(() => expect(panel.getByRole('button', { name: shotTexts.accept })).toBeEnabled());
    await userEvent.click(panel.getByRole('button', { name: shotTexts.accept }));
    const dialog = within(await screen.findByRole('dialog', { name: shotTexts.replaceTitle }));
    await expect(counts(context)).toHaveTextContent('Приёмок комплекта: 0.');
    await userEvent.click(dialog.getByRole('button', { name: shotTexts.replace }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Приёмок комплекта: 1.'));
    await expect(await screen.findByText(texts.acceptedKit.heading, {}, { timeout: 8000 })).toBeInTheDocument();
    await expect(context.canvasElement.ownerDocument.querySelectorAll('[data-plan-step]')).toHaveLength(0);
  }
};

export const StaticShotDissolvePan: Story = {
  tags: ['ci'],
  name: 'Сборка из опор: растворение всего кадра у состояния и панорама в параметрах',
  parameters: { songframe: options({ shots: staticShots }) },
  play: async (context) => {
    const screen = screenOf(context);
    const shotTexts = texts.staticShot;
    const panel = within(await screen.findByTestId('static-shot-panel', {}, POLL_TIMEOUT));
    // Растворение есть только у состояний: базовая опора видна сразу.
    const fields = panel.getAllByRole('spinbutton', { name: shotTexts.dissolve });
    await expect(fields).toHaveLength(1);
    const dissolve = fields[0];
    await expect(dissolve).toHaveValue(0);
    await expect(panel.getByText(shotTexts.dissolveOff)).toBeInTheDocument();
    // Секунды переводятся в кадры проекта; растворение дальше конца плана не проходит проверку.
    await userEvent.clear(dissolve);
    await userEvent.type(dissolve, '100');
    await expect(panel.getByRole('button', { name: shotTexts.build })).toBeDisabled();
    await userEvent.clear(dissolve);
    await userEvent.type(dissolve, '1.5');
    await expect(panel.getByText(shotTexts.dissolveOn({ frames: 45 }))).toBeInTheDocument();
    await expect(panel.getByRole('button', { name: shotTexts.build })).toBeEnabled();
    // Панорама — параметры сборки: по умолчанию окно по центру опоры, движения нет.
    await userEvent.click(panel.getByRole('button', { name: shotTexts.params }));
    await expect(panel.getByRole('spinbutton', { name: 'Панорама: начало, доля' })).toHaveValue(0.5);
    await expect(panel.getByRole('spinbutton', { name: 'Панорама: конец, доля' })).toHaveValue(0.5);
    // Сохранённое растворение возвращается из рецепта после перехода к другому плану.
    await userEvent.click(panel.getByRole('button', { name: commonTexts.save }));
    await waitFor(() => expect(panel.queryByText(shotTexts.dirty)).not.toBeInTheDocument());
    await userEvent.click(screen.getByText('M01', { selector: 'p' }));
    await shotHeading(context, 'M01');
    await userEvent.click(screen.getByText('M02', { selector: 'p' }));
    const reopened = within(await screen.findByTestId('static-shot-panel', {}, POLL_TIMEOUT));
    await expect(reopened.getByRole('spinbutton', { name: shotTexts.dissolve })).toHaveValue(1.5);
    // Опора открывается крупно в общей галерее, как на шаге «Опоры».
    await userEvent.click(reopened.getByRole('button', { name: componentsTexts.gallery.openLarge({ label: `K02: ${shotTexts.state({ index: 2 })}` }) }));
    const gallery = within(await screen.findByRole('dialog'));
    await expect(gallery.getByText(new RegExp(shotTexts.galleryKind))).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }
};

/** Попытка без вопроса и кандидатов: следующую опору создают или ставят своим файлом. */
const noCandidates = () =>
  keyframePackage({
    keyframeNotes: [],
    pendingDecision: null,
    keyframes: keyframePackage().keyframes.map((frame) => (frame.approved ? frame : { ...frame, imagePath: null }))
  });
export const OwnFrameFile: Story = {
  tags: ['ci'],
  name: 'Свой файл опоры · сразу кандидат и отдельный вопрос об утверждении',
  parameters: { songframe: options({ shots: () => baseShots({ attention: null, packages: [noCandidates()] }) }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(steps.now({ text: steps.chooseFrame({ frame: 'K02' }) }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    const frames = within(planStep(context, 'frames'));
    const generate = texts.productionFrameGenerationButton.prepareRequest({ frame: 'K02', title: testProviderInfo.title });
    await expect(await screen.findByRole('button', { name: generate })).toBeEnabled();
    const own = await frames.findAllByRole('button', { name: texts.frameActions.own });
    await expect(own).toHaveLength(3);
    await userEvent.click(own[0]);
    // Файл применяется без окна сравнения: решение принимается вопросом у самой опоры.
    await expect(await screen.findByText('Утвердить опору K02?', {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Своих файлов опор: 1.');
    await expect(counts(context)).toHaveTextContent('Утверждено опор: M02:K01.');
    await expect(await screen.findByRole('button', { name: texts.frameActions.other })).toBeDisabled();
    await expect(screen.getByRole('button', { name: approve('K02') })).toBeEnabled();
  }
};

export const FrameInstruction: Story = {
  tags: ['ci'],
  name: 'Указание к опоре · необязательно, сохраняется замечанием перед созданием',
  parameters: { songframe: options({ shots: () => baseShots({ attention: null, packages: [noCandidates()] }) }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(steps.now({ text: steps.chooseFrame({ frame: 'K02' }) }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    const frames = within(planStep(context, 'frames'));
    await userEvent.click(await frames.findByRole('button', { name: texts.frameActions.instructionOpen }));
    await userEvent.type(await frames.findByRole('textbox', { name: texts.frameActions.instruction }), 'Иван смотрит в камеру');
    await userEvent.click(
      screen.getByRole('button', { name: texts.productionFrameGenerationButton.prepareRequest({ frame: 'K02', title: testProviderInfo.title }) })
    );
    await waitFor(() => expect(counts(context)).toHaveTextContent('Указаний к опорам: K02/frame: Иван смотрит в камеру. Созданий опор: 1.'), POLL_TIMEOUT);
  }
};

export const CompositionSnapshot: Story = {
  tags: ['ci'],
  name: 'Схема композиции · снимок вида из камеры в шаге опор, выключатель попытки',
  parameters: {
    songframe: options({
      shots: () => baseShots({ attention: null, packages: [noCandidates()] }),
      composition: true,
      workflowView: () => ({ imageProvider: 'codex' })
    })
  },
  play: async (context) => {
    const screen = screenOf(context);
    const composition = productionTexts.composition;
    await expect(await screen.findByText(steps.now({ text: steps.chooseFrame({ frame: 'K02' }) }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    const frames = within(planStep(context, 'frames'));
    const toggle = await frames.findByRole('switch', { name: composition.label }, POLL_TIMEOUT);
    await expect(toggle).toBeChecked();
    await expect(frames.getByText(composition.ready)).toBeVisible();
    // Миниатюра снимка открывает общий просмотр изображений.
    await userEvent.click(frames.getByRole('button', { name: componentsTexts.gallery.openLarge({ label: composition.phases.start }) }));
    await expect(await screen.findByRole('dialog')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(toggle);
    await waitFor(() => expect(counts(context)).toHaveTextContent('Схема композиции: выкл.'), POLL_TIMEOUT);
    await expect(await frames.findByText(composition.off)).toBeVisible();
    await expect(frames.queryByRole('button', { name: componentsTexts.gallery.openLarge({ label: composition.phases.start }) })).not.toBeInTheDocument();
  }
};

export const CompositionDrawn: Story = {
  tags: ['ci'],
  name: 'Схема композиции · снимка ещё нет: интерфейс рисует и сохраняет его сам',
  parameters: {
    songframe: options({
      shots: () => baseShots({ attention: null, packages: [noCandidates()] }),
      composition: 'missing',
      workflowView: () => ({ imageProvider: 'codex' })
    })
  },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(steps.now({ text: steps.chooseFrame({ frame: 'K02' }) }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Снимок рисуется WebGL на отдельном холсте и уходит PNG; после сохранения вид отдаёт готовую миниатюру.
    await waitFor(() => expect(counts(context)).toHaveTextContent('Снимков: 1.'), POLL_TIMEOUT);
    const frames = within(planStep(context, 'frames'));
    await expect(await frames.findByText(productionTexts.composition.ready, {}, POLL_TIMEOUT)).toBeVisible();
  }
};

export const CompositionUsed: Story = {
  tags: ['ci'],
  name: 'Схема композиции · опоры приняты: снимок в пройденном шаге без выключателя',
  parameters: {
    songframe: options({
      shots: () =>
        baseShots({
          attention: null,
          packages: [
            {
              ...noCandidates(),
              keyframes: keyframePackage().keyframes.map((frame) => ({
                ...frame,
                imagePath: frame.imagePath ?? `${STORY_IMAGE_PATH}?frame=${frame.id}`,
                approved: true
              }))
            }
          ]
        }),
      composition: true,
      workflowView: () => ({ imageProvider: 'codex' })
    })
  },
  play: async (context) => {
    const screen = screenOf(context);
    const composition = productionTexts.composition;
    await waitFor(() => expect(planStep(context, 'prompt')).not.toBeNull(), POLL_TIMEOUT);
    // Пройденный шаг опор свёрнут: раскрывается щелчком по заголовку.
    await userEvent.click(within(planStep(context, 'frames')).getAllByRole('button')[0]);
    const frames = within(planStep(context, 'frames'));
    await expect(await frames.findByText(composition.usedHint, {}, POLL_TIMEOUT)).toBeVisible();
    await expect(frames.queryByRole('switch', { name: composition.label })).not.toBeInTheDocument();
    await userEvent.click(frames.getByRole('button', { name: componentsTexts.gallery.openLarge({ label: composition.phases.start }) }));
    await expect(await screen.findByRole('dialog')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Опору сравнивают наложением с другой опорой попытки или со снимком схемы композиции.
    await userEvent.click(frames.getAllByRole('button', { name: new RegExp(`^${componentsTexts.gallery.openLarge({ label: 'K01' })}`) })[0]);
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.click(dialog.getByRole('combobox', { name: componentsTexts.gallery.compareWith }));
    const listbox = within(await screen.findByRole('listbox'));
    await expect(listbox.getByRole('option', { name: composition.compareLabel({ phase: composition.phases.start }) })).toBeInTheDocument();
    await expect(listbox.getByRole('option', { name: /^K02/ })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }
};

/** Опора возвращена на доработку: подсказка советует создать её заново и уходит, пока опора создаётся. */
const returnedFrame = () => ({
  ...noCandidates(),
  stageLabel: 'Опора возвращена',
  decision: { stage: 'keyframes_review', verdict: 'revise', note: 'Камера ниже, ворота целиком в кадре.' }
});
export const FrameRevisionDuringJob: Story = {
  tags: ['ci'],
  name: 'Возвращённая опора · подсказка скрыта, пока опора создаётся заново',
  parameters: {
    songframe: options({
      shots: () => baseShots({ attention: null, packages: [returnedFrame()] }),
      frameJob: true,
      // Опоры создаёт агент: задание видно в виде попытки, пока оно идёт. Без задания доработка описания доступна.
      workflowView: () => ({ imageProvider: 'codex', canRevise: true })
    })
  },
  play: async (context) => {
    const screen = screenOf(context);
    const notice = texts.packageRevisionNotice;
    await expect(await screen.findByText(notice.frameTitle, {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(screen.getByText('Камера ниже, ворота целиком в кадре.')).toBeInTheDocument();
    // Кнопка подсказки называет то, что она открывает: доработку описания. Она появляется, когда вид процесса
    // загружен и доработка доступна, поэтому ждём её, а не только текст подсказки.
    await expect(await screen.findByRole('button', { name: notice.openPreparation }, POLL_TIMEOUT)).toBeEnabled();
    const codex = mediaProviderInfo('codex', 'image')?.title ?? '';
    await userEvent.click(await screen.findByRole('button', { name: texts.productionFrameGenerationButton.create({ frame: 'K02', title: codex }) }));
    const confirmation = within(
      await screen.findByRole('dialog', { name: texts.productionFrameGenerationButton.confirmTitle({ frame: 'K02', title: codex }) })
    );
    await expect(confirmation.getByText(texts.productionFrameGenerationButton.confirmDescription({ frame: 'K02', title: codex }))).toBeVisible();
    await userEvent.click(confirmation.getByRole('button', { name: texts.productionFrameGenerationButton.confirm({ frame: 'K02' }) }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Созданий опор: 1.'), POLL_TIMEOUT);
    // Опора уже создаётся: совет создать её заново и переход к доработке не показываются.
    await waitFor(() => expect(screen.queryByText(notice.frameTitle)).not.toBeInTheDocument(), POLL_TIMEOUT);
    await expect(screen.queryByRole('button', { name: notice.openPreparation })).not.toBeInTheDocument();
  }
};

export const GenerationStep: Story = {
  tags: ['ci'],
  name: 'Шаг генерации · ожидание сервиса, пройденный запрос читается',
  parameters: {
    songframe: options({
      receiving: true,
      shots: () => baseShots({ stageLabel: 'Получение результата', attention: null, packages: [receivingPackage('running')] })
    })
  },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(steps.now({ text: steps.waitService }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    const generation = within(planStep(context, 'generation'));
    await expect(generation.getByRole('progressbar', { name: steps.titles.generation })).toBeInTheDocument();
    await expect(generation.getByText(steps.generationWait)).toBeInTheDocument();
    // Запрос уже отправлен: шаг свёрнут в итог, а открытый только показывает материалы.
    const request = within(planStep(context, 'request'));
    await expect(request.getByText(steps.requestSummary({ credits: 12 }))).toBeInTheDocument();
    await userEvent.click(request.getByRole('button', { name: new RegExp(steps.titles.request) }));
    await expect(await request.findByText('Камера плавно приближается к старым воротам.')).toBeInTheDocument();
    await expect(within(planStep(context, 'result')).getByText(steps.after.result)).toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Отправок генерации: 0.');
  }
};

/** Опоры и видеопромпт утверждены, запроса ещё нет: следующий шаг собирает приложение без агента. */
function requestReadyShots(): ShotProduction[] {
  const source = preparedPackage();
  const ready = {
    ...source,
    stage: 'prompt_review',
    stageLabel: 'Видеопромпт утверждён',
    request: null,
    pendingDecision: null,
    decision: { stage: 'prompt_review', verdict: 'approve' },
    keyframes: source.keyframes.map((frame) => ({ ...frame, approved: true })),
    prompt: source.prompt ? { ...source.prompt, approved: true } : null
  };
  return baseShots({ stageLabel: ready.stageLabel, attention: null, packages: [ready] });
}

/** Кнопка без знака агента: ни значка выбранного агента, ни общего значка робота. */
async function expectNoAgentIcon(button: HTMLElement): Promise<void> {
  await expect(button.querySelector('img, [data-testid="SmartToyOutlinedIcon"]')).toBeNull();
}

export const RequestByApp: Story = {
  tags: ['ci'],
  name: 'Запрос без агента · подготовка приложением и «Изменить» модель и параметры',
  parameters: { songframe: options({ shots: requestReadyShots }) },
  play: async (context) => {
    const screen = screenOf(context);
    const panel = texts.productionWorkflowPanel;
    const change = texts.requestChangeDialog;
    await expect(await screen.findByText(steps.now({ text: steps.prepareRequest }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    const step = within(planStep(context, 'request'));
    const prepare = await step.findByRole('button', { name: panel.prepareRequest });
    await expectNoAgentIcon(prepare);
    await userEvent.click(prepare);
    await expect(await screen.findByText(steps.now({ text: steps.sendRequest }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    await waitFor(() => expect(counts(context)).toHaveTextContent('Запросов приложения: test-video-fast.'), POLL_TIMEOUT);
    // На вопросе «Отправить» доработка — «Изменить» без агента, поля замечания нет.
    await expect(step.queryByRole('button', { name: panel.reviseNow })).not.toBeInTheDocument();
    const open = await step.findByRole('button', { name: change.open });
    await expectNoAgentIcon(open);
    await userEvent.click(open);
    const dialog = within(await screen.findByRole('dialog', { name: change.title({ shot: 'M02' }) }));
    const model = await dialog.findByRole('combobox', { name: change.model });
    await expect(model).toHaveTextContent('test-video-fast');
    await expect(dialog.getByText(change.noParameters)).toBeInTheDocument();
    // Без изменений собирать запрос заново незачем.
    await expect(dialog.getByRole('button', { name: change.confirm })).toBeDisabled();
    await userEvent.click(model);
    // Модель, которая план не примет, выключена с причиной.
    await expect(await screen.findByRole('option', { name: /test-video-short/ })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(await screen.findByRole('option', { name: 'test-video-pro' }));
    const audio = await dialog.findByRole('combobox', { name: 'enable_audio' });
    await expect(audio).toHaveTextContent(change.no);
    await userEvent.click(audio);
    await userEvent.click(await screen.findByRole('option', { name: change.yes }));
    await userEvent.click(dialog.getByRole('button', { name: change.confirm }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: change.title({ shot: 'M02' }) })).not.toBeInTheDocument(), POLL_TIMEOUT);
    await waitFor(() => expect(counts(context)).toHaveTextContent('Запросов приложения: test-video-fast, test-video-pro enable_audio=true.'), POLL_TIMEOUT);
    await expect(await screen.findByText(texts.useProductionWorkflow.requestChanged)).toBeInTheDocument();
    // Повторное открытие показывает уже изменённый запрос.
    await userEvent.click(await step.findByRole('button', { name: change.open }));
    const reopened = within(await screen.findByRole('dialog', { name: change.title({ shot: 'M02' }) }));
    await expect(await reopened.findByRole('combobox', { name: change.model })).toHaveTextContent('test-video-pro');
    await expect(reopened.getByRole('combobox', { name: 'enable_audio' })).toHaveTextContent(change.yes);
    await userEvent.click(reopened.getByRole('button', { name: commonTexts.cancel }));
  }
};

/** Речевой план у провайдера без липсинка: опора и промпт утверждены, срез речи готов, пакет ещё не собран. */
function manualShots(): ShotProduction[] {
  const source = preparedPackage();
  const ready = {
    ...source,
    stage: 'prompt_review',
    stageLabel: 'Видеопромпт утверждён',
    request: null,
    pendingDecision: null,
    decision: { stage: 'prompt_review', verdict: 'approve' },
    keyframes: source.keyframes.filter((frame) => frame.role === 'first').map((frame) => ({ ...frame, approved: true })),
    prompt: source.prompt ? { ...source.prompt, approved: true } : null,
    speech: { path: `${source.dir}/audio/speech.wav`, recipe: `${source.dir}/audio/audio-recipe.json`, start: 12, end: 17, lines: [] }
  };
  return baseShots({ lipsync: true, stageLabel: ready.stageLabel, attention: null, packages: [ready] });
}

export const ManualGeneration: Story = {
  tags: ['ci'],
  name: 'Ручная генерация · сборка пакета, загрузка видео и вопрос о результате',
  parameters: { songframe: options({ manual: true, shots: manualShots }) },
  play: async (context) => {
    const screen = screenOf(context);
    const manual = texts.manualGeneration;
    await expect(await screen.findByText(steps.now({ text: steps.buildManual }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Вместо запроса и генерации — один шаг ручной генерации; платной отправки нет.
    await expect(planStep(context, 'generation')).toBeNull();
    // Свёрнутый шаг «Речь» называет границы готового среза.
    await expect(
      within(planStep(context, 'speech')).getByText(
        steps.speechSummary({ start: formatClock(12), end: formatClock(17), seconds: texts.productionSpeechPanel.seconds(5) })
      )
    ).toBeInTheDocument();
    const step = within(planStep(context, 'request'));
    await expect(step.getByText(steps.titles.manual)).toBeInTheDocument();
    await userEvent.click(await step.findByRole('button', { name: manual.build }));
    await expect(await step.findByText(manual.built, {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(step.getByRole('link', { name: 'https://example.test/avatar' })).toBeInTheDocument();
    await expect(await screen.findByText(steps.now({ text: steps.uploadManual }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    await userEvent.click(step.getByRole('button', { name: new RegExp(manual.zone) }));
    await step.findByText(manual.chosen({ name: STORY_VIDEO_PATH.split('/').pop()! }));
    await userEvent.type(step.getByRole('textbox', { name: new RegExp(manual.source) }), 'Тестовый сервис на сайте');
    await userEvent.type(step.getByRole('spinbutton', { name: manual.cost }), '75');
    await userEvent.click(step.getByRole('button', { name: manual.upload }));
    // После загрузки сразу открывается приёмка; отмена оставляет вопрос о результате открытым.
    const offer = await screen.findByRole('dialog', { name: texts.acceptResultDialog.title({ shot: 'M02' }) }, POLL_TIMEOUT);
    await userEvent.click(within(offer).getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Сведения о видео остаются у результата, «Принять» — сразу под ним.
    await expect(await screen.findByText(steps.now({ text: steps.reviewResult }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(await within(planStep(context, 'result')).findByText(/Источник: Тестовый сервис на сайте · Стоимость: 75 кредитов/)).toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Отправок генерации: 0.');
    await expect(counts(context)).toHaveTextContent('Пакетов ручной генерации: 1. Загрузок видео: 1.');
  }
};

export const OwnVideo: Story = {
  tags: ['ci'],
  name: 'Своё видео · новая попытка сразу получает результат, приёмка открывается сама',
  parameters: { songframe: options({}, '/project/production?shot=M04') },
  play: async (context) => {
    const screen = screenOf(context);
    const own = texts.ownVideo;
    const manual = texts.manualGeneration;
    await shotHeading(context, 'M04');
    await userEvent.click(await screen.findByRole('button', { name: own.open }, POLL_TIMEOUT));
    const dialog = within(await screen.findByRole('dialog', { name: own.title({ shot: 'M04' }) }));
    await expect(dialog.getByText(own.format)).toBeVisible();
    // Без файла и источника загрузить нечего: причина видна на кнопке.
    const upload = dialog.getByRole('button', { name: manual.upload });
    await expect(upload).toBeDisabled();
    await userEvent.hover(upload.parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent(manual.fileRequired);
    await userEvent.click(dialog.getByRole('button', { name: new RegExp(manual.zone) }));
    await dialog.findByText(manual.chosen({ name: STORY_VIDEO_PATH.split('/').pop()! }));
    await userEvent.type(dialog.getByRole('textbox', { name: new RegExp(manual.source) }), 'Сайт сервиса');
    await userEvent.type(dialog.getByRole('spinbutton', { name: manual.cost }), '300');
    // Видео сделано по одной опоре: вход и промпт из раздела «Как сделано видео» уходят в Go вместе с видео.
    await userEvent.click(dialog.getByRole('button', { name: new RegExp(own.generation.heading) }));
    await userEvent.click(await dialog.findByRole('button', { name: new RegExp(`^${own.generation.zone}`) }));
    await expect(await dialog.findByRole('listitem', { name: new RegExp(`^${own.generation.input({ index: 1 })}:`) })).toBeInTheDocument();
    await userEvent.type(dialog.getByRole('textbox', { name: own.generation.prompt }), 'Камера наезжает');
    await waitFor(() => expect(dialog.getByRole('button', { name: manual.upload })).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', { name: manual.upload }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Своих видео: 1. Входов своих видео: first:story-image.png + промпт.'), POLL_TIMEOUT);
    // Загрузка закончена — сразу предлагается приёмка. Отмена не принимает и не снимает вопрос о результате.
    const offer = await screen.findByRole('dialog', { name: texts.acceptResultDialog.title({ shot: 'M04' }) }, POLL_TIMEOUT);
    await userEvent.click(within(offer).getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Путь короткий: «Своё видео» и «Результат»; описания, опор и промпта нет.
    await expect(await screen.findByText(steps.now({ text: steps.reviewResult }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(planStep(context, 'description')).toBeNull();
    await expect(planStep(context, 'frames')).toBeNull();
    await expect(planStep(context, 'prompt')).toBeNull();
    await expect(within(planStep(context, 'request')).getByText(steps.titles.ownVideo)).toBeInTheDocument();
    const result = within(planStep(context, 'result'));
    await expect(await result.findByText(/Источник: Сайт сервиса · Стоимость: 300 кредитов/)).toBeInTheDocument();
    // Своё видео не повторяется по запросу и не дорабатывается агентом.
    await expect(result.getByRole('button', { name: texts.verdictLabels.accept })).toBeEnabled();
    await expect(result.getByRole('button', { name: texts.verdictLabels.review })).toBeEnabled();
    await expect(result.queryByRole('button', { name: texts.verdictLabels.retry })).not.toBeInTheDocument();
    await expect(result.queryByRole('button', { name: texts.verdictLabels.revise })).not.toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Отправок генерации: 0.');
    // Решение стоит сразу под загруженным видео, раньше кнопки другого файла.
    const order = result.getByRole('button', { name: texts.verdictLabels.accept }).compareDocumentPosition(result.getByRole('button', { name: own.replace }));
    await expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Не то видео: «Загрузить другой файл» до приёмки меняет загруженное, источник берётся из новой формы.
    await userEvent.click(result.getByRole('button', { name: own.replace }));
    const replace = within(await screen.findByRole('dialog', { name: own.replaceTitle({ shot: 'M04' }) }));
    await expect(replace.getByText(own.replaceIntro)).toBeVisible();
    // Замена файла входы генерации и промпт попытки не меняет: раздела о них нет.
    await expect(replace.queryByRole('button', { name: new RegExp(own.generation.heading) })).not.toBeInTheDocument();
    await userEvent.click(replace.getByRole('button', { name: new RegExp(manual.zone) }));
    await replace.findByText(manual.chosen({ name: STORY_VIDEO_PATH.split('/').pop()! }));
    await userEvent.type(replace.getByRole('textbox', { name: new RegExp(manual.source) }), 'Нужный дубль');
    await waitFor(() => expect(replace.getByRole('button', { name: manual.upload })).toBeEnabled());
    await userEvent.click(replace.getByRole('button', { name: manual.upload }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Замен видео: 1.'), POLL_TIMEOUT);
    // После замены файла приёмка снова открывается сама; здесь её тоже откладывают.
    const again = await screen.findByRole('dialog', { name: texts.acceptResultDialog.title({ shot: 'M04' }) }, POLL_TIMEOUT);
    await userEvent.click(within(again).getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(await within(planStep(context, 'result')).findByText(/Источник: Нужный дубль/, {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Сводка заменённого видео пересобрана под тем же именем: адрес кадра несёт новый токен результата.
    await waitFor(() => {
      const sources = [...planStep(context, 'result').querySelectorAll('img')].map((image) => image.getAttribute('src') ?? '');
      expect(sources.some((source) => source.includes('story-image.png?v='))).toBe(true);
      expect(sources.every((source) => !source.includes('story-image.png') || /\?v=manual-result-\d+$/.test(source))).toBe(true);
    }, POLL_TIMEOUT);
  }
};

export const OwnVideoMenu: Story = {
  name: 'Своё видео · из меню плана с попытками, окно закрывается только отменой',
  parameters: { songframe: options({ manual: true, shots: manualShots }) },
  play: async (context) => {
    const screen = screenOf(context);
    const own = texts.ownVideo;
    await expect(await screen.findByText(steps.now({ text: steps.buildManual }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    const menu = await openMenu(context);
    await userEvent.click(menu.getByRole('menuitem', { name: steps.ownVideo }));
    const dialog = await screen.findByRole('dialog', { name: own.title({ shot: 'M02' }) });
    // Окно закрывается только кнопкой отмены: черновик видео не теряется случайным щелчком.
    await expectImplicitCloseBlocked(dialog);
    await userEvent.click(screen.getByRole('button', { name: commonTexts.cancel }));
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Своих видео: 0.');
  }
};

export const SpeechRequest: Story = {
  tags: ['ci'],
  name: 'Речевой план · срез речи повторяется в шаге запроса',
  parameters: { songframe: options({ shots: manualShots }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(steps.now({ text: steps.prepareRequest }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    const slice = texts.productionSpeechPanel.ready({ start: formatClock(12), end: formatClock(17), seconds: texts.productionSpeechPanel.seconds(5) });
    await expect(within(planStep(context, 'speech')).getByText(/^Срез готов: /)).toBeInTheDocument();
    // Шаг «Речь» свёрнут: тот же срез с плеером виден в запросе, чтобы прослушать его перед отправкой.
    const request = within(planStep(context, 'request'));
    await expect(request.getByText(slice)).toBeInTheDocument();
    await expect(planStep(context, 'request').querySelector('audio')).toHaveAttribute('src', expect.stringContaining('media/'));
  }
};

export const GenerationInterrupted: Story = {
  tags: ['ci'],
  name: 'Шаг генерации · после перезапуска ждать нечего, результат забирает кнопка',
  parameters: {
    songframe: options({
      shots: () => baseShots({ stageLabel: 'Получение результата', attention: null, packages: [receivingPackage('running')] })
    })
  },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(steps.now({ text: steps.receiveResult }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    const generation = within(planStep(context, 'generation'));
    await expect(generation.queryByRole('progressbar')).not.toBeInTheDocument();
    await expect(generation.queryByText(steps.generationWait)).not.toBeInTheDocument();
    await expect(await generation.findByRole('button', { name: texts.packageResume.resume })).toBeInTheDocument();
  }
};

const acceptedOptions = (model: Partial<ProductionPageModelOptions> = {}, extra: Partial<ShotProduction> = {}) =>
  options(
    {
      ...model,
      shots: () => [
        pageShot('M01', {
          ...extra,
          title: 'Подъезд к даче',
          start: 0,
          end: 6,
          asset: {
            dir: '/mock/assets/shots/M01',
            video: '/mock/story-derived-source-150.mp4',
            original: STORY_VIDEO_PATH,
            originalMedia: '1904×1072, 30/1 FPS, кадров: 120, 4.00 с',
            edit: {
              fps: 30,
              frames: 102,
              duration: 3.4,
              sourceInterval: [0, 3.4],
              stillAt: null,
              speed: '1',
              speedParts: [],
              holdFirst: 0,
              holdLast: 0,
              note: ''
            }
          }
        })
      ]
    },
    '/project/production?shot=M01'
  );
/** Комплект принятого речевого плана с ручной генерацией: источник, примечание, опора, промпт и срез речи. */
const manualKit = (): AcceptedKit => ({
  provider: TEST_PROVIDER,
  generationId: null,
  manualGeneration: {
    source: 'Сайт сервиса',
    original_name: 'avatar_0.mp4',
    attached_at: '2026-11-11T21:08:28Z',
    cost: { amount: 38, unit: 'credits' },
    description: 'Точно следовал инструкции. Попыток: 1.'
  },
  prompt: 'Средний план спереди, камера плавно приближается; губы точно совпадают с исполнением в аудио.',
  images: [{ path: STORY_IMAGE_PATH, role: texts.inputRoles.first }],
  speech: { path: STORY_TRACK_PATH, start: 23.267, end: 27.267 }
});

export const AcceptedPlan: Story = {
  tags: ['ci'],
  name: 'Принятый план · комплект вместо пустых шагов и новая попытка из меню',
  parameters: { songframe: acceptedOptions({ acceptedKit: manualKit }) },
  play: async (context) => {
    const screen = screenOf(context);
    const kit = texts.acceptedKit;
    await expect(await screen.findByText(steps.finished, {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Пакета попытки после приёмки нет: шаги с пустыми итогами не показываются, только принятый комплект.
    await expect(await screen.findByText(kit.heading)).toBeInTheDocument();
    await expect(context.canvasElement.ownerDocument.querySelectorAll('[data-plan-step]')).toHaveLength(0);
    await expect(screen.getAllByRole('button', { name: componentsTexts.videoPlayer.fullscreen })).toHaveLength(2);
    // Два видео нельзя перепутать: у каждого своя подпись.
    await expect(screen.getByText(texts.productionShotCard.acceptedVideo)).toBeInTheDocument();
    await expect(screen.getByText(texts.productionShotCard.originalVideo)).toBeInTheDocument();
    // Под плеерами — параметры оригинала и что взято в принятый участок.
    await expect(screen.getByText('1904×1072, 30/1 FPS, кадров: 120, 4.00 с')).toBeInTheDocument();
    // У принятого участка тот же вид; размер кадра сообщает само видео после загрузки.
    await expect(await screen.findByText(/^\d+×\d+, 30\/1 FPS, кадров: 102, 3\.40 с · участок оригинала 0\.00–3\.40 с$/, {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Как получено видео: источник, стоимость и примечание ручной генерации из комплекта.
    await expect(await screen.findByText(/^Источник: Сайт сервиса · Стоимость: 38 кредитов · Загружено .* из avatar_0\.mp4$/)).toBeInTheDocument();
    await expect(screen.getByText('Точно следовал инструкции. Попыток: 1.')).toBeInTheDocument();
    // Единственная опора — первый кадр; она открывается в общем просмотре изображений, как опоры в пакете попытки.
    const first = kit.image({ index: 1, role: texts.inputRoles.first });
    await expect(screen.getByText(first)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: componentsTexts.gallery.openLarge({ label: first }) }));
    const viewer = await screen.findByRole('dialog');
    await expect(within(viewer).getByRole('img', { name: first })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(screen.getByText(/губы точно совпадают с исполнением в аудио/)).toBeInTheDocument();
    await expect(screen.getByRole('button', { name: kit.copy })).toBeEnabled();
    // Срез показан общим блоком среза речи с плеером.
    const speech = texts.productionSpeechPanel.ready({ start: formatClock(23.267), end: formatClock(27.267), seconds: texts.productionSpeechPanel.seconds(4) });
    await expect(screen.getByText(speech)).toBeInTheDocument();
    await userEvent.click((await openMenu(context)).getByRole('menuitem', { name: steps.newAttempt }));
    // Новый заход начинается с описания: принятый комплект не показывается как результат этой попытки.
    await expect(await within(planStep(context, 'description')).findByRole('button', { name: texts.productionWorkflowPanel.prepare })).toBeEnabled();
    await expect(screen.queryByText(kit.heading)).not.toBeInTheDocument();
  }
};

export const AcceptedPlanRecut: Story = {
  tags: ['ci'],
  name: 'Принятый план · «Изменить участок» у плеера принятого участка, из оригинала комплекта с прежним участком',
  parameters: { songframe: acceptedOptions({ acceptedKit: manualKit }) },
  play: async (context) => {
    const screen = screenOf(context);
    const dialogTexts = texts.acceptResultDialog;
    await expect(await screen.findByText(texts.acceptedKit.heading, {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Кнопка относится к принятому участку: стоит у его плеера рядом с «Взять текущий кадр», а не у оригинала.
    const recut = screen.getByRole('button', { name: texts.acceptedKit.recut });
    const accepted = screen.getByText(texts.productionShotCard.acceptedVideo).closest('.MuiChip-root')!.parentElement!;
    await expect(within(accepted).getByRole('button', { name: texts.acceptedKit.recut })).toBe(recut);
    await expect(within(recut.parentElement!).getByRole('button', { name: texts.acceptedKit.takeFrame })).toBeInTheDocument();
    await userEvent.click(recut);
    const dialog = within(await screen.findByRole('dialog'));
    await expect(dialog.getByText(dialogTexts.recutTitle({ shot: 'M01' }))).toBeInTheDocument();
    // Окно открыто с прежним участком комплекта; выбора «целиком» и согласия на замену нет.
    await expect(dialog.getByRole('spinbutton', { name: dialogTexts.cutEnd })).toHaveValue(3.4);
    await expect(dialog.queryByRole('combobox', { name: dialogTexts.section })).not.toBeInTheDocument();
    await expect(dialog.queryByRole('checkbox')).not.toBeInTheDocument();
    await expect(dialog.getByText(dialogTexts.recutConsequences)).toBeInTheDocument();
    // Окно плана 6 с — 180 кадров: удержание первого кадра и подгонка конца.
    await userEvent.clear(dialog.getByRole('spinbutton', { name: dialogTexts.holdFirst }));
    await userEvent.type(dialog.getByRole('spinbutton', { name: dialogTexts.holdFirst }), '30');
    await userEvent.click(dialog.getByRole('button', { name: dialogTexts.fitEnd }));
    await expect(dialog.getByRole('spinbutton', { name: dialogTexts.cutEnd })).toHaveValue(5);
    await userEvent.click(dialog.getByRole('button', { name: dialogTexts.preview }));
    await expect(await dialog.findByTestId('cut-preview')).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: dialogTexts.recutConfirm }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(await screen.findByText(/Новых участков: 1/, {}, POLL_TIMEOUT)).toHaveTextContent('"holdFirst":30');
    // После задания подпись принятого участка — по новому рецепту.
    await expect(await screen.findByText(/участок оригинала 0\.00–5\.00 с/, {}, POLL_TIMEOUT)).toBeInTheDocument();
  }
};
export const AcceptedPlanTakeFrame: Story = {
  tags: ['ci'],
  name: 'Принятый план · «Взять текущий кадр» у плеера принятого участка, без эффектов, и папка с кадром',
  parameters: { songframe: acceptedOptions({ acceptedKit: manualKit }) },
  play: async (context) => {
    const screen = screenOf(context);
    const kit = texts.acceptedKit;
    await expect(await screen.findByText(kit.heading, {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Плеер стоит в начале: берётся кадр 0 принятого видео.
    const take = () => screen.getByRole('button', { name: kit.takeFrame });
    await waitFor(() => expect(take()).toBeEnabled(), POLL_TIMEOUT);
    // Кнопка стоит у плеера «Принятый участок», рядом с его «На весь экран», а не у оригинала.
    const accepted = screen.getByText(texts.productionShotCard.acceptedVideo).closest('.MuiChip-root')!.parentElement!;
    await expect(within(accepted).getByRole('button', { name: kit.takeFrame })).toBe(take());
    await expect(within(take().parentElement!).getByRole('button', { name: componentsTexts.videoPlayer.fullscreen })).toBeInTheDocument();
    await userEvent.click(take());
    const alert = await screen.findByText(/^Кадр 0 \(0,00 с\) принятого участка без эффектов сохранён: \/mock\/Загрузки\/.+\/M01-кадр-0000\.png$/);
    await expect(await screen.findByText(/Взятых кадров: M01:0\./)).toBeInTheDocument();
    // «Открыть папку» сообщения открывает папку кадров клипа, а не комплекта.
    const message = alert.closest('[role="alert"]') as HTMLElement;
    await userEvent.click(within(message).getByRole('button', { name: kit.openFolder }));
    await expect(await screen.findByText(/Открытых папок: \/mock\/Загрузки\//)).toBeInTheDocument();
  }
};
export const AcceptedPlanProposal: Story = {
  tags: ['ci'],
  name: 'Принятый план · предложение новой попытки открыто без выбора в меню',
  parameters: {
    songframe: acceptedOptions(
      {
        acceptedKit: manualKit,
        workflowView: (shot, packageDir) => (shot === 'M01' && !packageDir ? { proposal: workflowProposal('description') } : {})
      },
      { proposal: { stage: 'description', status: 'ready', stale: false, packageDir: null } }
    )
  },
  play: async (context) => {
    const screen = screenOf(context);
    // После перезапуска выбор «Новая подготовка» не запомнен: её открывает само ожидающее предложение.
    const step = await waitFor(() => {
      const element = planStep(context, 'description');
      if (!element) throw new Error('Шаг «Описание» не показан');
      return element;
    }, POLL_TIMEOUT);
    const description = within(step);
    await expect(await description.findByRole('button', { name: texts.productionProposalDialog.open }, POLL_TIMEOUT)).toBeEnabled();
    await expect(screen.queryByText(texts.acceptedKit.heading)).not.toBeInTheDocument();
  }
};

export const AcceptedProviderPlan: Story = {
  tags: ['ci'],
  name: 'Принятый план · сгенерирован сервисом по двум опорам, папка комплекта, расход с отклонённым вариантом',
  parameters: {
    songframe: acceptedOptions({
      acceptedKit: () => ({
        provider: TEST_PROVIDER,
        generationId: 'gen-42',
        prompt: 'Камера плавно приближается к старым воротам.',
        // Роль второй опоры не записана: подпись «Последний кадр» следует из позиции.
        images: [
          { path: '/mock/assets/shots/M01/generation-input-1/story-image.png', role: texts.inputRoles.first },
          { path: '/mock/assets/shots/M01/generation-input-2/story-image.png', role: null }
        ],
        speech: null
      }),
      // Две отправки видео по 13 кредитов, принята вторая: 26 кредитов на 5 с материала.
      spend: (shot) => ({
        ...emptySpend(),
        attempts: 2,
        videos: 2,
        rejected: 1,
        acceptedSeconds: 5,
        entries: [
          spendEntry(shot, { provider: TEST_PROVIDER, amount: 13, unit: 'credits', removed: true }),
          spendEntry(shot, { provider: TEST_PROVIDER, amount: 13, unit: 'credits', accepted: true, removed: true })
        ]
      })
    })
  },
  play: async (context) => {
    const screen = screenOf(context);
    const kit = texts.acceptedKit;
    await expect(await screen.findByText(kit.heading, {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(await screen.findByText(kit.provider({ provider: testProviderInfo.title, id: 'gen-42' }))).toBeInTheDocument();
    await expect(screen.getByText('Камера плавно приближается к старым воротам.')).toBeInTheDocument();
    // Без перевода — один текст, без переключателя вариантов.
    await expect(screen.queryByRole('group', { name: texts.promptVariants.view })).not.toBeInTheDocument();
    // Две опоры по порядку входов: первая — первый кадр, последняя — последний; каждая открывается крупно.
    await expect(screen.getByText(kit.images)).toBeInTheDocument();
    const first = kit.image({ index: 1, role: texts.inputRoles.first });
    const last = kit.image({ index: 2, role: texts.inputRoles.last });
    await expect(screen.getByText(first)).toBeInTheDocument();
    await expect(screen.getByText(last)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: componentsTexts.gallery.openLarge({ label: last }) }));
    const viewer = await screen.findByRole('dialog');
    await expect(within(viewer).getByRole('img', { name: last })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // «Открыть папку» показывает папку комплекта плана в файловом менеджере.
    await userEvent.click(screen.getByRole('button', { name: kit.openFolder }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Открытых папок: /mock/assets/shots/M01.'));
    await expect(screen.queryByText(/^Срез речи/)).not.toBeInTheDocument();
    // Расход плана бейджем в карточке: попытки удалены приёмкой, но отправки учтены журналом.
    // Список планов сумм не показывает, только пометки о неполном расходе — здесь их нет.
    const spend = texts.shotSpend;
    await expect(within(screen.getByTestId('shot-spend')).getByText('26 кредитов')).toBeInTheDocument();
    await expect(screen.getAllByTestId('spend-chips')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: spend.open }));
    const dialog = within(await screen.findByRole('dialog', { name: /^Расход M\d+/ }));
    await expect(dialog.getByText(spend.sends({ attempts: 2, removed: 0, videos: 2, images: 0, manual: 0 }))).toBeInTheDocument();
    await expect(dialog.getByText(spend.acceptedTotal({ seconds: '5,00', rejected: 1 }))).toBeInTheDocument();
    await expect(dialog.getByText(`${spend.perSecond}: 5,2 кредита (${testProviderInfo.title})`)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: spend.close }));
  }
};
export const AcceptedPromptVariants: Story = {
  tags: ['ci'],
  name: 'Принятый план · отправлен перевод видеопромпта, оригинал рядом, копируется показанный',
  parameters: {
    songframe: acceptedOptions({
      acceptedKit: () => ({
        provider: TEST_PROVIDER,
        generationId: 'gen-43',
        prompt: STORY_PROMPT_TRANSLATION,
        promptVariants: { original: STORY_PROMPT_ORIGINAL, translation: STORY_PROMPT_TRANSLATION, selected: 'translation' },
        images: [],
        speech: null
      })
    })
  },
  play: async (context) => {
    const screen = screenOf(context);
    const kit = texts.acceptedKit;
    const variants = texts.promptVariants;
    await expect(await screen.findByText(kit.heading, {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Сначала показан отправленный вариант с отметкой.
    await expect(await screen.findByText(STORY_PROMPT_TRANSLATION)).toBeInTheDocument();
    await expect(screen.getByText(variants.sent({ translation: true }))).toBeInTheDocument();
    const writes: string[] = [];
    const original = navigator.clipboard?.writeText;
    if (navigator.clipboard) navigator.clipboard.writeText = async (text: string) => void writes.push(text);
    try {
      await userEvent.click(screen.getByRole('button', { name: variants.original }));
      await expect(screen.getByText(STORY_PROMPT_ORIGINAL)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: kit.copy }));
      await waitFor(() => expect(writes).toEqual([STORY_PROMPT_ORIGINAL]));
    } finally {
      if (navigator.clipboard && original) navigator.clipboard.writeText = original;
    }
  }
};
export const AcceptedOwnVideo: Story = {
  tags: ['ci'],
  name: 'Принятый план · своё видео без опор, промпта и среза речи',
  parameters: {
    songframe: acceptedOptions({
      acceptedKit: () => ({
        provider: 'manual',
        generationId: null,
        ownVideo: true,
        manualGeneration: { source: 'Снято на телефон', original_name: 'phone.mp4', attached_at: '2026-11-12T19:00:00Z', cost: null, description: null },
        prompt: '',
        images: [],
        speech: null
      }),
      // Своё видео без цены: пометка видна и в списке планов, и в карточке.
      spend: (shot) => ({
        ...emptySpend(),
        attempts: 1,
        videos: 1,
        manual: 1,
        acceptedSeconds: 6,
        entries: [spendEntry(shot, { status: 'manual', accepted: true, editable: true, removed: true })]
      })
    })
  },
  play: async (context) => {
    const screen = screenOf(context);
    const kit = texts.acceptedKit;
    await expect(await screen.findByText(kit.heading, {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(await screen.findByText(kit.ownVideo)).toBeInTheDocument();
    const chips = screen.getAllByTestId('spend-chips');
    await expect(chips).toHaveLength(2);
    for (const item of chips) await expect(within(item).getByText(texts.shotSpend.chipUnpriced)).toBeInTheDocument();
    await expect(screen.getByText(/^Источник: Снято на телефон · Загружено .* из phone\.mp4$/)).toBeInTheDocument();
    // Пустые разделы не показываются: опор, промпта и среза у своего видео нет.
    await expect(screen.queryByText(kit.images)).not.toBeInTheDocument();
    await expect(screen.queryByRole('button', { name: new RegExp(texts.inputRoles.first) })).not.toBeInTheDocument();
    await expect(screen.queryByText(kit.prompt)).not.toBeInTheDocument();
    await expect(screen.queryByRole('button', { name: kit.copy })).not.toBeInTheDocument();
    // Папка комплекта открывается и без опор: в ней лежат видео и оригинал.
    await expect(screen.getByRole('button', { name: kit.openFolder })).toBeEnabled();
  }
};
export const AcceptedOwnVideoGenerated: Story = {
  tags: ['ci'],
  name: 'Принятый план · своё видео по одной опоре с промптом, указанными при загрузке',
  parameters: {
    songframe: acceptedOptions({
      acceptedKit: () => ({
        provider: 'manual',
        generationId: null,
        ownVideo: true,
        manualGeneration: { source: 'Сайт сервиса', original_name: 'site.mp4', attached_at: '2026-11-12T19:00:00Z', cost: null, description: null },
        prompt: 'Камера медленно наезжает на героя',
        // Роль, выбранная при загрузке, показывается как записана, а не по позиции единственной опоры.
        images: [{ path: STORY_IMAGE_PATH, role: texts.inputRoles.middle }],
        speech: null
      })
    })
  },
  play: async (context) => {
    const screen = screenOf(context);
    const kit = texts.acceptedKit;
    await expect(await screen.findByText(kit.heading, {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Опора и промпт своего видео показываются, как у обычной генерации; подпись источника их не отрицает.
    await expect(await screen.findByText(kit.ownVideoGenerated)).toBeInTheDocument();
    await expect(screen.queryByText(kit.ownVideo)).not.toBeInTheDocument();
    await expect(screen.getByText(kit.images)).toBeInTheDocument();
    await expect(
      screen.getByRole('button', { name: componentsTexts.gallery.openLarge({ label: kit.image({ index: 1, role: texts.inputRoles.middle }) }) })
    ).toBeInTheDocument();
    await expect(screen.getByText(kit.prompt)).toBeInTheDocument();
    await expect(screen.getByText('Камера медленно наезжает на героя')).toBeInTheDocument();
    await expect(screen.getByRole('button', { name: kit.copy })).toBeInTheDocument();
  }
};
export const Empty: Story = {
  name: 'Планов ещё нет · переход к сценарию',
  parameters: { songframe: options({ shots: () => [], problems: ['Планов пока нет: утвердите сценарий на странице «Сценарий».'] }) },
  play: async (context) => {
    const screen = screenOf(context);
    await pageReady(context);
    await expect(screen.queryByText(texts.productionPage.chooseShot)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: '«Сценарий»' }));
    await waitFor(() => expect(route(context)).toHaveTextContent(/^\/project\/scenario$/));
  }
};

/** У двух планов и двух попыток M02 разные ключи отчётов, хотя все медиа принадлежат витрине. */
const reviewShots = () => {
  const first = receivedPackage('video', { previews: true });
  const otherDir = first.dir.replace('attempt-01', 'attempt-02');
  const second = JSON.parse(JSON.stringify(first).replaceAll(first.dir, otherDir)) as typeof first;
  second.relative = first.relative.replace('attempt-01', 'attempt-02');
  return [
    pageShot('M01', { state: 'progress', stageLabel: 'Результат получен', asset: null, attention: null, packages: [packageForShot(first, 'M01')] }),
    pageShot('M02', { state: 'progress', stageLabel: 'Результат получен', asset: null, attention: null, packages: [first, second] })
  ];
};
const reviewPanel = async (context: Context) => within(await screenOf(context).findByRole('region', { name: videoReviewTexts.heading }, POLL_TIMEOUT));
const reviewCounts = (context: Context) => screenOf(context).getByTestId('production-review-model');
/** У карточек есть собственные видео-превью; в этой фикстуре единственный плеер с controls принадлежит оригиналу попытки. */
async function originalVideo(context: Context): Promise<HTMLVideoElement> {
  const videos = context.canvasElement.querySelectorAll<HTMLVideoElement>('video[controls]');
  await expect(videos).toHaveLength(1);
  return videos[0];
}
async function chooseReviewPackage(context: Context, second = false) {
  const screen = screenOf(context);
  const name = attemptName(steps.attempt({ number: second ? '2' : '1' }), receivedPackage('video').stageLabel);
  await userEvent.click(attemptSelect(context));
  await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name }));
  return reviewPanel(context);
}
const reviewOptions = (videoReview: ProductionPageModelOptions['videoReview'] = {}, ffmpegMissing = false) =>
  productionPageOptions({ shots: reviewShots, videoReview, ffmpegMissing }, '/project/production?shot=M02');

export const VideoReviewPersists: Story = {
  name: 'Проверка видео · отчёт сохраняется при смене попытки и плана',
  tags: ['ci'],
  parameters: { songframe: reviewOptions() },
  play: async (context) => {
    const screen = screenOf(context);
    await shotHeading(context, 'M02');
    // Вопросов нет: сама открывается последняя попытка.
    await waitFor(() => expect(attemptSelect(context)).toHaveTextContent(steps.attempt({ number: '2' })));
    let panel = await chooseReviewPackage(context);
    await waitFor(() => expect(panel.getByRole('button', { name: videoReviewTexts.start })).toBeEnabled());
    await userEvent.click(panel.getByRole('button', { name: videoReviewTexts.start }));
    await panel.findByText(videoReviewTexts.status.preparing);
    await panel.findByText(videoReviewTexts.status.running, {}, POLL_TIMEOUT);
    await panel.findByText(videoReviewTexts.status.completed, {}, POLL_TIMEOUT);
    const summary = panel.getByText(/^M02: Персонаж и автомобиль/).textContent;
    const video = await originalVideo(context);
    await waitFor(() => expect(video?.duration).toBe(8));
    await userEvent.click(panel.getByRole('button', { name: 'Перейти к 0:02.50 в исходном видео' }));
    await waitFor(() => expect(video?.currentTime).toBeCloseTo(2.5));
    panel = await chooseReviewPackage(context, true);
    await panel.findByText(videoReviewTexts.status.idle);
    await expect(panel.queryByText(summary!)).not.toBeInTheDocument();
    panel = await chooseReviewPackage(context);
    await panel.findByText(summary!);
    await userEvent.click(screen.getByText('M01', { selector: 'p' }));
    await shotHeading(context, 'M01');
    panel = await reviewPanel(context);
    await panel.findByText(videoReviewTexts.status.idle);
    await expect(panel.queryByText(summary!)).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('M02', { selector: 'p' }));
    await shotHeading(context, 'M02');
    panel = await chooseReviewPackage(context);
    await panel.findByText(summary!);
    await expect(panel.getByRole('button', { name: videoReviewTexts.repeat })).toBeEnabled();
    await expect(reviewCounts(context)).toHaveTextContent('Проверок видео: 1. Отмен проверок: 0.');
    await expect(counts(context)).toHaveTextContent('Приёмок комплекта: 0. Отправок генерации: 0.');
  }
};

export const VideoReviewCancelAndRetry: Story = {
  name: 'Проверка видео · отмена и отдельный повтор',
  tags: ['ci'],
  parameters: { songframe: reviewOptions() },
  play: async (context) => {
    await shotHeading(context, 'M02');
    const panel = await chooseReviewPackage(context);
    const video = (await originalVideo(context)).getAttribute('src');
    await waitFor(() => expect(panel.getByRole('button', { name: videoReviewTexts.start })).toBeEnabled());
    await userEvent.click(panel.getByRole('button', { name: videoReviewTexts.start }));
    await userEvent.click(await panel.findByRole('button', { name: videoReviewTexts.cancel }));
    await panel.findByText(videoReviewTexts.status.cancelled);
    await expect(reviewCounts(context)).toHaveTextContent('Проверок видео: 1. Отмен проверок: 1.');
    await userEvent.click(panel.getByRole('button', { name: videoReviewTexts.repeat }));
    await panel.findByText(videoReviewTexts.status.completed, {}, POLL_TIMEOUT);
    await expect(await originalVideo(context)).toHaveAttribute('src', video);
    await expect(reviewCounts(context)).toHaveTextContent('Проверок видео: 2. Отмен проверок: 1.');
    await expect(counts(context)).toHaveTextContent('Приёмок комплекта: 0. Отправок генерации: 0.');
  }
};

export const VideoReviewFailureAndRetry: Story = {
  name: 'Проверка видео · ошибка агента и успешный повтор',
  tags: ['ci'],
  parameters: { songframe: reviewOptions({ failFirstRun: true }) },
  play: async (context) => {
    await shotHeading(context, 'M02');
    const panel = await chooseReviewPackage(context);
    await waitFor(() => expect(panel.getByRole('button', { name: videoReviewTexts.start })).toBeEnabled());
    await userEvent.click(panel.getByRole('button', { name: videoReviewTexts.start }));
    await panel.findByText(videoReviewTexts.status.failed, {}, POLL_TIMEOUT);
    await panel.findByText(PAGE_REVIEW_ERROR);
    await expect(counts(context)).toHaveTextContent('Приёмок комплекта: 0. Отправок генерации: 0.');
    await userEvent.click(panel.getByRole('button', { name: videoReviewTexts.repeat }));
    await panel.findByText(videoReviewTexts.status.completed, {}, POLL_TIMEOUT);
    await expect(panel.queryByText(PAGE_REVIEW_ERROR)).not.toBeInTheDocument();
    await expect(reviewCounts(context)).toHaveTextContent('Проверок видео: 2. Отмен проверок: 0.');
    await expect(counts(context)).toHaveTextContent('Приёмок комплекта: 0. Отправок генерации: 0.');
  }
};

export const VideoReviewNoFFmpeg: Story = {
  name: 'Проверка видео · без FFmpeg просмотр доступен, анализ заблокирован',
  tags: ['ci'],
  parameters: { songframe: reviewOptions({}, true) },
  play: async (context) => {
    await shotHeading(context, 'M02');
    const panel = await chooseReviewPackage(context);
    const start = await panel.findByRole('button', { name: videoReviewTexts.start });
    await expect(start).toBeDisabled();
    await expect(start).toHaveAttribute('title', expect.stringContaining('Для подготовки кадров нужны FFmpeg и ffprobe'));
    await expect(await originalVideo(context)).toHaveAttribute('src', expect.stringContaining('story-video.mp4'));
    await expect(panel.getByRole('button', { name: videoReviewTexts.refresh })).toBeEnabled();
    await expect(reviewCounts(context)).toHaveTextContent('Проверок видео: 0. Отмен проверок: 0.');
    await expect(counts(context)).toHaveTextContent('Приёмок комплекта: 0. Отправок генерации: 0.');
  }
};

export const UnknownSubmissionWarning: Story = {
  name: 'Неизвестный исход отправки · заметное предупреждение о повторном списании',
  tags: ['ci'],
  parameters: {
    songframe: options({
      shots: () =>
        baseShots({ stageLabel: 'Исход отправки неизвестен', attention: null, packages: [receivingPackage('submission_unknown', { unknown: true })] })
    })
  },
  play: async (context) => {
    const screen = screenOf(context);
    await userEvent.click(await screen.findByRole('button', { name: texts.packageResume.notCreated }, POLL_TIMEOUT));
    const dialog = await screen.findByRole('dialog', { name: texts.packageResume.notCreatedTitle });
    await expect(within(dialog).getByRole('alert')).toHaveTextContent(texts.packageResume.duplicateWarning);
    dialog.focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(counts(context)).toHaveTextContent('Отправок генерации: 0.');
    await expect(screen.getByRole('button', { name: texts.packageResume.notCreated })).toBeEnabled();
  }
};

/** Предел промпта провайдера в историях: короче настоящего, чтобы промпт образца его превышал. */
const STORY_PROMPT_LIMIT = 40;

/** Видеопромпт агента на согласовании длиннее предела провайдера. */
function overLimitShots(): ShotProduction[] {
  const source = preparedPackage();
  const text = 'Камера плавно приближается к старым воротам, свет в окне медленно разгорается.';
  const review = {
    ...source,
    stage: 'prompt_review',
    stageLabel: 'Видеопромпт на согласовании',
    request: null,
    keyframes: source.keyframes.map((frame) => ({ ...frame, approved: true })),
    prompt: { path: `${source.dir}/video-prompt.txt`, approved: false, text },
    pendingDecision: { stage: 'prompt_review', question: 'Утвердить видеопромпт?', options: ['approve', 'revise'], asked_at: '2026-11-12T10:00:00Z' }
  };
  return baseShots({ stageLabel: review.stageLabel, attention: review.pendingDecision.question, packages: [review] });
}

export const PromptOverLimit: Story = {
  tags: ['ci'],
  name: 'Видеопромпт сверх предела · утвердить нельзя, доработка с подсказкой',
  parameters: { songframe: options({ shots: overLimitShots, promptMaxChars: STORY_PROMPT_LIMIT }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(texts.promptLimit.title, {}, POLL_TIMEOUT)).toBeInTheDocument();
    const step = within(planStep(context, 'prompt'));
    const chars = Array.from('Камера плавно приближается к старым воротам, свет в окне медленно разгорается.').length;
    const over = { chars, limit: STORY_PROMPT_LIMIT };
    await expect(step.getByText(texts.promptLimit.description({ ...over, provider: testProviderInfo.title }))).toBeInTheDocument();
    // Без перевода нет ни переключателя вариантов, ни отметки отправки.
    await expect(step.queryByRole('group', { name: texts.promptVariants.view })).not.toBeInTheDocument();
    await expect(step.queryByText(texts.promptVariants.selected({ translation: false }))).not.toBeInTheDocument();
    // Утверждение недоступно с причиной; доработка открывает поле с готовым замечанием о сокращении.
    await expect(step.getByRole('button', { name: texts.verdictLabels.approve })).toBeDisabled();
    await userEvent.click(step.getByRole('button', { name: texts.verdictLabels.revise }));
    await expect(step.getByRole('textbox', { name: texts.packageDecision.note })).toHaveValue(texts.promptLimit.reviseNote(over));
    // «Доработать с агентом» записывает ответ только после подтверждения; отказ ничего не записывает.
    await userEvent.click(step.getByRole('button', { name: texts.productionWorkflowPanel.reviseNow }));
    const confirmation = within(await screen.findByRole('dialog', { name: texts.packageDecision.reviseConfirmTitle }));
    await expect(confirmation.getByText(texts.packageDecision.reviseConfirmDescription)).toBeVisible();
    await userEvent.click(confirmation.getByRole('button', { name: commonTexts.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(counts(context)).toHaveTextContent('Ответов: 0.');
  }
};

/** Свой промпт вместо промпта агента сверх предела: «Изменить» не ждёт ответа на вопрос о промпте, сохранение утверждает. */
export const OwnPromptOverLimit: Story = {
  tags: ['ci'],
  name: 'Свой видеопромпт · сокращение промпта агента сверх предела',
  parameters: { songframe: options({ shots: overLimitShots, promptMaxChars: STORY_PROMPT_LIMIT }) },
  play: async (context) => {
    const screen = screenOf(context);
    const own = texts.ownPromptDialog;
    await expect(await screen.findByText(texts.promptLimit.title, {}, POLL_TIMEOUT)).toBeInTheDocument();
    const step = within(planStep(context, 'prompt'));
    await userEvent.click(step.getByRole('button', { name: texts.ownDescriptionDialog.edit }));
    const dialog = within(await screen.findByRole('dialog', { name: own.title({ shot: 'M02' }) }));
    const field = dialog.getByRole('textbox', { name: own.prompt });
    const text = 'Камера плавно приближается к старым воротам, свет в окне медленно разгорается.';
    await expect(field).toHaveValue(text);
    // Сверх предела сохранить нельзя: причина та же, что у недоступного утверждения.
    // Кнопка с причиной недоступности обёрнута подсказкой: после смены состояния её ищут заново.
    const save = () => dialog.getByRole('button', { name: texts.ownDescriptionDialog.save });
    await expect(save()).toBeDisabled();
    await expect(dialog.getByText(own.chars({ chars: Array.from(text).length, limit: STORY_PROMPT_LIMIT }))).toBeVisible();
    await userEvent.clear(field);
    await userEvent.type(field, 'Камера приближается к воротам.');
    await expect(dialog.getByText(own.chars({ chars: 30, limit: STORY_PROMPT_LIMIT }))).toBeVisible();
    await waitFor(() => expect(save()).toBeEnabled(), POLL_TIMEOUT);
    await userEvent.click(save());
    await waitFor(() => expect(counts(context)).toHaveTextContent('Своих описаний: промпт 30.'), POLL_TIMEOUT);
    await waitFor(() => expect(counts(context)).toHaveTextContent('Ответов: 1.'), POLL_TIMEOUT);
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(texts.promptLimit.title)).not.toBeInTheDocument(), POLL_TIMEOUT);
  }
};

/** Утверждённый промпт меняется и при подготовленном неотправленном запросе: вопрос об отправке не мешает, запрос соберётся заново. */
export const OwnPromptPreparedRequest: Story = {
  tags: ['ci'],
  name: 'Свой видеопромпт · замена утверждённого при подготовленном запросе',
  parameters: {
    songframe: options({ shots: () => baseShots({ stageLabel: 'Запрос подготовлен', attention: null, packages: [preparedPackage()] }) })
  },
  play: async (context) => {
    const screen = screenOf(context);
    const own = texts.ownPromptDialog;
    await waitFor(() => expect(planStep(context, 'prompt')).not.toBeNull(), POLL_TIMEOUT);
    const step = within(planStep(context, 'prompt'));
    // Пройденный шаг свёрнут: открываем его, чтобы изменить промпт.
    await userEvent.click(await step.findByRole('button', { name: new RegExp(steps.titles.prompt) }, POLL_TIMEOUT));
    const edit = await step.findByRole('button', { name: texts.ownDescriptionDialog.edit }, POLL_TIMEOUT);
    await waitFor(() => expect(edit).toBeEnabled(), POLL_TIMEOUT);
    await userEvent.click(edit);
    const dialog = within(await screen.findByRole('dialog', { name: own.title({ shot: 'M02' }) }));
    const field = dialog.getByRole('textbox', { name: own.prompt });
    await userEvent.clear(field);
    await userEvent.type(field, 'Камера приближается к воротам.');
    await userEvent.click(dialog.getByRole('button', { name: texts.ownDescriptionDialog.save }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Своих описаний: промпт 30.'), POLL_TIMEOUT);
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(planStep(context, 'prompt')).toHaveTextContent('Камера приближается к воротам.'), POLL_TIMEOUT);
    // Раскрытый шаг прокрутил страницу под закреплённую панель: итог axe проверяет с начала страницы.
    context.canvasElement.ownerDocument.defaultView?.scrollTo({ top: 0 });
  }
};

/** Видеопромпт агента с русским переводом на согласовании: оригинал короче предела провайдера, перевод длиннее. */
const STORY_PROMPT_ORIGINAL = 'Camera slowly pushes in to the old gate.';
const STORY_PROMPT_TRANSLATION = 'Камера медленно приближается к старым воротам, свет в окне разгорается.';
function translatedPromptShots(): ShotProduction[] {
  return overLimitShots().map((shot) => {
    const [review] = shot.packages;
    if (!review?.prompt) return shot;
    const prompt = {
      ...review.prompt,
      text: STORY_PROMPT_ORIGINAL,
      variants: { original: STORY_PROMPT_ORIGINAL, translation: STORY_PROMPT_TRANSLATION, selected: 'original' as const }
    };
    return { ...shot, packages: [{ ...review, prompt }] };
  });
}

/** Переключатель варианта видеопромпта шага: на согласовании показанный вариант и есть отправляемый. */
function variantToggle(step: ReturnType<typeof within>): ReturnType<typeof within> {
  return within(step.getByRole('group', { name: texts.promptVariants.view }));
}

export const PromptTranslation: Story = {
  tags: ['ci'],
  name: 'Видеопромпт с переводом · один переключатель: показанный вариант уходит в утверждение',
  parameters: { songframe: options({ shots: translatedPromptShots }) },
  play: async (context) => {
    const variants = texts.promptVariants;
    const step = within(
      await waitFor(() => {
        const found = planStep(context, 'prompt');
        if (!found || !within(found).queryByText(STORY_PROMPT_ORIGINAL)) throw new Error('Видеопромпт ещё не показан.');
        return found;
      }, POLL_TIMEOUT)
    );
    // По умолчанию показан и выбран к отправке оригинал; второго выбора отправки нет.
    await expect(variantToggle(step).getByRole('button', { name: variants.original })).toHaveAttribute('aria-pressed', 'true');
    await expect(step.getByText(variants.selected({ translation: false }))).toBeInTheDocument();
    await expect(step.queryByRole('radiogroup')).not.toBeInTheDocument();
    // Переключатель показывает перевод, и отметка «К отправке» следует за ним.
    await userEvent.click(variantToggle(step).getByRole('button', { name: variants.translation }));
    await expect(step.getByText(STORY_PROMPT_TRANSLATION)).toBeInTheDocument();
    await expect(step.queryByText(STORY_PROMPT_ORIGINAL)).not.toBeInTheDocument();
    await expect(step.getByText(variants.selected({ translation: true }))).toBeInTheDocument();
    // Обратно к оригиналу и снова к переводу: утверждается показанный вариант.
    await userEvent.click(variantToggle(step).getByRole('button', { name: variants.original }));
    await expect(step.getByText(variants.selected({ translation: false }))).toBeInTheDocument();
    await userEvent.click(variantToggle(step).getByRole('button', { name: variants.translation }));
    await userEvent.click(step.getByRole('button', { name: texts.verdictLabels.approve }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Вариантов промпта к отправке: translation.'), POLL_TIMEOUT);
    // Пройденный шаг свёрнут: открытый, он помнит выбранный вариант; переключатель остаётся только для просмотра.
    const done = within(planStep(context, 'prompt')!);
    await userEvent.click(await done.findByRole('button', { name: new RegExp(steps.titles.prompt) }, POLL_TIMEOUT));
    await expect(await done.findByText(variants.selected({ translation: true }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    await userEvent.click(variantToggle(done).getByRole('button', { name: variants.original }));
    await expect(done.getByText(STORY_PROMPT_ORIGINAL)).toBeInTheDocument();
    await expect(done.getByText(variants.selected({ translation: true }))).toBeInTheDocument();
  }
};

export const PromptTranslationOverLimit: Story = {
  tags: ['ci'],
  name: 'Видеопромпт с переводом · предел провайдера для выбранного варианта',
  parameters: { songframe: options({ shots: translatedPromptShots, promptMaxChars: STORY_PROMPT_LIMIT }) },
  play: async (context) => {
    const screen = screenOf(context);
    const variants = texts.promptVariants;
    const step = within(
      await waitFor(() => {
        const found = planStep(context, 'prompt');
        if (!found || !within(found).queryByRole('group', { name: variants.view })) throw new Error('Переключатель варианта ещё не показан.');
        return found;
      }, POLL_TIMEOUT)
    );
    // Оригинал в пределе: предупреждения нет, утвердить можно.
    await expect(screen.queryByText(texts.promptLimit.title)).not.toBeInTheDocument();
    await expect(step.getByRole('button', { name: texts.verdictLabels.approve })).toBeEnabled();
    // Перевод длиннее предела: показанный и выбранный к отправке, он не утверждается.
    await userEvent.click(variantToggle(step).getByRole('button', { name: variants.translation }));
    await expect(await screen.findByText(texts.promptLimit.title)).toBeInTheDocument();
    const over = { chars: Array.from(STORY_PROMPT_TRANSLATION).length, limit: STORY_PROMPT_LIMIT };
    await expect(step.getByText(texts.promptLimit.description({ ...over, provider: testProviderInfo.title }))).toBeInTheDocument();
    await waitFor(() => expect(step.getByRole('button', { name: texts.verdictLabels.approve })).toBeDisabled());
    // Снова оригинал: предупреждение уходит, утверждение отправляет оригинал.
    await userEvent.click(variantToggle(step).getByRole('button', { name: variants.original }));
    await waitFor(() => expect(screen.queryByText(texts.promptLimit.title)).not.toBeInTheDocument());
    await waitFor(() => expect(step.getByRole('button', { name: texts.verdictLabels.approve })).toBeEnabled());
    await userEvent.click(step.getByRole('button', { name: texts.verdictLabels.approve }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Вариантов промпта к отправке: original.'), POLL_TIMEOUT);
  }
};

/** Свой видеопромпт утверждён при сохранении, запрос не подготовлен: способ генерации выбирается на шаге «Запрос». */
function approvedPromptShots(): ShotProduction[] {
  return overLimitShots().map((shot) => {
    const [review] = shot.packages;
    if (!review?.prompt) return shot;
    const approved = { ...review, stageLabel: texts.main.package.promptApproved, prompt: { ...review.prompt, approved: true }, pendingDecision: null };
    return { ...shot, stageLabel: approved.stageLabel, attention: null, packages: [approved] };
  });
}

export const MethodAfterApprovedPrompt: Story = {
  tags: ['ci'],
  name: 'Способ генерации после утверждённого промпта · выбор на шаге «Запрос», провайдер только в пределах длины',
  parameters: { songframe: options({ shots: approvedPromptShots, promptMaxChars: STORY_PROMPT_LIMIT }) },
  play: async (context) => {
    const screen = screenOf(context);
    const method = texts.generationMethod;
    const step = within(
      await waitFor(() => {
        const found = planStep(context, 'request');
        if (!found || !within(found).queryByRole('radiogroup')) throw new Error('Выбор способа на шаге «Запрос» ещё не показан.');
        return found;
      }, POLL_TIMEOUT)
    );
    // На шаге «Видеопромпт» выбора уже нет: промпт утверждён.
    await expect(within(planStep(context, 'prompt')).queryByRole('radiogroup')).not.toBeInTheDocument();
    await userEvent.click(step.getByRole('radio', { name: new RegExp(method.manual) }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Способов генерации: manual.'), POLL_TIMEOUT);
    await waitFor(() => expect(step.getByRole('button', { name: texts.manualGeneration.build })).toBeEnabled(), POLL_TIMEOUT);
    // Промпт длиннее предела провайдера: вернуть провайдера нельзя, причина названа.
    await userEvent.click(step.getByRole('radio', { name: new RegExp(method.provider) }));
    await expect(await screen.findByText(/Видеопромпт длиннее предела провайдера/, {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Способов генерации: manual.');
  }
};

/** Способ «Вручную вне приложения» для обычного плана: предела промпта нет, пакет из всех опор без звука, видео загружается в попытку. */
export const ManualMethod: Story = {
  tags: ['ci'],
  name: 'Вручную вне приложения · способ попытки, пакет из опор и загрузка видео',
  parameters: { songframe: options({ shots: overLimitShots, promptMaxChars: STORY_PROMPT_LIMIT }) },
  play: async (context) => {
    const screen = screenOf(context);
    const manual = texts.manualGeneration;
    const method = texts.generationMethod;
    await expect(await screen.findByText(texts.promptLimit.title, {}, POLL_TIMEOUT)).toBeInTheDocument();
    const prompt = within(planStep(context, 'prompt'));
    const group = within(prompt.getByRole('radiogroup'));
    await expect(group.getByRole('radio', { name: new RegExp(method.provider) })).toBeChecked();
    await userEvent.click(group.getByRole('radio', { name: new RegExp(method.manual) }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Способов генерации: manual.'), POLL_TIMEOUT);
    // У формы сервиса свои правила: предел провайдера к ручной попытке не относится, промпт утверждается.
    await waitFor(() => expect(screen.queryByText(texts.promptLimit.title)).not.toBeInTheDocument(), POLL_TIMEOUT);
    await waitFor(() => expect(prompt.getByRole('button', { name: texts.verdictLabels.approve })).toBeEnabled(), POLL_TIMEOUT);
    await userEvent.click(prompt.getByRole('button', { name: texts.verdictLabels.approve }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Ответов: 1.'), POLL_TIMEOUT);
    // Вместо запроса — ручная генерация: пакет из всех утверждённых опор, без звука и без платной отправки.
    const step = within(planStep(context, 'request'));
    await expect(await step.findByText(steps.titles.manual, {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(step.getByText(manual.descriptionChosen)).toBeInTheDocument();
    // Пакет доступен, когда вид попытки перечитан после утверждения промпта.
    await waitFor(() => expect(step.getByRole('button', { name: manual.build })).toBeEnabled(), POLL_TIMEOUT);
    await userEvent.click(step.getByRole('button', { name: manual.build }));
    await expect(await step.findByText(manual.built, {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(step.getByText(manual.genericInstruction)).toBeInTheDocument();
    await expect(step.getByText(manual.input({ role: 'Опора K04', name: '04.png' }))).toBeInTheDocument();
    await expect(step.queryByText(/Срез речи/)).not.toBeInTheDocument();
    await userEvent.click(step.getByRole('button', { name: new RegExp(manual.zone) }));
    await step.findByText(manual.chosen({ name: STORY_VIDEO_PATH.split('/').pop()! }));
    await userEvent.type(step.getByRole('textbox', { name: new RegExp(manual.source) }), 'Свой сервис');
    await userEvent.click(step.getByRole('button', { name: manual.upload }));
    await expect(await screen.findByText(steps.now({ text: steps.reviewResult }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    await expect(counts(context)).toHaveTextContent('Отправок генерации: 0.');
    await expect(counts(context)).toHaveTextContent('Пакетов ручной генерации: 1. Загрузок видео: 1.');
  }
};

export const PromptReopenFromRequest: Story = {
  tags: ['ci'],
  name: 'Возврат видеопромпта с этапа запроса · описание и опоры остаются',
  parameters: {
    songframe: options({ shots: () => baseShots({ stageLabel: 'Запрос подготовлен', attention: null, packages: [preparedPackage()] }) })
  },
  play: async (context) => {
    const screen = screenOf(context);
    const dialogTexts = texts.promptReopenDialog;
    const step = within(
      await waitFor(() => {
        const found = planStep(context, 'prompt');
        if (!found) throw new Error('Шаг «Видеопромпт» ещё не показан.');
        return found;
      }, POLL_TIMEOUT)
    );
    // Пройденный шаг свёрнут: открываем его, чтобы вернуть промпт.
    await userEvent.click(await step.findByRole('button', { name: new RegExp(steps.titles.prompt) }, POLL_TIMEOUT));
    await userEvent.click(await step.findByRole('button', { name: dialogTexts.confirm }));
    const dialog = within(await screen.findByRole('dialog', { name: dialogTexts.title }));
    await expect(dialog.getByText(dialogTexts.description({ request: 'video-01' }))).toBeInTheDocument();
    await expect(dialog.getByRole('button', { name: dialogTexts.confirm })).toBeDisabled();
    await userEvent.type(dialog.getByRole('textbox', { name: dialogTexts.note }), 'убрать титры');
    // Доступная кнопка отрисовывается заново (без обёртки причины), поэтому ищется после ввода.
    await userEvent.click(dialog.getByRole('button', { name: dialogTexts.confirm }));
    await expect(await screen.findByText(texts.useProductionPage.promptReopened, {}, POLL_TIMEOUT)).toBeInTheDocument();
    await waitFor(() => expect(counts(context)).toHaveTextContent('Возвратов промпта: убрать титры.'), POLL_TIMEOUT);
    await waitFor(() => expect(planStep(context, 'prompt')).toHaveTextContent(/не принят/), POLL_TIMEOUT);
    // Шаг ниже по странице прокручивает её: шапка карточки уходит под закреплённую панель, и проверка
    // размера целей axe считала бы частично закрытые кнопки. Итог проверяется с начала страницы.
    context.canvasElement.ownerDocument.defaultView?.scrollTo({ top: 0 });
  }
};

/** Своё описание без агента: «Написать самому» создаёт попытку, сохранение сразу принимает описание. */
export const OwnDescription: Story = {
  name: 'Своё описание · сохранение создаёт попытку и принимает описание',
  tags: ['ci'],
  parameters: { songframe: options({}, '/project/production?shot=M04') },
  play: async (context) => {
    const screen = screenOf(context);
    const own = texts.ownDescriptionDialog;
    await shotHeading(context, 'M04');
    await userEvent.click(await screen.findByRole('button', { name: own.writeOwn }, POLL_TIMEOUT));
    const dialog = within(await screen.findByRole('dialog', { name: own.title({ shot: 'M04' }) }));
    await userEvent.type(dialog.getByLabelText(own.description), 'Свет в окне загорается, герой поднимает голову.');
    // Промпт K01 не обязателен: эту опору пользователь загрузит своим файлом.
    await userEvent.type(dialog.getAllByLabelText(own.prompt)[1], 'Окно светится, герой смотрит вверх.');
    await userEvent.click(dialog.getByRole('button', { name: own.save }));
    await waitFor(() => expect(counts(context)).toHaveTextContent('Своих описаний: Свет в окне загорается, герой поднимает голову. (2).'), POLL_TIMEOUT);
    // Принятие — тот же ответ approve на вопрос описания, что и после принятого предложения агента.
    await waitFor(() => expect(counts(context)).toHaveTextContent('Ответов: 1.'), POLL_TIMEOUT);
    await expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const description = within(planStep(context, 'description'));
    await expect(await description.findByText(steps.descriptionSummary({ frames: 2, seconds: 6 }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Принятое описание можно исправить вручную: пройденный шаг раскрывается и показывает «Изменить».
    await userEvent.click(description.getByRole('button', { name: new RegExp(steps.titles.description) }));
    await expect(await description.findByRole('button', { name: own.edit })).toBeEnabled();
    // Опору без промпта создать нечем: кнопка создания недоступна с причиной, свой файл доступен.
    const frames = within(planStep(context, 'frames'));
    const create = await frames.findByRole('button', { name: /изображения K01/ }, POLL_TIMEOUT);
    await expect(create).toBeDisabled();
    await userEvent.hover(create.parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent(texts.frameActions.noPrompt({ id: 'K01' }));
    await expect(frames.queryByRole('button', { name: texts.frameActions.instructionOpen })).not.toBeInTheDocument();
    // «Свой файл» есть у каждой несозданной опоры, первая — у K01.
    await expect(frames.getAllByRole('button', { name: texts.frameActions.own })[0]).toBeEnabled();
  }
};
