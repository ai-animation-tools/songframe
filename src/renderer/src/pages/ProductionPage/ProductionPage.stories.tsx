/** Целая страница «Производство»: настоящий опрос, выбор плана и пакета, якоря и переходы ответов на локальной модели API. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { productionTexts } from '@shared/texts/production';
import type { ShotProduction } from '@shared/types';
import { ANCHORS } from '../../components/linkTargets';
import { keyframePackage } from '../../testing/keyframeStories';
import { preparedPackage, queuedPackage } from '../../testing/productionQueueStories';
import { receivedPackage } from '../../testing/resultStories';
import {
  longPageShots,
  PAGE_ACTION_ERROR,
  PAGE_READ_ERROR,
  pageShot,
  ProductionPageStory,
  productionPageOptions,
  type ProductionPageModelOptions
} from '../../testing/productionPageStories';
import { PYTHON_REASON } from './constants';

const texts = productionTexts;
const POLL_TIMEOUT = { timeout: 6000 };

/** Небольшой проект: план в работе с вопросом об опоре, производный, запланированный, устаревший и принятые. */
function baseShots(main: Partial<ShotProduction> = {}): ShotProduction[] {
  const waiting = keyframePackage({ keyframeNotes: [] });
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

export const Overview: Story = {
  name: 'Обзор · план с вопросом выбран автоматически',
  play: async (context) => {
    await shotHeading(context, 'M02');
    await expect(selectedCard(context)).toHaveTextContent('M02');
    // Единственный пакет открывается сам; панель подготовки и вопрос об опоре видны без ручного выбора.
    await expect(await screenOf(context).findByText('Утвердить опору K02?')).toBeInTheDocument();
    await expect(context.canvasElement.ownerDocument.querySelector(`[data-anchor="${ANCHORS.productionWorkflow}"]`)).not.toBeNull();
    await expect(route(context)).toHaveTextContent(/^\/project\/production$/);
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
      { problems: ['Сохранённые запросы ждут решения в блоке «Очередь».', 'Описание M02 готовится в блоке «Подготовка плана».'] },
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
    await userEvent.click(problems.getByRole('link', { name: '«Подготовка плана»' }));
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
    expect(rect.top).toBeGreaterThanOrEqual(bar.getBoundingClientRect().bottom - 1);
    expect(rect.bottom).toBeLessThanOrEqual(view.innerHeight + 1);
  });
  let grid = heading.parentElement;
  while (grid && view.getComputedStyle(grid).display !== 'grid') grid = grid.parentElement;
  const columns = view.getComputedStyle(grid!).gridTemplateColumns.split(' ').length;
  // Число колонок задаёт ширина содержимого контейнера workspace, а не окна.
  let workspace = grid!.parentElement!;
  while (view.getComputedStyle(workspace).containerName !== 'workspace') workspace = workspace.parentElement!;
  const style = view.getComputedStyle(workspace);
  const wide = workspace.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) >= 1100;
  await expect(columns).toBe(wide ? 2 : 1);
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
    await expect(rect.bottom).toBeLessThanOrEqual(view.innerHeight + 1);
    // Длинное содержимое плана прокручивается внутри колонки, документ остаётся на месте.
    const before = view.scrollY;
    await expect(column.scrollHeight).toBeGreaterThan(column.clientHeight);
    column.scrollTop = column.scrollHeight;
    await waitFor(() => expect(column.scrollTop).toBeGreaterThan(0));
    await expect(view.scrollY).toBe(before);
  } else {
    // Одна колонка: план идёт после списка и прокручивается вместе с документом.
    await expect(view.getComputedStyle(column).position).not.toBe('sticky');
    await expect(view.getComputedStyle(column).overflowY).not.toBe('auto');
    await expect(column.getBoundingClientRect().top).toBeGreaterThanOrEqual(column.previousElementSibling!.getBoundingClientRect().bottom);
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
  name: 'Две колонки (область 1600 px) · план закреплён и прокручивается сам',
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
    await userEvent.click(await screen.findByRole('button', { name: texts.packageResult.accept }));
    const dialog = within(await screen.findByRole('dialog', { name: texts.acceptResultDialog.title({ shot: 'M02' }) }));
    const confirm = dialog.getByRole('button', { name: texts.acceptResultDialog.replace });
    await expect(confirm).toBeDisabled();
    await userEvent.click(dialog.getByRole('checkbox', { name: texts.acceptResultDialog.replaceCheckbox }));
    // Выключенная кнопка обёрнута подсказкой причины: после отметки ищем заново включённую кнопку.
    await waitFor(() => expect(dialog.getByRole('button', { name: texts.acceptResultDialog.replace })).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', { name: texts.acceptResultDialog.replace }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(counts(context)).toHaveTextContent('Приёмок комплекта: 1.');
    // Ответ запуска ещё не принимает комплект: итог приходит со следующим опросом заданий и производства.
    await expect(screen.getByText(texts.productionToolbar.accepted({ completed: 1, total: 2 }))).toBeInTheDocument();
    await expect(await screen.findByText(texts.useProductionPage.jobDone({ title: 'Приёмка M02' }), {}, { timeout: 8000 })).toBeInTheDocument();
    await expect(await screen.findByText(texts.productionToolbar.accepted({ completed: 2, total: 2 }), {}, POLL_TIMEOUT)).toBeInTheDocument();
    // Рабочие пакеты очищены: запомненный пакет больше не выбран, открыта новая подготовка.
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: new RegExp(texts.productionPage.packageLabel) })).toHaveTextContent(texts.productionPage.newPreparation)
    );
    await expect(screen.queryByText(texts.productionPage.choosePackageHint)).not.toBeInTheDocument();
    await expect(context.canvasElement.ownerDocument.querySelector(`[data-anchor="${ANCHORS.productionWorkflow}"]`)).not.toBeNull();
  }
};

const multipleShots = () =>
  baseShots({
    packages: [keyframePackage({ keyframeNotes: [] }), preparedPackage('02'), queuedPackage('video')]
  });
export const MultiplePackages: Story = {
  name: 'Несколько пакетов · переход из карточки плана и выбор с клавиатуры',
  parameters: { songframe: options({ shots: multipleShots }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(texts.productionPage.choosePackageHint, {}, POLL_TIMEOUT)).toBeInTheDocument();
    const open = screen.getAllByRole('button', { name: texts.productionShotCard.openPackage });
    await expect(open).toHaveLength(2);
    await userEvent.click(open[0]);
    await expect(await screen.findByText('Утвердить опору K02?')).toBeInTheDocument();
    await expect(screen.getAllByRole('button', { name: texts.productionShotCard.openPackage })).toHaveLength(1);
    const combobox = screen.getByRole('combobox', { name: new RegExp(texts.productionPage.packageLabel) });
    await expect(combobox).toHaveTextContent('plan/batches/M02-attempt-01');
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

export const NoPython: Story = {
  name: 'Без Python · просмотр работает, ответы объясняют причину',
  parameters: { songframe: options({ python: false }) },
  play: async (context) => {
    const screen = screenOf(context);
    await expect(await screen.findByText(texts.productionPage.pythonMissing, {}, POLL_TIMEOUT)).toBeInTheDocument();
    const button = await screen.findByRole('button', { name: approve('K02') });
    await expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    await expect(await screen.findByRole('tooltip')).toHaveTextContent(PYTHON_REASON);
    await expect(counts(context)).toHaveTextContent('Ответов: 0.');
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
    await expect(route(context)).toHaveTextContent(/^\/project\/scenario$/);
  }
};
