/** Создание проекта на локальной модели API: проверка формы и выбранная частота кадров доходят до create. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { commonTexts } from '@shared/texts/common';
import { projectsTexts } from '@shared/texts/projects';
import type { CreateProjectInput, ProjectStatus } from '@shared/types';
import { storyAccess } from '../../testing/commonStories';
import type { StoryOptions } from '../../testing/storybook';
import { NewProjectPage } from './NewProjectPage';

/** Последние входы проверки и создания: play сверяет, что выбранная частота отправлена в Go. */
const calls: { validated: CreateProjectInput[]; created: CreateProjectInput[] } = { validated: [], created: [] };

function createdStatus(input: CreateProjectInput): ProjectStatus {
  return {
    path: input.path,
    name: input.name,
    state: 'empty',
    animaticVideo: input.animaticVideo ?? null,
    fps: input.fps ?? 30,
    problems: [],
    checks: {
      marker: true,
      sources: false,
      timing: false,
      cast: false,
      treatment: false,
      scenes: false,
      shotsTotal: 0,
      shotsDone: 0,
      animaticBuilt: false,
      animaticFresh: false,
      animaticApproved: false
    }
  };
}

function options(): StoryOptions {
  return {
    shell: 'page',
    route: '/projects/new',
    app: {
      aiAccess: storyAccess,
      agentProvider: 'codex',
      status: null,
      state: { packaged: false, problems: [], localDir: '/mock/state', current: null, history: [], platform: 'linux' },
      refresh: async () => undefined
    },
    createApi: () => {
      calls.validated = [];
      calls.created = [];
      return {
        projects: {
          validateNew: async (input) => {
            calls.validated.push(input);
            return [];
          },
          create: async (input) => {
            calls.created.push(input);
            return createdStatus(input);
          }
        }
      };
    }
  };
}

const meta = {
  title: 'Страницы/Новый проект',
  component: NewProjectPage,
  tags: ['!autodocs'],
  parameters: { songframe: options() }
} satisfies Meta<typeof NewProjectPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  name: 'Новый проект · частота по умолчанию 30 кадров/с'
};

export const FrameRate24: Story = {
  name: 'Новый проект · выбор 24 кадров/с',
  tags: ['ci'],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    // Страница монтируется заново при установке API истории: ввод начинается с окончательной формы.
    await waitFor(() => expect(canvas.getByRole('textbox', { name: projectsTexts.clipName })).toHaveFocus());
    const name = canvas.getByRole('textbox', { name: projectsTexts.clipName });
    await userEvent.type(name, 'Клип у ворот');
    const path = canvas.getByRole('textbox', { name: projectsTexts.folderPath });
    await userEvent.type(path, '/mock/clips/klip-u-vorot');
    await expect(name).toHaveValue('Клип у ворот');
    await expect(path).toHaveValue('/mock/clips/klip-u-vorot');
    const rate = canvas.getByRole('combobox', { name: projectsTexts.frameRate });
    await expect(rate).toHaveTextContent(projectsTexts.frameRateOption(30));
    await userEvent.click(rate);
    await userEvent.click(await screen.findByRole('option', { name: projectsTexts.frameRateOption(24) }));
    await expect(rate).toHaveTextContent(projectsTexts.frameRateOption(24));
    // Проверка формы откладывается на 250 мс после последнего изменения и повторяется после выбора частоты.
    // Доступная кнопка отрисовывается заново (без обёртки причины), поэтому ищется внутри ожидания.
    await waitFor(() => expect(canvas.getByRole('button', { name: commonTexts.create })).toBeEnabled(), { timeout: 4000 });
    await expect(calls.validated.at(-1)?.fps).toBe(24);
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.create }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    await expect(calls.created[0]).toMatchObject({ name: 'Клип у ворот', path: '/mock/clips/klip-u-vorot', fps: 24 });
  }
};
