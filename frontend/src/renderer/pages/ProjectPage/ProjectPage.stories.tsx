/** Настоящая страница открывает рабочий диалог; API ограничен локальной моделью витрины. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { projectsTexts } from '@shared/texts/projects';
import { draftDialogOptions } from '../../testing/dialogDraftStories';
import { checkDraftDialog } from '../../testing/dialogDraftPlay';
import { MEDIA_PROVIDERS } from '@shared/media-providers';
import { navigationTexts } from '@shared/texts/navigation';
import { projectTexts } from '@shared/texts/project';
import { DEFAULT_VIDEO_GENERATION } from '@shared/types';
import { createStoryApi, type ApiOverrides, type StoryOptions } from '../../testing/storybook';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { productionTexts } from '@shared/texts/production';
import { ANCHORS } from '../../components/linkTargets';
import { historyApi } from '../../testing/projectHistoryStories';
import { ProjectPage } from './ProjectPage';
const meta = { title: 'Страницы/Проект', component: ProjectPage, tags: ['!autodocs'], parameters: { songframe: draftDialogOptions(true) } } satisfies Meta<
  typeof ProjectPage
>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PreserveDialogDraft: Story = {
  name: 'Черновик окна · случайное закрытие и явная отмена',
  tags: ['ci'],
  play: ({ canvasElement }) => checkDraftDialog(canvasElement, 'rename', commonTexts.rename)
};
export const FrameRate: Story = {
  name: 'Шапка · частота кадров проекта',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(projectsTexts.projectFrameRate(30))).toBeVisible();
  }
};

/** Проект без сервиса видео: способ «Вручную вне приложения» объясняется, модель и проверка возможностей не показываются. */
const manualVideoOptions = (): StoryOptions => {
  const base = draftDialogOptions(true);
  return {
    ...base,
    createApi: () => {
      const overrides = base.createApi!() as ApiOverrides;
      return {
        ...overrides,
        projects: {
          ...overrides.projects,
          settings: async () => ({
            name: 'Клип без сервиса видео',
            animaticVideo: 'animatic.mp4',
            generation: { video: { ...DEFAULT_VIDEO_GENERATION, provider: 'manual', provider_selected: true }, image: null }
          })
        }
      };
    }
  };
};

export const ManualVideo: Story = {
  name: 'Генерация видео · вручную вне приложения',
  tags: ['ci'],
  parameters: { songframe: manualVideoOptions() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Блок настроек видео — раздел с якорем: его находят по якорю, а не по роли.
    await canvas.findByText(navigationTexts.blocks.projectVideoGeneration);
    const block = within(canvasElement.querySelector<HTMLElement>(`[data-anchor="${ANCHORS.projectVideoGeneration}"]`)!);
    await expect(await block.findByText(MEDIA_PROVIDERS.manual.settingsNotes.video!)).toBeVisible();
    await expect(block.getByRole('combobox', { name: projectTexts.generation.videoProvider })).toHaveTextContent(MEDIA_PROVIDERS.manual.title);
    await expect(block.queryByRole('combobox', { name: projectTexts.generation.preferredVideoModel })).not.toBeInTheDocument();
    // Требования проекта к видео остаются: по ним считается длительность среза и пакета.
    await expect(block.getByRole('combobox', { name: projectTexts.generation.durationRule })).toBeInTheDocument();
  }
};

/** Проект со сценарием: расход клипа по планам — две единицы, план без цены и план с неизвестным списанием. */
const spendOptions = (): StoryOptions => {
  const base = draftDialogOptions(true);
  const status = base.app!.status!;
  return {
    ...base,
    app: { ...base.app, status: { ...status, checks: { ...status.checks, scenes: true } } },
    createApi: () => {
      const overrides = base.createApi!() as ApiOverrides;
      const session = createStoryApi({
        ...overrides,
        production: {
          listBundles: async () => [],
          projectSpend: async () => ({
            shots: [],
            totals: [
              { provider: TEST_PROVIDER, unit: 'credits', amount: 1250, shots: ['M01', 'M02', 'M03', 'M04'] },
              { provider: null, unit: 'RUB', amount: 380, shots: ['M05', 'M06'] }
            ],
            unpriced: ['M07'],
            unknown: ['M08'],
            videos: 9,
            images: 4,
            manual: 2,
            ownImages: 3,
            rejected: 3
          })
        }
      });
      session.onCleanup(registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo));
      return session;
    }
  };
};

export const ClipSpend: Story = {
  name: 'Расход клипа · суммы по единицам, планы без цены ссылками',
  tags: ['ci'],
  parameters: { songframe: spendOptions() },
  play: async ({ canvasElement }) => {
    const card = within(await within(canvasElement).findByTestId('project-spend'));
    const spend = projectTexts.spend;
    await expect(await card.findByText(spend.total({ amount: '1250 кредитов', source: testProviderInfo.title, shots: 4 }))).toBeVisible();
    await expect(card.getByText(spend.total({ amount: '380 ₽', source: productionTexts.shotSpend.manualSource, shots: 2 }))).toBeVisible();
    await expect(card.getByRole('link', { name: 'M07' })).toHaveAttribute('href', '/project/production?shot=M07');
    await expect(card.getByRole('link', { name: 'M08' })).toHaveAttribute('href', '/project/production?shot=M08');
    await expect(card.getByText(spend.incomplete)).toBeVisible();
    await expect(card.getByText(spend.counts({ videos: 9, manual: 2, images: 4, ownImages: 3, rejected: 3 }))).toBeVisible();
  }
};

/** Проект-репозиторий Git: блок истории на странице с несохранённым сценарием. */
const historyOptions = (): StoryOptions => {
  const base = draftDialogOptions(true);
  return {
    ...base,
    createApi: () => {
      const overrides = base.createApi!() as ApiOverrides;
      return { ...overrides, projectHistory: historyApi({ sections: ['scenario'], changedFiles: 1 }) };
    }
  };
};

export const ProjectHistory: Story = {
  name: 'История проекта · несохранённый сценарий',
  tags: ['ci'],
  parameters: { songframe: historyOptions() },
  play: async ({ canvasElement }) => {
    const card = within(await within(canvasElement).findByTestId('project-history'));
    const history = projectTexts.history;
    await expect(await card.findByText(history.unsaved({ sections: navigationTexts.pages.scenario, files: 1 }))).toBeVisible();
    await expect(card.getByRole('button', { name: history.save })).toBeEnabled();
    await expect(card.getAllByTestId('project-point')).toHaveLength(3);
  }
};
