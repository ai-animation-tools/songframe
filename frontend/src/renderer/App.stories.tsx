import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { AppState } from '@shared/types';
import { shellTexts } from '@shared/texts/shell';
import { App } from './App';
import { createComponentsModel } from './testing/componentsModel';
import { componentTexts } from '@shared/texts/components';
import { RenderBoundary } from './components/RenderBoundary';
import { ReadyContent } from './components/ReadyContent';
import { createWorkspaceModel, projectFixture } from './testing/workspaceModel';
import { AppLifecycleHarness, lifecycleTexts } from './testing/AppLifecycleHarness';
import { workspaceTexts as text } from '@shared/texts/workspace';

/** Независимый снимок Go-контракта: история не использует чужой профиль и не запускает настоящий мост. */
const state: AppState = { packaged: true, problems: [], toolsRoot: null, localDir: '/test/songframe-go-dev', current: null, history: [], platform: 'linux' };
const meta = {
  title: 'Оболочка/SongFrame',
  component: App,
  args: {
    loadState: async (): Promise<AppState> => ({ ...state, history: [] }),
    onReady: async () => undefined,
    bridge: createWorkspaceModel().bridge,
    componentsApi: createComponentsModel().api
  },
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

/** Каждая тема получает отдельный транспорт; spy считает реальные обращения страницы к openProject. */
function lifecycleStory(dark: boolean): Story {
  const snapshot = projectFixture();
  const openProject = fn(async () => structuredClone(snapshot));
  const model = createWorkspaceModel(snapshot, { openProject });
  return {
    parameters: { dark },
    args: { bridge: model.bridge },
    render: (args) => <AppLifecycleHarness {...args} />,
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      let previousSession: string | undefined;
      for (let cycle = 0; cycle < 3; cycle++) {
        await expect(await canvas.findByRole('heading', { name: shellTexts.projectsTitle })).toBeVisible();
        await waitFor(() => expect(model.counts()).toEqual({ drops: 1, notifications: 1, closed: 0 }));
        const callsBefore = openProject.mock.calls.length;
        if (cycle % 2 === 0) model.emitDrop({ windowID: 1, paths: [snapshot.path], targetID: 'project-drop' });
        else model.emitNotification({ project: snapshot.path, route: '/project/timing' });
        await expect(await canvas.findByRole('heading', { name: snapshot.name })).toBeVisible();
        await expect(openProject).toHaveBeenCalledTimes(callsBefore + 1);
        await waitFor(() => expect(model.counts()).toEqual({ drops: 1, notifications: 1, closed: 1 }));

        const preview = canvas.getByRole('button', { name: text.preview });
        await userEvent.click(preview);
        await waitFor(() => expect(model.previews.size).toBe(1));
        await expect(preview).toHaveAttribute('aria-pressed', 'true');
        const session = [...model.previews.keys()][0];
        await expect(session).not.toBe(previousSession);
        previousSession = session;
        // Закрытие отдельного окна приходит через подписку; повторное открытие сохраняет работающий плеер.
        await model.bridge.closePreview(session);
        await waitFor(() => expect(preview).toHaveAttribute('aria-pressed', 'false'));
        await userEvent.click(preview);
        await waitFor(() => expect(model.previews.size).toBe(1));
        await expect(preview).toHaveAttribute('aria-pressed', 'true');

        await userEvent.click(canvas.getByRole('button', { name: lifecycleTexts.unmount }));
        await waitFor(() => expect(model.counts()).toEqual({ drops: 0, notifications: 0, closed: 0 }));
        await waitFor(() => expect(model.previews.size).toBe(0));
        await expect(canvas.queryByLabelText(text.player)).not.toBeInTheDocument();
        await expect(canvas.queryByRole('heading', { name: snapshot.name })).not.toBeInTheDocument();
        // События после удаления дерева не должны читать проект или оживлять прежнее окно.
        model.emitDrop({ windowID: 1, paths: [snapshot.path], targetID: 'project-drop' });
        model.emitNotification({ project: snapshot.path, route: '/project/timing' });
        await expect(openProject).toHaveBeenCalledTimes(callsBefore + 1);
        await userEvent.click(canvas.getByRole('button', { name: lifecycleTexts.mount }));
      }

      // Уход только со страницы снимает её preview-подписку, оставляя подписки живого Workspace.
      await userEvent.click(await canvas.findByRole('button', { name: shellTexts.openProject }));
      await userEvent.click(await canvas.findByRole('button', { name: text.preview }));
      await waitFor(() => expect(model.previews.size).toBe(1));
      await userEvent.click(canvas.getByRole('button', { name: text.closeProject }));
      await expect(await canvas.findByRole('heading', { name: shellTexts.projectsTitle })).toBeVisible();
      await waitFor(() => expect(model.counts()).toEqual({ drops: 1, notifications: 1, closed: 0 }));
      await waitFor(() => expect(model.previews.size).toBe(0));
      await userEvent.click(canvas.getByRole('button', { name: lifecycleTexts.unmount }));
      await waitFor(() => expect(model.counts()).toEqual({ drops: 0, notifications: 0, closed: 0 }));
    }
  };
}

export const RepeatedMount: Story = lifecycleStory(false);
export const RepeatedMountDark: Story = lifecycleStory(true);

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

/** Полная оболочка сохраняет проект и возвращает к таймингам без запуска обработки. */
export const ComponentsContext: Story = {
  args: { bridge: createWorkspaceModel().bridge, componentsApi: createComponentsModel().api },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: shellTexts.openProject }));
    await userEvent.click(await canvas.findByRole('button', { name: componentTexts.open }));
    await expect(await canvas.findByRole('heading', { name: componentTexts.title })).toBeVisible();
    await expect(canvas.getByText(componentTexts.returnHint)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: /Проверить компоненты|Перепроверить файлы|Обновить/ })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: componentTexts.return }));
    await expect(await canvas.findByRole('cell', { name: 'Ручная граница' })).toBeVisible();
    await userEvent.click(canvas.getByRole('link', { name: componentTexts.title }));
    await expect(await canvas.findByRole('heading', { name: componentTexts.title })).toBeVisible();
  }
};
export const ComponentsDark: Story = {
  ...ComponentsContext,
  parameters: { dark: true },
  args: { bridge: createWorkspaceModel().bridge, componentsApi: createComponentsModel().api }
};
export const ComponentsSettings: Story = {
  parameters: { route: '/settings' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: componentTexts.open }));
    await expect(await canvas.findByRole('heading', { name: componentTexts.title })).toBeVisible();
  }
};

/** Фоновая проверка не удерживает навигацию; повторный mount не запускает её заново. */
const checkingModel = createComponentsModel({ startupDelay: 60000 });
export const ComponentsCheckingNavigation: Story = {
  parameters: { route: '/components' },
  args: { componentsApi: checkingModel.api },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(componentTexts.checking)).toBeVisible();
    const count = checkingModel.counters().checks;
    await userEvent.click(canvas.getByRole('link', { name: 'Настройки' }));
    await expect(await canvas.findByRole('heading', { name: 'Настройки' })).toBeVisible();
    await userEvent.click(canvas.getByRole('link', { name: componentTexts.title }));
    await expect(await canvas.findByText(componentTexts.checking)).toBeVisible();
    await expect(checkingModel.counters().checks).toBe(count);
    await expect(checkingModel.counters().manualChecks).toBe(0);
  }
};
