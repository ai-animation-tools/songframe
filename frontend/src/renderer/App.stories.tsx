import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { AppState } from '@shared/types';
import { shellTexts } from '@shared/texts/shell';
import { App } from './App';
import { RenderBoundary } from './components/RenderBoundary';
import { ReadyContent } from './components/ReadyContent';
import { createWorkspaceModel, projectFixture } from './testing/workspaceModel';
import { workspaceTexts as text } from '@shared/texts/workspace';

/** Независимый снимок Go-контракта: история не использует чужой профиль и не запускает настоящий мост. */
const state: AppState = { packaged: true, problems: [], toolsRoot: null, localDir: '/test/songframe-go-dev', current: null, history: [], platform: 'linux' };
const meta = {
  title: 'Оболочка/SongFrame',
  component: App,
  args: { loadState: async (): Promise<AppState> => ({ ...state, history: [] }), onReady: async () => undefined, bridge: createWorkspaceModel().bridge },
  tags: ['ci']
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: shellTexts.projectsTitle })).toBeVisible();
    await expect(canvas.getByRole('button', { name: shellTexts.openProject })).toBeEnabled();
  }
};
export const Dark: Story = { ...Ready, parameters: { dark: true } };
export const Loading: Story = {
  args: { loadState: () => new Promise<AppState>(() => undefined) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('status', { name: shellTexts.loading })).toBeVisible();
  }
};
export const StartupError: Story = {
  args: {
    loadState: async () => {
      throw new Error(shellTexts.profileProblem);
    }
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(shellTexts.profileProblem)).toBeVisible();
  }
};

/** Локальная модель воспроизводит отказ первого чтения и успешное повторное чтение без перезапуска окна. */
export const Retry: Story = {
  render: (args) => {
    let attempts = 0;
    return (
      <App
        {...args}
        loadState={async () => {
          attempts += 1;
          if (attempts === 1) throw new Error(shellTexts.profileProblem);
          return state;
        }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const retry = await canvas.findByRole('button', { name: shellTexts.retry });
    await userEvent.click(retry);
    await expect(await canvas.findByRole('heading', { name: shellTexts.projectsTitle })).toBeVisible();
    await expect(canvas.queryByText(shellTexts.startupError)).not.toBeInTheDocument();
  }
};
export const Unavailable: Story = {
  parameters: { route: '/project/scenario' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(shellTexts.unavailable)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: shellTexts.returnProjects }));
    await expect(await canvas.findByRole('heading', { name: shellTexts.projectsTitle })).toBeVisible();
  }
};

/** Ошибка потомка должна оставить действие восстановления; реальная диагностика здесь не отправляется. */
function BrokenPage(): never {
  throw new Error(shellTexts.profileProblem);
}
export const RenderError: Story = {
  args: { onReady: fn(async () => undefined) },
  render: (args) => (
    <RenderBoundary>
      <ReadyContent onReady={args.onReady ?? meta.args.onReady} onError={() => undefined}>
        <BrokenPage />
      </ReadyContent>
    </RenderBoundary>
  ),
  play: async ({ canvasElement, args }) => {
    await expect(await within(canvasElement).findByText(shellTexts.renderError)).toBeVisible();
    // Видимый fallback не считается готовой страницей и не разрешает завершить нативный smoke успехом.
    await expect(args.onReady).not.toHaveBeenCalled();
  }
};

/** История страницы проверяет чтение, физические номера и повторное открытие без сохранения. */
export const ReadOnlyTimings: Story = {
  args: { bridge: createWorkspaceModel().bridge },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: shellTexts.openProject }));
    await expect(await canvas.findByRole('heading', { name: 'Песня для проверки' })).toBeVisible();
    await expect(canvas.getByRole('cell', { name: 'Ручная граница' })).toBeVisible();
    await expect(canvas.getByText(text.verified, { exact: true })).toBeVisible();
    await expect(canvas.getByText(text.manual, { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: text.waveform }));
    await expect(await canvas.findByRole('img', { name: text.waveformLabel })).toBeVisible();
    await userEvent.click(canvas.getByRole('checkbox', { name: text.loop }));
    await expect(canvas.getByRole('checkbox', { name: text.loop })).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: text.preview }));
    await expect(canvas.getByRole('button', { name: text.preview })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(canvas.getByRole('button', { name: text.closeProject }));
    await userEvent.click(await canvas.findByRole('button', { name: text.openCopy }));
    await expect(await canvas.findByRole('cell', { name: 'Ручная граница' })).toBeVisible();
  }
};
export const ReadOnlyDark: Story = { ...ReadOnlyTimings, parameters: { dark: true }, args: { bridge: createWorkspaceModel().bridge } };
export const BlockedProject: Story = {
  args: {
    bridge: createWorkspaceModel(projectFixture({ blocked: true, lyricsText: '', timing: null, track: null, problems: ['Незавершённая публикация монтажа.'] }))
      .bridge
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: shellTexts.openProject }));
    await expect(await canvas.findByText(text.blocked)).toBeVisible();
    await expect(canvas.queryByRole('table')).not.toBeInTheDocument();
  }
};
export const MissingMedia: Story = {
  args: { bridge: createWorkspaceModel(projectFixture({ track: null })).bridge },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: shellTexts.openProject }));
    await expect(await canvas.findByText(text.missingMedia)).toBeVisible();
    await expect(canvas.getByRole('button', { name: text.playLine(2) })).toBeDisabled();
    await expect(canvas.getByRole('cell', { name: 'Ручная граница' })).toBeVisible();
  }
};
export const ProjectReadError: Story = {
  args: {
    bridge: createWorkspaceModel(undefined, {
      openProject: async () => {
        throw new Error('Не удалось прочитать plan/project.json');
      }
    }).bridge
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: shellTexts.openProject }));
    await waitFor(async () => expect(await canvas.findByText('Не удалось прочитать plan/project.json')).toBeVisible());
    await expect(canvas.getByRole('heading', { name: shellTexts.projectsTitle })).toBeVisible();
    await expect(canvas.getByRole('button', { name: shellTexts.openProject })).toBeEnabled();
  }
};
const notificationModel = createWorkspaceModel(projectFixture({ name: 'Проект уведомления' }));
export const NotificationTarget: Story = {
  args: { bridge: notificationModel.bridge },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: shellTexts.projectsTitle });
    notificationModel.emitNotification({ project: '/test/Проект уведомления', route: '/project/timing' });
    await expect(await canvas.findByRole('heading', { name: 'Проект уведомления' })).toBeVisible();
    await expect(notificationModel.counts().notifications).toBe(1);
  }
};
let finishOld: ((value: ReturnType<typeof projectFixture>) => void) | undefined;
const staleModel = createWorkspaceModel(undefined, {
  openProject: async (path) =>
    path === '/test/Старый'
      ? new Promise((resolve) => {
          finishOld = resolve;
        })
      : projectFixture({ name: 'Новый проект', path })
});
export const StaleProjectResponse: Story = {
  args: { bridge: staleModel.bridge },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: shellTexts.projectsTitle });
    staleModel.emitDrop({ windowID: 1, paths: ['/test/Старый'], targetID: 'project-drop' });
    staleModel.emitNotification({ project: '/test/Новый', route: '/project/timing' });
    await expect(await canvas.findByRole('heading', { name: 'Новый проект' })).toBeVisible();
    finishOld?.(projectFixture({ name: 'Старый проект' }));
    await expect(canvas.queryByRole('heading', { name: 'Старый проект' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('heading', { name: 'Новый проект' })).toBeVisible();
  }
};

export const ProjectLoading: Story = {
  args: { bridge: createWorkspaceModel(undefined, { openProject: () => new Promise(() => undefined) }).bridge },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: shellTexts.openProject }));
    await expect(await canvas.findByRole('button', { name: text.opening })).toBeDisabled();
  }
};
export const WaveformError: Story = {
  args: { bridge: createWorkspaceModel().bridge },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: shellTexts.openProject }));
    const button = await canvas.findByRole('button', { name: text.waveform });
    const previous = globalThis.AudioContext;
    try {
      Object.defineProperty(globalThis, 'AudioContext', {
        configurable: true,
        writable: true,
        value: class {
          constructor() {
            throw new Error('Аудиоконтекст недоступен');
          }
        }
      });
      await userEvent.click(button);
      await expect(await canvas.findByText('Аудиоконтекст недоступен')).toBeVisible();
      await expect(canvas.getByRole('button', { name: text.waveform })).toBeEnabled();
    } finally {
      Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: previous });
    }
  }
};

/** Длинные имена и пути не расширяют окно и не закрывают действия страницы. */
export const LongProjectPath: Story = {
  args: {
    bridge: createWorkspaceModel(
      projectFixture({
        name: 'ОченьДлинноеНазваниеПесни'.repeat(8),
        path: '/test/' + 'Папка с длинным названием/'.repeat(9),
        track: { ...projectFixture().track!, path: '/test/' + 'Папка с длинным названием/'.repeat(9) + 'Песня.wav' }
      })
    ).bridge
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: shellTexts.openProject }));
    await expect(await canvas.findByRole('button', { name: text.closeProject })).toBeVisible();
  }
};

const replacementTrack = projectFixture().track!;
const mediaChangeModel = createWorkspaceModel(undefined, { media: async (path) => ({ ...replacementTrack, path, url: replacementTrack.url + '#selected' }) });
/** Позиция выбранной строки принадлежит исходному треку и не запускает другой файл после drop. */
export const ChangedMediaStopsOldSeek: Story = {
  args: { bridge: mediaChangeModel.bridge },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: shellTexts.openProject }));
    const first = (await canvas.findByLabelText(text.player)) as HTMLAudioElement;
    await waitFor(() => expect(first.readyState).toBeGreaterThanOrEqual(1));
    await userEvent.click(canvas.getByRole('button', { name: text.playLine(2) }));
    mediaChangeModel.emitDrop({ windowID: 1, targetID: 'media-drop', paths: ['/test/Другой файл.wav'] });
    await expect(await canvas.findByText('/test/Другой файл.wav')).toBeVisible();
    const replacement = canvas.getByLabelText(text.player) as HTMLAudioElement;
    await waitFor(() => expect(replacement.readyState).toBeGreaterThanOrEqual(1));
    await expect(replacement.paused).toBe(true);
    await expect(replacement.currentTime).toBe(0);
  }
};

let versionRead = 0;
const versionModel = createWorkspaceModel(undefined, {
  openProject: async () => projectFixture({ trackSha256: versionRead++ === 0 ? 'fixture-track' : 'replaced-track' })
});
/** Замена трека по тому же пути сбрасывает старый media buffer и не повторяет старый seek. */
export const ChangedTrackVersion: Story = {
  args: { bridge: versionModel.bridge },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: shellTexts.openProject }));
    const first = (await canvas.findByLabelText(text.player)) as HTMLAudioElement;
    await waitFor(() => expect(first.readyState).toBeGreaterThanOrEqual(1));
    await userEvent.click(canvas.getByRole('button', { name: text.playLine(2) }));
    await userEvent.click(canvas.getByRole('button', { name: text.refresh }));
    await waitFor(() => expect(canvas.getByLabelText(text.player)).not.toBe(first));
    const replaced = canvas.getByLabelText(text.player) as HTMLAudioElement;
    await waitFor(() => expect(replaced.readyState).toBeGreaterThanOrEqual(1));
    await expect(replaced.paused).toBe(true);
    await expect(replaced.currentTime).toBe(0);
  }
};
