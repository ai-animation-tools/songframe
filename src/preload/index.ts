/** Мост рендерера к главному процессу: только типизированные вызовы, без прямого доступа к Node. */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { toLocalFileUrl, type Api } from '@shared/api';
import type { AgentEvent, AgentSettings, AgentStartInput } from '@shared/agents';
import type { ProductionFrameCandidate, ProductionWorkflowStart } from '@shared/production-workflow';
import type { MediaKind } from '@shared/media-providers';
import type { ScenarioWorkflowStart } from '@shared/scenario-workflow';
import type { NotificationTarget } from '@shared/notifications';
import type { MontageWindowEvent } from '@shared/montage-window';
import type {
  AcceptOptions,
  CastFile,
  CheckId,
  CheckOptions,
  ExportBundleOptions,
  CreateProjectInput,
  EnvironmentCheck,
  PickOptions,
  ProjectSettings,
  ReviewOptions,
  ScenesFile,
  ScenesSaveMode,
  KeyframeNoteScope,
  SourcesInput,
  TimingFile,
  TimingGenerateOptions,
  TreatmentFile
} from '@shared/types';

const agentListeners = new Set<(event: AgentEvent) => void>();
let environmentRequest = 0;
const relayAgentEvent = (_event: Electron.IpcRendererEvent, value: AgentEvent): void => {
  for (const listener of agentListeners) listener(value);
};

const api: Api = {
  ai: { access: (project) => ipcRenderer.invoke('ai:access', project) },
  cover: {
    create: (project, prompt) => ipcRenderer.invoke('cover:create', project, prompt),
    prepare: (id) => ipcRenderer.invoke('cover:prepare', id),
    generate: (id, requestSha, approval) => ipcRenderer.invoke('cover:generate', id, requestSha, approval),
    view: (id) => ipcRenderer.invoke('cover:view', id),
    accept: (id, crop) => ipcRenderer.invoke('cover:accept', id, crop),
    close: (id) => ipcRenderer.invoke('cover:close', id)
  },
  referenceImages: {
    create: (project, prompt) => ipcRenderer.invoke('referenceImages:create', project, prompt),
    prepare: (id) => ipcRenderer.invoke('referenceImages:prepare', id),
    generate: (id, requestSha, approval) => ipcRenderer.invoke('referenceImages:generate', id, requestSha, approval),
    view: (id) => ipcRenderer.invoke('referenceImages:view', id),
    accept: (id) => ipcRenderer.invoke('referenceImages:accept', id),
    attach: (id, entityId) => ipcRenderer.invoke('referenceImages:attach', id, entityId),
    close: (id) => ipcRenderer.invoke('referenceImages:close', id)
  },
  montageWindow: {
    open: (session) => ipcRenderer.invoke('montage-window:open', session),
    close: (session) => ipcRenderer.invoke('montage-window:close', session),
    send: (message) => ipcRenderer.send('montage-window:message', message),
    onMessage: (listener) => {
      const relay = (_event: Electron.IpcRendererEvent, value: MontageWindowEvent): void => listener(value);
      ipcRenderer.on('montage-window:message', relay);
      return () => ipcRenderer.removeListener('montage-window:message', relay);
    },
    onClosed: (listener) => {
      const relay = (_event: Electron.IpcRendererEvent, session: string): void => listener(session);
      ipcRenderer.on('montage-window:closed', relay);
      return () => ipcRenderer.removeListener('montage-window:closed', relay);
    }
  },
  montage: {
    view: (project) => ipcRenderer.invoke('montage:view', project),
    load: (project, id) => ipcRenderer.invoke('montage:load', project, id),
    save: (project, draft, id) => ipcRenderer.invoke('montage:save', project, draft, id),
    export: (project, draft) => ipcRenderer.invoke('montage:export', project, draft),
    apply: (project, draft) => ipcRenderer.invoke('montage:apply', project, draft),
    saveVideo: (project, video) => ipcRenderer.invoke('montage:saveVideo', project, video)
  },
  notifications: {
    onOpen: (listener) => {
      // В renderer передаём только адрес перехода, без служебного события Electron.
      const relay = (_event: Electron.IpcRendererEvent, target: NotificationTarget): void => listener(target);
      ipcRenderer.on('notifications:open', relay);
      return () => {
        ipcRenderer.removeListener('notifications:open', relay);
      };
    }
  },
  media: {
    capabilities: (project: string, kind: MediaKind, provider: string) => ipcRenderer.invoke('media:capabilities', project, kind, provider)
  },
  productionWorkflow: {
    view: (project: string, shot: string, packageDir?: string) => ipcRenderer.invoke('productionWorkflow:view', project, shot, packageDir),
    start: (input: ProductionWorkflowStart) => ipcRenderer.invoke('productionWorkflow:start', input),
    apply: (project: string, shot: string, packageDir: string | undefined, id: string) =>
      ipcRenderer.invoke('productionWorkflow:apply', project, shot, packageDir, id),
    discard: (project: string, shot: string, packageDir: string | undefined, id: string) =>
      ipcRenderer.invoke('productionWorkflow:discard', project, shot, packageDir, id),
    generateFrames: (project: string, shot: string, packageDir: string) => ipcRenderer.invoke('productionWorkflow:generateFrames', project, shot, packageDir),
    importFrames: (project: string, shot: string, packageDir: string, images: ProductionFrameCandidate[]) =>
      ipcRenderer.invoke('productionWorkflow:importFrames', project, shot, packageDir, images)
  },
  scenarioWorkflow: {
    view: (project: string) => ipcRenderer.invoke('scenarioWorkflow:view', project),
    start: (input: ScenarioWorkflowStart) => ipcRenderer.invoke('scenarioWorkflow:start', input),
    apply: (project: string, id: string) => ipcRenderer.invoke('scenarioWorkflow:apply', project, id),
    approveCurrent: (project: string) => ipcRenderer.invoke('scenarioWorkflow:approveCurrent', project),
    approveScenes: (project: string) => ipcRenderer.invoke('scenarioWorkflow:approveScenes', project),
    discard: (project: string, id: string) => ipcRenderer.invoke('scenarioWorkflow:discard', project, id)
  },
  agents: {
    getSettings: () => ipcRenderer.invoke('agents:getSettings'),
    getProviderSettings: (provider) => ipcRenderer.invoke('agents:getProviderSettings', provider),
    saveProviderSettings: (settings) => ipcRenderer.invoke('agents:saveProviderSettings', settings),
    saveSettings: (settings: AgentSettings | null) => ipcRenderer.invoke('agents:saveSettings', settings),
    check: (settings: AgentSettings) => ipcRenderer.invoke('agents:check', settings),
    account: (settings: AgentSettings) => ipcRenderer.invoke('agents:account', settings),
    models: (settings: AgentSettings) => ipcRenderer.invoke('agents:models', settings),
    start: (input: AgentStartInput) => ipcRenderer.invoke('agents:start', input),
    cancel: (id: string) => ipcRenderer.invoke('agents:cancel', id),
    get: (id: string) => ipcRenderer.invoke('agents:get', id),
    list: (project?: string) => ipcRenderer.invoke('agents:list', project),
    onEvent: (listener) => {
      agentListeners.add(listener);
      if (agentListeners.size === 1) {
        ipcRenderer.on('agents:event', relayAgentEvent);
        ipcRenderer.send('agents:subscribe');
      }
      return () => {
        agentListeners.delete(listener);
        if (!agentListeners.size) {
          ipcRenderer.removeListener('agents:event', relayAgentEvent);
          ipcRenderer.send('agents:unsubscribe');
        }
      };
    }
  },
  app: {
    state: () => ipcRenderer.invoke('app:state'),
    setToolsRoot: (path: string | null) => ipcRenderer.invoke('app:setToolsRoot', path)
  },
  projects: {
    open: (path: string) => ipcRenderer.invoke('projects:open', path),
    create: (input: CreateProjectInput) => ipcRenderer.invoke('projects:create', input),
    validateNew: (input: CreateProjectInput) => ipcRenderer.invoke('projects:validateNew', input),
    status: (path: string) => ipcRenderer.invoke('projects:status', path),
    rename: (path: string, name: string) => ipcRenderer.invoke('projects:rename', path, name),
    close: () => ipcRenderer.invoke('projects:close'),
    forget: (path: string) => ipcRenderer.invoke('projects:forget', path),
    settings: (project: string) => ipcRenderer.invoke('projects:settings', project),
    saveSettings: (project: string, settings: ProjectSettings) => ipcRenderer.invoke('projects:saveSettings', project, settings)
  },
  sources: {
    view: (project: string) => ipcRenderer.invoke('sources:view', project),
    validate: (project: string, input: SourcesInput) => ipcRenderer.invoke('sources:validate', project, input),
    save: (project: string, input: SourcesInput) => ipcRenderer.invoke('sources:save', project, input)
  },
  timing: {
    modelSetup: () => ipcRenderer.invoke('timing:modelSetup'),
    downloadModel: (model) => ipcRenderer.invoke('timing:downloadModel', model),
    view: (project: string) => ipcRenderer.invoke('timing:view', project),
    save: (project: string, timing: TimingFile) => ipcRenderer.invoke('timing:save', project, timing),
    generate: (project: string, options: TimingGenerateOptions) => ipcRenderer.invoke('timing:generate', project, options)
  },
  cast: {
    view: (project: string) => ipcRenderer.invoke('cast:view', project),
    init: (project: string) => ipcRenderer.invoke('cast:init', project),
    save: (project: string, cast: CastFile) => ipcRenderer.invoke('cast:save', project, cast)
  },
  scenario: {
    status: (project: string) => ipcRenderer.invoke('scenario:status', project),
    view: (project: string) => ipcRenderer.invoke('scenario:view', project),
    saveTreatment: (project: string, treatment: TreatmentFile) => ipcRenderer.invoke('scenario:saveTreatment', project, treatment),
    saveScenes: (project: string, scenes: ScenesFile, mode: ScenesSaveMode) => ipcRenderer.invoke('scenario:saveScenes', project, scenes, mode),
    saveImpact: (project: string, scenes: ScenesFile) => ipcRenderer.invoke('scenario:saveImpact', project, scenes),
    validateScenes: (project: string, scenes: ScenesFile) => ipcRenderer.invoke('scenario:validateScenes', project, scenes),
    brief: (project: string, scenes: ScenesFile, shot: string, phase: 'before' | 'after') => ipcRenderer.invoke('scenario:brief', project, scenes, shot, phase)
  },
  production: {
    view: (project: string) => ipcRenderer.invoke('production:view', project),
    decide: (project: string, packageDir: string, verdict: string, note?: string, decisionToken?: string, noteScope?: KeyframeNoteScope) =>
      ipcRenderer.invoke('production:decide', project, packageDir, verdict, note ?? '', decisionToken, noteScope),
    reopenFrame: (project: string, packageDir: string, frame: string, note: string, noteScope: KeyframeNoteScope) =>
      ipcRenderer.invoke('production:reopenFrame', project, packageDir, frame, note, noteScope),
    keepPackageForScene: (project: string, packageDir: string) => ipcRenderer.invoke('production:keepPackageForScene', project, packageDir),
    setKeyframeNote: (project: string, packageDir: string, id: number, active: boolean) =>
      ipcRenderer.invoke('production:setKeyframeNote', project, packageDir, id, active),
    quote: (project: string, packageDir: string, expectedSha: string, decisionToken?: string) =>
      ipcRenderer.invoke('production:quote', project, packageDir, expectedSha, decisionToken),
    submit: (project: string, packageDir: string, expectedSha: string, decisionToken?: string, quoteToken?: string, unknownCostConsentToken?: string) =>
      ipcRenderer.invoke('production:submit', project, packageDir, expectedSha, decisionToken, quoteToken, unknownCostConsentToken),
    resume: (project: string, packageDir: string) => ipcRenderer.invoke('production:resume', project, packageDir),
    attachResult: (project: string, packageDir: string, files: string[]) => ipcRenderer.invoke('production:attachResult', project, packageDir, files),
    markNotCreated: (project: string, packageDir: string) => ipcRenderer.invoke('production:markNotCreated', project, packageDir),
    selectImage: (project: string, packageDir: string, index: number, expectedResultToken: string) =>
      ipcRenderer.invoke('production:selectImage', project, packageDir, index, expectedResultToken),
    regenerate: (project: string, shot: string) => ipcRenderer.invoke('production:regenerate', project, shot),
    accept: (project: string, shot: string, packageDir: string, options: AcceptOptions) =>
      ipcRenderer.invoke('production:accept', project, shot, packageDir, options),
    contactSheet: (project: string, packageDir: string) => ipcRenderer.invoke('production:contactSheet', project, packageDir),
    park: (project: string, packageDir: string) => ipcRenderer.invoke('production:park', project, packageDir),
    speechPlan: (project: string, shot: string, packageDir?: string) => ipcRenderer.invoke('production:speechPlan', project, shot, packageDir),
    prepareSpeech: (project: string, packageDir: string, bounds?: { start: number; end: number }) =>
      ipcRenderer.invoke('production:prepareSpeech', project, packageDir, bounds),
    reopenQuestion: (project: string, packageDir: string) => ipcRenderer.invoke('production:reopenQuestion', project, packageDir),
    discardAttempt: (project: string, packageDir: string) => ipcRenderer.invoke('production:discardAttempt', project, packageDir),
    exportBundle: (project: string, options: ExportBundleOptions) => ipcRenderer.invoke('production:exportBundle', project, options),
    listBundles: (project: string) => ipcRenderer.invoke('production:listBundles', project),
    removeBundle: (project: string, path: string) => ipcRenderer.invoke('production:removeBundle', project, path)
  },
  dashboard: {
    view: (project: string) => ipcRenderer.invoke('dashboard:view', project)
  },
  animatic: {
    view: (project: string) => ipcRenderer.invoke('animatic:view', project),
    build: (project: string, planOnly: boolean) => ipcRenderer.invoke('animatic:build', project, planOnly),
    setStatus: (project: string, status: 'approved' | 'review') => ipcRenderer.invoke('animatic:setStatus', project, status)
  },
  checks: {
    list: () => ipcRenderer.invoke('checks:list'),
    run: (project: string, id: CheckId, options?: CheckOptions) => ipcRenderer.invoke('checks:run', project, id, options ?? {}),
    runAll: (project: string, options?: CheckOptions) => ipcRenderer.invoke('checks:runAll', project, options),
    updateViews: (project: string) => ipcRenderer.invoke('checks:updateViews', project),
    buildReview: (project: string, options: ReviewOptions) => ipcRenderer.invoke('checks:buildReview', project, options),
    listReviews: (project: string) => ipcRenderer.invoke('checks:listReviews', project),
    removeReview: (project: string, path: string) => ipcRenderer.invoke('checks:removeReview', project, path)
  },
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    get: (id: string) => ipcRenderer.invoke('jobs:get', id),
    copyText: (id: string) => ipcRenderer.invoke('jobs:copyText', id)
  },
  diagnostics: {
    reportRendererError: (report) => ipcRenderer.send('diagnostics:rendererError', report),
    crashNotice: () => ipcRenderer.invoke('diagnostics:crashNotice'),
    saveReport: () => ipcRenderer.invoke('diagnostics:saveReport')
  },
  environment: {
    check: async (onProgress) => {
      const requestId = `${Date.now()}-${++environmentRequest}`;
      const listener = (_event: Electron.IpcRendererEvent, value: { requestId: string; check: EnvironmentCheck }): void => {
        if (value.requestId === requestId) onProgress?.(value.check);
      };
      // Подписка существует только до окончания своего запроса; чужие и запоздалые события отбрасываются.
      if (onProgress) ipcRenderer.on('environment:progress', listener);
      try {
        return await ipcRenderer.invoke('environment:check', requestId);
      } finally {
        if (onProgress) ipcRenderer.removeListener('environment:progress', listener);
      }
    },
    loginProvider: (provider) => ipcRenderer.invoke('environment:loginProvider', provider),
    cancelLogin: (provider) => ipcRenderer.invoke('environment:cancelLogin', provider),
    onLoginUrl: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: { provider: string; url: string }): void => listener(value);
      ipcRenderer.on('environment:loginUrl', handler);
      return () => ipcRenderer.removeListener('environment:loginUrl', handler);
    },
    providerAuth: (provider) => ipcRenderer.invoke('environment:providerAuth', provider)
  },
  tools: {
    run: (project: string, name: string, args: string[]) => ipcRenderer.invoke('tools:run', project, name, args)
  },
  dialog: {
    pickFolder: (options?: PickOptions) => ipcRenderer.invoke('dialog:pickFolder', options),
    pickFiles: (options?: PickOptions) => ipcRenderer.invoke('dialog:pickFiles', options)
  },
  shell: {
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    readText: (path: string) => ipcRenderer.invoke('shell:readText', path),
    fileUrl: toLocalFileUrl,
    pathForFile: (file: File) => webUtils.getPathForFile(file)
  }
};

contextBridge.exposeInMainWorld('api', api);
