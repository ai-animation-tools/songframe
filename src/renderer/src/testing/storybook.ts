/** Типизированное окружение историй: только локальные модели, без Electron и рабочего проекта. */
import type { Api } from '@shared/api';
import type { AppContextValue } from '../state';
import { unconfiguredStoryApi } from './storybook-api';

export type ApiOverrides = { [Group in keyof Api]?: Partial<Api[Group]> };

export interface StoryOptions {
  app?: Partial<AppContextValue>;
  route?: string;
  /** 'page' добавляет упрощённую шапку, обработку ?anchor= и показ маршрута для историй целых страниц. */
  shell?: 'block' | 'page';
  workspaceWidth?: number;
  createApi?: () => ApiOverrides | StoryApiSession;
}

export const STORY_VIDEO_PATH = '/mock/story-video.mp4';
export const STORY_IMAGE_PATH = '/mock/story-image.png';
export const STORY_TRACK_PATH = '/mock/story-track.mp3';

/** Допускаются только известные файлы витрины; неизвестный путь даёт видимую ошибку загрузки. */
export function storyFileUrl(path: string, baseUrl = globalThis.location?.href ?? 'http://storybook.local/iframe.html'): string {
  const normalized = path.replaceAll('\\', '/');
  const suffixIndex = normalized.search(/[?#]/);
  const file = suffixIndex < 0 ? normalized : normalized.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? '' : normalized.slice(suffixIndex);
  const name = file.slice(file.lastIndexOf('/') + 1);
  const known = [
    'story-video.mp4',
    'story-image.png',
    'story-track.mp3',
    'story-derived-source-150.mp4',
    'story-derived-preview-92.mp4',
    'story-derived-preview-62.mp4',
    'story-derived-still-92.mp4'
  ];
  const relative = known.includes(name) ? `media/${name}` : 'media/missing-story-file';
  return new URL(relative + suffix, baseUrl).href;
}

function eventChannel<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener: (value: T) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(value: T): void {
      for (const listener of listeners) listener(value);
    },
    clear(): void {
      listeners.clear();
    }
  };
}

type EventPayload<Group extends keyof Api, Method extends keyof Api[Group]> = Api[Group][Method] extends (listener: (value: infer Value) => void) => () => void
  ? Value
  : never;

export interface StoryApiSession {
  api: Api;
  emit: {
    agentEvent(value: EventPayload<'agents', 'onEvent'>): void;
    notificationOpen(value: EventPayload<'notifications', 'onOpen'>): void;
    loginUrl(value: EventPayload<'environment', 'onLoginUrl'>): void;
    montageMessage(value: EventPayload<'montageWindow', 'onMessage'>): void;
    montageClosed(value: EventPayload<'montageWindow', 'onClosed'>): void;
  };
  /** Таймеры, object URL и регистрации провайдеров принадлежат создавшей их истории. */
  onCleanup(cleanup: () => void): void;
  dispose(): void;
}

/** Каждый вызов создаёт отдельные методы и подписки; полный Api проверяется компилятором. */
export function createStoryApi(overrides: ApiOverrides = {}, faults: { missingReferenceImageInspection?: boolean } = {}): StoryApiSession {
  const agent = eventChannel<EventPayload<'agents', 'onEvent'>>();
  const notification = eventChannel<EventPayload<'notifications', 'onOpen'>>();
  const login = eventChannel<EventPayload<'environment', 'onLoginUrl'>>();
  const message = eventChannel<EventPayload<'montageWindow', 'onMessage'>>();
  const closed = eventChannel<EventPayload<'montageWindow', 'onClosed'>>();
  const cleanups = new Set<() => void>();
  let disposed = false;
  const defaults = unconfiguredStoryApi();
  const assertActive = (): void => {
    if (disposed) throw new Error('Storybook: сессия истории уже закрыта.');
  };
  // Отложенный ответ прежней истории отклоняется до продолжения её цепочки действий.
  const guardedAsync =
    <Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      assertActive();
      const result = await operation(...args);
      assertActive();
      return result;
    };
  const guardedSync =
    <Args extends unknown[], Result>(operation: (...args: Args) => Result) =>
    (...args: Args): Result => {
      assertActive();
      return operation(...args);
    };
  const merged: Api = {
    ...defaults,
    ai: { ...defaults.ai, ...overrides.ai },
    updates: { ...defaults.updates, ...overrides.updates },
    cover: { ...defaults.cover, ...overrides.cover },
    referenceImages: { ...defaults.referenceImages, ...overrides.referenceImages },
    derivedShots: { ...defaults.derivedShots, ...overrides.derivedShots },
    montage: { ...defaults.montage, ...overrides.montage },
    montageWindow: { ...defaults.montageWindow, onMessage: message.subscribe, onClosed: closed.subscribe, ...overrides.montageWindow },
    notifications: { ...defaults.notifications, onOpen: notification.subscribe, ...overrides.notifications },
    media: { ...defaults.media, ...overrides.media },
    videoReview: { ...defaults.videoReview, ...overrides.videoReview },
    productionWorkflow: { ...defaults.productionWorkflow, ...overrides.productionWorkflow },
    scenarioWorkflow: { ...defaults.scenarioWorkflow, ...overrides.scenarioWorkflow },
    agents: { ...defaults.agents, onEvent: agent.subscribe, ...overrides.agents },
    app: { ...defaults.app, ...overrides.app },
    projects: { ...defaults.projects, ...overrides.projects },
    sources: { ...defaults.sources, ...overrides.sources },
    timing: { ...defaults.timing, ...overrides.timing },
    cast: { ...defaults.cast, ...overrides.cast },
    scenario: { ...defaults.scenario, ...overrides.scenario },
    production: { ...defaults.production, ...overrides.production },
    dashboard: { ...defaults.dashboard, ...overrides.dashboard },
    animatic: { ...defaults.animatic, ...overrides.animatic },
    checks: { ...defaults.checks, ...overrides.checks },
    jobs: { ...defaults.jobs, ...overrides.jobs },
    diagnostics: { ...defaults.diagnostics, ...overrides.diagnostics },
    environment: { ...defaults.environment, onLoginUrl: login.subscribe, ...overrides.environment },
    tools: { ...defaults.tools, ...overrides.tools },
    dialog: { ...defaults.dialog, ...overrides.dialog },
    shell: { ...defaults.shell, fileUrl: storyFileUrl, ...overrides.shell }
  };
  const api: Api = {
    ai: {
      access: guardedAsync(merged.ai.access)
    },
    updates: {
      view: guardedAsync(merged.updates.view),
      check: guardedAsync(merged.updates.check),
      download: guardedAsync(merged.updates.download),
      install: guardedAsync(merged.updates.install)
    },
    cover: {
      create: guardedAsync(merged.cover.create),
      prepare: guardedAsync(merged.cover.prepare),
      generate: guardedAsync(merged.cover.generate),
      view: guardedAsync(merged.cover.view),
      accept: guardedAsync(merged.cover.accept),
      close: guardedAsync(merged.cover.close)
    },
    referenceImages: {
      inspect: guardedAsync(merged.referenceImages.inspect),
      context: guardedAsync(merged.referenceImages.context),
      create: guardedAsync(merged.referenceImages.create),
      prepare: guardedAsync(merged.referenceImages.prepare),
      generate: guardedAsync(merged.referenceImages.generate),
      view: guardedAsync(merged.referenceImages.view),
      accept: guardedAsync(merged.referenceImages.accept),
      close: guardedAsync(merged.referenceImages.close),
      attach: guardedAsync(merged.referenceImages.attach)
    },
    derivedShots: {
      view: guardedAsync(merged.derivedShots.view),
      save: guardedAsync(merged.derivedShots.save),
      build: guardedAsync(merged.derivedShots.build),
      accept: guardedAsync(merged.derivedShots.accept)
    },
    montage: {
      view: guardedAsync(merged.montage.view),
      load: guardedAsync(merged.montage.load),
      save: guardedAsync(merged.montage.save),
      export: guardedAsync(merged.montage.export),
      apply: guardedAsync(merged.montage.apply),
      saveVideo: guardedAsync(merged.montage.saveVideo)
    },
    montageWindow: {
      open: guardedAsync(merged.montageWindow.open),
      close: guardedAsync(merged.montageWindow.close),
      send: guardedSync(merged.montageWindow.send),
      onMessage: guardedSync(merged.montageWindow.onMessage),
      onClosed: guardedSync(merged.montageWindow.onClosed)
    },
    notifications: {
      onOpen: guardedSync(merged.notifications.onOpen)
    },
    media: {
      capabilities: guardedAsync(merged.media.capabilities)
    },
    videoReview: {
      view: guardedAsync(merged.videoReview.view),
      start: guardedAsync(merged.videoReview.start),
      cancel: guardedAsync(merged.videoReview.cancel)
    },
    productionWorkflow: {
      view: guardedAsync(merged.productionWorkflow.view),
      start: guardedAsync(merged.productionWorkflow.start),
      apply: guardedAsync(merged.productionWorkflow.apply),
      discard: guardedAsync(merged.productionWorkflow.discard),
      generateFrames: guardedAsync(merged.productionWorkflow.generateFrames),
      importFrames: guardedAsync(merged.productionWorkflow.importFrames)
    },
    scenarioWorkflow: {
      view: guardedAsync(merged.scenarioWorkflow.view),
      start: guardedAsync(merged.scenarioWorkflow.start),
      apply: guardedAsync(merged.scenarioWorkflow.apply),
      approveCurrent: guardedAsync(merged.scenarioWorkflow.approveCurrent),
      approveScenes: guardedAsync(merged.scenarioWorkflow.approveScenes),
      discard: guardedAsync(merged.scenarioWorkflow.discard)
    },
    agents: {
      getSettings: guardedAsync(merged.agents.getSettings),
      getProviderSettings: guardedAsync(merged.agents.getProviderSettings),
      saveProviderSettings: guardedAsync(merged.agents.saveProviderSettings),
      saveSettings: guardedAsync(merged.agents.saveSettings),
      check: guardedAsync(merged.agents.check),
      account: guardedAsync(merged.agents.account),
      models: guardedAsync(merged.agents.models),
      start: guardedAsync(merged.agents.start),
      cancel: guardedAsync(merged.agents.cancel),
      get: guardedAsync(merged.agents.get),
      list: guardedAsync(merged.agents.list),
      onEvent: guardedSync(merged.agents.onEvent)
    },
    app: {
      state: guardedAsync(merged.app.state),
      setToolsRoot: guardedAsync(merged.app.setToolsRoot)
    },
    projects: {
      open: guardedAsync(merged.projects.open),
      create: guardedAsync(merged.projects.create),
      validateNew: guardedAsync(merged.projects.validateNew),
      status: guardedAsync(merged.projects.status),
      rename: guardedAsync(merged.projects.rename),
      close: guardedAsync(merged.projects.close),
      forget: guardedAsync(merged.projects.forget),
      settings: guardedAsync(merged.projects.settings),
      saveSettings: guardedAsync(merged.projects.saveSettings)
    },
    sources: {
      view: guardedAsync(merged.sources.view),
      validate: guardedAsync(merged.sources.validate),
      save: guardedAsync(merged.sources.save)
    },
    timing: {
      modelSetup: guardedAsync(merged.timing.modelSetup),
      downloadModel: guardedAsync(merged.timing.downloadModel),
      view: guardedAsync(merged.timing.view),
      save: guardedAsync(merged.timing.save),
      generate: guardedAsync(merged.timing.generate)
    },
    cast: {
      view: guardedAsync(merged.cast.view),
      init: guardedAsync(merged.cast.init),
      save: guardedAsync(merged.cast.save)
    },
    scenario: {
      status: guardedAsync(merged.scenario.status),
      view: guardedAsync(merged.scenario.view),
      saveTreatment: guardedAsync(merged.scenario.saveTreatment),
      saveScenes: guardedAsync(merged.scenario.saveScenes),
      saveImpact: guardedAsync(merged.scenario.saveImpact),
      validateScenes: guardedAsync(merged.scenario.validateScenes),
      brief: guardedAsync(merged.scenario.brief)
    },
    production: {
      view: guardedAsync(merged.production.view),
      decide: guardedAsync(merged.production.decide),
      reopenFrame: guardedAsync(merged.production.reopenFrame),
      keepPackageForScene: guardedAsync(merged.production.keepPackageForScene),
      setKeyframeNote: guardedAsync(merged.production.setKeyframeNote),
      quote: guardedAsync(merged.production.quote),
      submit: guardedAsync(merged.production.submit),
      resume: guardedAsync(merged.production.resume),
      attachResult: guardedAsync(merged.production.attachResult),
      markNotCreated: guardedAsync(merged.production.markNotCreated),
      selectImage: guardedAsync(merged.production.selectImage),
      regenerate: guardedAsync(merged.production.regenerate),
      accept: guardedAsync(merged.production.accept),
      contactSheet: guardedAsync(merged.production.contactSheet),
      park: guardedAsync(merged.production.park),
      speechPlan: guardedAsync(merged.production.speechPlan),
      prepareSpeech: guardedAsync(merged.production.prepareSpeech),
      reopenQuestion: guardedAsync(merged.production.reopenQuestion),
      discardAttempt: guardedAsync(merged.production.discardAttempt),
      exportBundle: guardedAsync(merged.production.exportBundle),
      listBundles: guardedAsync(merged.production.listBundles),
      removeBundle: guardedAsync(merged.production.removeBundle)
    },
    dashboard: {
      view: guardedAsync(merged.dashboard.view)
    },
    animatic: {
      view: guardedAsync(merged.animatic.view),
      build: guardedAsync(merged.animatic.build),
      setStatus: guardedAsync(merged.animatic.setStatus)
    },
    checks: {
      list: guardedAsync(merged.checks.list),
      run: guardedAsync(merged.checks.run),
      runAll: guardedAsync(merged.checks.runAll),
      updateViews: guardedAsync(merged.checks.updateViews),
      buildReview: guardedAsync(merged.checks.buildReview),
      listReviews: guardedAsync(merged.checks.listReviews),
      removeReview: guardedAsync(merged.checks.removeReview)
    },
    jobs: {
      list: guardedAsync(merged.jobs.list),
      get: guardedAsync(merged.jobs.get),
      copyText: guardedAsync(merged.jobs.copyText)
    },
    diagnostics: {
      reportRendererError: guardedSync(merged.diagnostics.reportRendererError),
      crashNotice: guardedAsync(merged.diagnostics.crashNotice),
      saveReport: guardedAsync(merged.diagnostics.saveReport)
    },
    environment: {
      check: guardedAsync(merged.environment.check),
      loginProvider: guardedAsync(merged.environment.loginProvider),
      cancelLogin: guardedAsync(merged.environment.cancelLogin),
      onLoginUrl: guardedSync(merged.environment.onLoginUrl),
      providerAuth: guardedAsync(merged.environment.providerAuth)
    },
    tools: {
      run: guardedAsync(merged.tools.run)
    },
    dialog: {
      pickFolder: guardedAsync(merged.dialog.pickFolder),
      pickFiles: guardedAsync(merged.dialog.pickFiles)
    },
    shell: {
      openPath: guardedAsync(merged.shell.openPath),
      readText: guardedAsync(merged.shell.readText),
      fileUrl: guardedSync(merged.shell.fileUrl),
      pathForFile: guardedSync(merged.shell.pathForFile)
    }
  };
  // Моделируем старый preload после обёрток: отсутствующий метод должен дать undefined, а не отклонённый Promise.
  if (faults.missingReferenceImageInspection) Reflect.deleteProperty(api.referenceImages, 'inspect');
  return {
    api,
    emit: {
      agentEvent: agent.emit,
      notificationOpen: notification.emit,
      loginUrl: login.emit,
      montageMessage: message.emit,
      montageClosed: closed.emit
    },
    onCleanup(cleanup) {
      if (disposed) cleanup();
      else cleanups.add(cleanup);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      agent.clear();
      notification.clear();
      login.clear();
      message.clear();
      closed.clear();
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
    }
  };
}
