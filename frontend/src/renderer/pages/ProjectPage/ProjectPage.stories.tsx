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
import type { ApiOverrides, StoryOptions } from '../../testing/storybook';
import { ANCHORS } from '../../components/linkTargets';
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
