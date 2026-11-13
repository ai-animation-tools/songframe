/** Страница «Сцены»: сетка сцен слева, выбранная сцена справа, ширина списка меняется разделителем. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { componentsTexts } from '@shared/texts/components';
import type { AppState, DashboardShot, DashboardView } from '@shared/types';
import { storyAccess } from '../../testing/commonStories';
import { createStoryApi, STORY_IMAGE_PATH, STORY_VIDEO_PATH, type StoryOptions } from '../../testing/storybook';
import { ScenesPage } from './ScenesPage';

const PROJECT = '/mock/project';
const appState: AppState = { packaged: false, problems: [], localDir: '/mock/state', current: PROJECT, history: [], platform: 'linux' };
const app: StoryOptions['app'] = { state: appState, online: true, aiAccess: storyAccess };

/** Сцена плана без принятого комплекта и пакета: карточка с миниатюрой, подробности — постановка. */
function sceneShot(index: number): DashboardShot {
  const id = `M${String(index + 1).padStart(2, '0')}`;
  return {
    derivedFrom: null,
    id,
    title: `Сцена ${index + 1}`,
    sequenceTitle: 'Куплет',
    original: 'Деревня работает, обед готовится',
    start: index * 5,
    end: index * 5 + 5,
    frames: 150,
    camera: 'Средний план, камера неподвижна',
    action: 'Герои смеются у пожарной машины',
    continuity: '',
    notes: '',
    lipsync: false,
    references: [],
    state: index < 2 ? 'progress' : 'planned',
    stageLabel: index < 2 ? 'Опоры готовы' : 'Постановка есть, работа не начата',
    asset: null,
    package: null,
    packagesCount: 0,
    thumbnail: STORY_IMAGE_PATH,
    keyframes: [],
    cardPath: null,
    animaticMedia: null,
    before: null,
    after: null
  };
}

/** Принятая сцена: оригинал генерации и принятый участок рядом, с бейджами. */
function acceptedShot(index: number): DashboardShot {
  return {
    ...sceneShot(index),
    state: 'completed',
    stageLabel: 'Принят',
    asset: {
      dir: '/mock/project/assets/shots/M08',
      video: STORY_VIDEO_PATH,
      original: STORY_VIDEO_PATH,
      originalMedia: '1280×720, 24 кадр/с',
      edit: { fps: 30, frames: 120, duration: 5, sourceInterval: [0.5, 5.5], stillAt: null, speed: '1', holdFirst: 0, holdLast: 0, note: '' },
      prompt: null,
      request: null,
      inputs: [],
      lipsync: false,
      audio: null
    }
  };
}

const VIEW: DashboardView = {
  shots: [...Array.from({ length: 7 }, (_, index) => sceneShot(index)), acceptedShot(7)],
  summary: { total: 8, completed: 1, stale: 0, progress: 2, planned: 5, duration: 40, completedSeconds: 5 },
  problems: []
};

function options(route: string, workspaceWidth?: number): StoryOptions {
  return {
    shell: 'page',
    route,
    app,
    ...(workspaceWidth ? { workspaceWidth } : {}),
    createApi: () => createStoryApi({ dashboard: { view: async () => structuredClone(VIEW) } })
  };
}

const meta = {
  title: 'Страницы/Сцены',
  component: ScenesPage,
  tags: ['!autodocs'],
  parameters: { songframe: options('/project/scenes?shot=M02', 1600) }
} satisfies Meta<typeof ScenesPage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Число колонок сетки сцен: ближайшая сетка, в которой по элементу на каждую сцену. */
function sceneColumns(canvasElement: HTMLElement): number {
  const view = canvasElement.ownerDocument.defaultView!;
  const card = within(canvasElement).getByText('M01', { selector: 'p' });
  let grid: HTMLElement | null = card.parentElement;
  while (grid && !(view.getComputedStyle(grid).display === 'grid' && grid.children.length === VIEW.shots.length)) grid = grid.parentElement;
  return view.getComputedStyle(grid!).gridTemplateColumns.split(' ').length;
}

export const SelectedScene: Story = {
  name: 'Выбранная сцена справа · ширина списка меняется разделителем',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'M02', level: 6 })).toBeVisible();
    const view = canvasElement.ownerDocument.defaultView!;
    const handle = canvas.getByRole('separator', { name: commonTexts.listDetail.split });
    await expect(handle).toHaveAttribute('aria-valuenow', '460');
    const before = sceneColumns(canvasElement);
    handle.focus();
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(sceneColumns(canvasElement)).toBe(1));
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(sceneColumns(canvasElement)).toBeGreaterThanOrEqual(before));
    await expect(canvasElement.ownerDocument.documentElement.scrollWidth).toBeLessThanOrEqual(view.innerWidth);
  }
};

export const DefaultScene: Story = {
  name: 'Открытие без ?shot= · сцена в работе, как на «Производстве»; закрытая карточка не возвращается',
  tags: ['ci'],
  parameters: { songframe: options('/project/scenes', 1600) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    // Первая сцена в работе — M01.
    await expect(await screen.findByRole('heading', { name: 'M01', level: 6 })).toBeVisible();
    await waitFor(() => expect(screen.getByTestId('story-route')).toHaveTextContent('/project/scenes?shot=M01'));
    await userEvent.click(screen.getByRole('button', { name: commonTexts.close }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'M01', level: 6 })).not.toBeInTheDocument());
    await expect(screen.queryByRole('separator', { name: commonTexts.listDetail.split })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: commonTexts.refresh }));
    await expect(await screen.findByText('M08', { selector: 'p' })).toBeVisible();
    await expect(screen.queryByRole('heading', { name: 'M01', level: 6 })).not.toBeInTheDocument();
  }
};

export const AcceptedScene: Story = {
  name: 'Принятая сцена · без видео и промпта, переход на «Производство»',
  tags: ['ci'],
  parameters: { songframe: options('/project/scenes?shot=M08', 1600) },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    const heading = await screen.findByRole('heading', { name: 'M08', level: 6 });
    // Видео, опоры и промпт принятого плана показывает «Производство»: в карточке сцены их нет.
    const card = heading.closest<HTMLElement>('.MuiPaper-root')!;
    await expect(card.querySelector('video')).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: componentsTexts.shot.pages.production.label }));
    await waitFor(() => expect(screen.getByTestId('story-route')).toHaveTextContent('/project/production?shot=M08'));
  }
};

export const Narrow: Story = {
  name: 'Узкая рабочая область · сцена под сеткой',
  parameters: { songframe: options('/project/scenes?shot=M02', 1000) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = await canvas.findByRole('heading', { name: 'M02', level: 6 });
    await expect(canvas.queryByRole('separator', { name: commonTexts.listDetail.split })).not.toBeInTheDocument();
    await expect(heading.getBoundingClientRect().top).toBeGreaterThan(canvas.getByText('M08', { selector: 'p' }).getBoundingClientRect().top);
  }
};
