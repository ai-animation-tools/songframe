/** Регистрация обработчиков IPC: тонкий слой над модулями главного процесса. */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell, nativeImage } from 'electron';
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
import { Jobs } from './jobs';
import { runtimeInfo, type AppDiagnostics } from './app-diagnostics';
import { buildReport, jobText } from './diagnostics';
import { CHECKS, Checks, listReviews, readProjectSettings, writeProjectSettings } from './checks';
import { Animatic, setAnimaticStatus, viewAnimatic } from './animatic';
import { viewDashboard } from './dashboard';
import { listBundles, Production, viewProduction, readPackage, pricingArgs } from './production';
import { speechPlan } from './speech';
import { initCast, readCast, viewCast, writeCast } from './cast';
import { buildBrief, saveTreatment, validateScenes, viewScenario } from './scenario';
import { saveScenesWithMode, scenesSaveImpact } from './scenario-save';
import { runEnvironmentTask } from './environment-task';
import { resolvePaths } from './paths';
import { Projects, validateNewProject } from './projects';
import { parseLyrics, saveSources, validateSources, viewSources } from './sources';
import { LocalState } from './state';
import { saveTiming, viewTiming } from './timing';
import { runTool } from './tools';
import { PythonLauncher } from './python-launcher';
import { whisperSetup } from './whisper-setup';
import { startWhisperDownload } from './whisper-download';
import { initializeLocalStorage } from './local-storage';
import { normalizeAgentSettings, SettingsStore } from './settings';
import { mediaPaths } from './media-runtime';
import { checkAgent } from './agents';
import { createAgentAdapter } from './agent-adapters';
import type { AgentJob, AgentSettings } from '@shared/agents';
import type { AgentStartInput } from '@shared/agents';
import type { AgentManager } from './agent-manager';
import { openDesktopPath } from './desktop';
import type { ScenarioWorkflowStart } from '@shared/scenario-workflow';
import { ScenarioWorkflow } from './scenario-workflow';
import { publishScenario } from './scenario-apply';
import { ProductionWorkflow } from './production-workflow';
import { KeyframeImages, isImageFile } from './keyframe-images';
import { proposalAttention, type ProductionWorkflowStart, type ProductionFrameCandidate } from '@shared/production-workflow';
import {
  isMediaProvider,
  MEDIA_PROVIDERS,
  mediaProvidersFor,
  mediaProviderTitles,
  normalizeMediaProvider,
  type MediaCapabilities,
  type MediaKind,
  type ProviderAuth,
  mediaProviderInfo
} from '@shared/media-providers';
import { PaidMediaProvider } from './media-providers';
import { agentAdapters, paidAdapter, paidAdapters, type AgentImageExecutor, type PaidProviderAdapter } from './providers';
import { frameImageRequest } from './frame-image-request';
import { readAgentModels } from './agent-models';
import type { TaskNotifications } from './task-notifications';
import type { MontageDraft } from '@shared/montage';
import { Montage } from './montage';
import { copyMontageVideo, montageVideoPath } from './montage-video';
import { recoverMontageApplications } from './montage-recovery';
import { readScenarioRegistry } from './scenario-status';
import { CoverGeneration } from './cover-generation';
import { preparePaidCover } from './cover-paid';
import { prepareProjectCover } from './cover-provider';
import type { CoverCrop, CoverGenerationApproval } from '@shared/cover-generation';
import { assertAiSelection, createAiAccess } from './ai-access';
import { requireProductionPackageAccess } from './production-access';

export interface Services {
  projects: Projects;
  toolsRoot: string | null;
  jobs: Jobs;
  production: Production;
  checks: Checks;
  animatic: Animatic;
  montage: Montage;
  launcher: PythonLauncher;
  settings: SettingsStore;
  /** Только оконный процесс: служебные проверки без окна не восстанавливают задания работающего приложения. */
  agents?: AgentManager;
  /** Доставка итогов живёт в main и не зависит от подписки открытой страницы. */
  notifications?: TaskNotifications;
  cover?: CoverGeneration;
  /** Только оконный процесс: журнал сбоев и сеанс пользователя. */
  diagnostics?: AppDiagnostics;
}

/** Исходные данные путей приложения; localDir из них нужен и журналу сбоев до создания служб. */
export function pathOptions() {
  return {
    appPath: app.getAppPath(),
    execPath: process.execPath,
    cwd: process.cwd(),
    userData: app.getPath('userData'),
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    localDirOverride: process.env.SONGFRAME_LOCAL_DIR
  };
}

/**
 * restoreJobs загружает журнал заданий прошлых сеансов (только оконный запуск);
 * previousJobs продолжает уже открытый журнал при смене ресурсов.
 */
export function createServices(input: { restoreJobs?: boolean; previousJobs?: Jobs } = {}): Services {
  const options = pathOptions();
  const defaults = resolvePaths(options);
  initializeLocalStorage(defaults.localDir);
  const settings = new SettingsStore(defaults.localDir);
  const paths = resolvePaths({ ...options, override: settings.read().toolsRootOverride });
  const launcher = new PythonLauncher({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, toolsRoot: paths.toolsRoot, localDir: paths.localDir });
  const jobs = new Jobs(paths.toolsRoot, paths.localDir, launcher, { restore: !!input.restoreJobs, previous: input.previousJobs });
  const projects = new Projects(new LocalState(paths.localDir), paths.toolsRoot, process.platform, {
    packaged: app.isPackaged,
    problems: paths.problems
  });
  return {
    projects,
    toolsRoot: paths.toolsRoot,
    launcher,
    settings,
    jobs,
    production: new Production(paths.toolsRoot, jobs),
    checks: new Checks(jobs),
    animatic: new Animatic(jobs),
    montage: new Montage(jobs)
  };
}

export function registerIpc(getServices: () => Services, setServices: (services: Services) => void): void {
  const agents = getServices().agents;
  if (!agents) throw new Error('Менеджер агента не создан.');
  const notifications = getServices().notifications;
  const diagnostics = getServices().diagnostics;
  const watchJobs = (jobs: Jobs): void => {
    jobs.onFinished((job, project) => notifications?.jobFinished(job, project));
  };
  watchJobs(getServices().jobs);
  // Один сценарный процесс переживает смену ресурсов; launcher выбирается перед каждой операцией.
  const workflow = new ScenarioWorkflow({
    agents,
    localDir: getServices().settings.localDir,
    toolsRoot: () => getServices().toolsRoot,
    scaffold: async (project) => {
      const result = await getServices().launcher.run(project, 'scene_scaffold', ['--dry-run', '--json']);
      if (result.code !== 0) throw new Error(`Не удалось подготовить каркас: ${(result.stderr || result.stdout).trim().slice(-2000)}`);
      return JSON.parse(result.stdout) as ScenesFile;
    },
    publish: (input) => publishScenario(input, { localDir: getServices().settings.localDir, launcher: getServices().launcher })
  });
  const images = new KeyframeImages({
    localDir: getServices().settings.localDir,
    agents,
    validateImage: (path) => !nativeImage.createFromPath(path).isEmpty()
  });
  const mediaOptions = {
    launcher: () => getServices().launcher,
    validateImage: (path: string) => !nativeImage.createFromPath(path).isEmpty()
  };
  // Опоры провайдера-агента рисует его программа по реестру; исполнителей даёт таблица адаптеров.
  const agentImages: Record<string, AgentImageExecutor> = Object.fromEntries(
    agentAdapters()
      .filter((adapter) => MEDIA_PROVIDERS[adapter.id]?.kinds.includes('image'))
      .map((adapter) => [adapter.id, adapter.images({ images, agentSettings: (model) => getServices().settings.getImageAgent(adapter.id, model) })])
  );
  const projectAgentImages = (project: string): AgentImageExecutor => {
    const executor = agentImages[normalizeMediaProvider(readProjectSettings(project).generation?.image?.provider) ?? ''];
    if (!executor) throw new Error('Выбранный провайдер изображений не рисует опоры программой-агентом.');
    return executor;
  };
  // Задание опор собирает исполнитель провайдера, чья программа-агент его выполнила, даже если настройки проекта уже сменились.
  const jobAgentImages = (job: AgentJob): AgentImageExecutor => {
    const id = Object.keys(agentImages).find((provider) => MEDIA_PROVIDERS[provider]?.executor === job.provider);
    if (!id) throw new Error('Нет исполнителя опор для программы-агента этого задания.');
    return agentImages[id];
  };
  // Общий платный адаптер для каждого провайдера таблицы и каждого вида медиа из реестра.
  const paidMedia: Record<string, Partial<Record<MediaKind, PaidMediaProvider>>> = Object.fromEntries(
    paidAdapters().map((adapter) => [
      adapter.id,
      Object.fromEntries(MEDIA_PROVIDERS[adapter.id].kinds.map((kind) => [kind, new PaidMediaProvider(adapter, kind, mediaOptions)]))
    ])
  );
  const requirePaid = (provider: unknown): PaidProviderAdapter => {
    const adapter = paidAdapter(provider);
    if (!adapter) throw new Error('Для провайдера не подключён исполнитель платного запроса.');
    return adapter;
  };
  const ai = createAiAccess({
    settings: () => getServices().settings,
    checkProviderAuth: (provider) => requirePaid(provider).checkAuth(getServices().launcher.options)
  });
  ipcMain.handle('ai:access', (_event, project: string | null) => ai.getAccess(project));
  const cover = new CoverGeneration({
    settings: getServices().settings,
    readImage: (path) => {
      const image = nativeImage.createFromPath(path);
      return image.isEmpty() ? null : image.getSize();
    },
    cropImage: (input, output, crop) => {
      const image = nativeImage.createFromPath(input).crop({ x: crop.x, y: crop.y, width: crop.size, height: crop.size });
      if (image.isEmpty()) throw new Error('Не удалось вырезать выбранную область обложки.');
      writeFileSync(output, image.toPNG());
    },
    prepareCandidate: (input) =>
      prepareProjectCover(input, {
        settings: getServices().settings,
        paid: (candidate, id) => {
          // Даже discovery и локальная подготовка завершаются до удаления временной сессии при закрытии.
          const provider = new PaidMediaProvider(requirePaid(id), 'image', {
            ...mediaOptions,
            launcher: () => ({
              run: (project, name, args, options) => getServices().launcher.run(project, name, args, { ...options, signal: candidate.signal })
            })
          });
          return preparePaidCover(candidate, { provider, launcher: () => getServices().launcher, pricingArgs });
        }
      })
  });
  getServices().cover = cover;
  // Перезагрузка или закрытие renderer не оставляет сессию с непринятыми картинками до завершения приложения.
  const coverOwners = new Map<number, Set<string>>();
  const coverProjects = new Map<string, string>();
  ipcMain.handle('cover:create', async (event, project: string, prompt: string) => {
    await ai.requireAccess(project, 'image');
    if (event.sender.isDestroyed()) throw new Error('Окно генерации обложки закрыто.');
    let owned = coverOwners.get(event.sender.id);
    if (!owned) {
      owned = new Set<string>();
      coverOwners.set(event.sender.id, owned);
      const closeOwned = (): void => {
        const ids = [...owned!];
        owned!.clear();
        for (const id of ids) {
          coverProjects.delete(id);
          void cover.close(id).catch((error: unknown) => console.error('Не удалось очистить временную обложку:', error));
        }
      };
      event.sender.once('destroyed', closeOwned);
      event.sender.on('render-process-gone', closeOwned);
      event.sender.on('did-start-navigation', (_navigation, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) closeOwned();
      });
    }
    const session = cover.create(project, prompt);
    owned.add(session.id);
    coverProjects.set(session.id, project);
    return session;
  });
  ipcMain.handle('cover:prepare', async (_event, id: string) => {
    await ai.requireAccess(coverProjects.get(id) ?? null, 'image');
    return cover.prepare(id);
  });
  ipcMain.handle('cover:generate', async (_event, id: string, requestSha: string, approval: CoverGenerationApproval) => {
    await ai.requireAccess(coverProjects.get(id) ?? null, 'image');
    return cover.generate(id, requestSha, approval);
  });
  ipcMain.handle('cover:view', (_event, id: string) => cover.view(id));
  ipcMain.handle('cover:accept', (_event, id: string, crop: CoverCrop) => cover.accept(id, crop));
  ipcMain.handle('cover:close', async (event, id: string) => {
    coverOwners.get(event.sender.id)?.delete(id);
    coverProjects.delete(id);
    await cover.close(id);
  });
  const connectMedia = (): void => getServices().production.setMediaProviders(paidMedia);
  connectMedia();
  const mediaCapabilities = (provider: string, kind: MediaKind): ((project: string) => Promise<MediaCapabilities>) | undefined => {
    if (!isMediaProvider(provider, kind)) return undefined;
    const executor = paidMedia[provider]?.[kind] ?? (kind === 'image' ? agentImages[provider] : undefined);
    return executor && ((project) => executor.capabilities(project));
  };
  ipcMain.handle('media:capabilities', (_event, project: string, kind: MediaKind, provider: string) => {
    if (!['image', 'video'].includes(kind)) throw new Error('Неизвестный вид медиа.');
    const capabilities = mediaCapabilities(provider, kind);
    if (capabilities) return capabilities(project);
    return {
      provider,
      kind,
      available: false,
      checkedAt: new Date().toISOString(),
      models: [],
      problems: ['Провайдер не поддерживается. Сохранённое значение оставлено без изменений.'],
      generationVerified: false
    };
  });
  const productionFlow = new ProductionWorkflow({
    agents,
    localDir: getServices().settings.localDir,
    toolsRoot: () => getServices().toolsRoot,
    launcher: () => getServices().launcher,
    isScenarioApproved: (project) => {
      const view = workflow.view(project);
      return view.treatmentApproved && !view.scenesNeedReview;
    },
    isPackageBusy: (project, packageDir) => getServices().production.isBusy(project, packageDir),
    generateImages: (input) => {
      assertAiSelection(getServices().settings, input.project, 'image');
      const executor = projectAgentImages(input.project);
      const prepared = executor.prepare(input);
      const execution = executor.submit(prepared, { requestSha: prepared.requestSha });
      if (execution.provider !== executor.provider) throw new Error('Исполнитель вернул неверный тип задания опор.');
      const job = agents.get(execution.agentJobId);
      if (!job) throw new Error('Задание изображений не создано.');
      return job;
    },
    collectImages: (job) =>
      jobAgentImages(job)
        .collectJob(job)
        .map((artifact) => ({ id: artifact.frameId!, path: artifact.path })),
    prepareImageRequest: async (input) => {
      await ai.requireAccess(input.project, 'image');
      const settings = readProjectSettings(input.project).generation?.image;
      const provider = paidMedia[normalizeMediaProvider(settings?.provider) ?? '']?.image;
      if (!provider) {
        const paid = mediaProvidersFor('image').filter((id) => MEDIA_PROVIDERS[id].paid);
        throw new Error(`Выберите ${paid.map((id) => MEDIA_PROVIDERS[id].title).join(' или ') || 'платного провайдера'} для изображений в настройках проекта.`);
      }
      const capabilities = await provider.capabilities(input.project);
      const request = frameImageRequest(provider.adapter, input, settings, capabilities, (path) => !nativeImage.createFromPath(path).isEmpty());
      await provider.prepare(request, capabilities);
      const requestName = request.workDir.slice(input.packageDir.length + 1);
      const result = await getServices().launcher.run(input.project, 'shot_workflow', [
        'set-image-request',
        '--dir',
        input.packageDir,
        '--frame',
        request.frameId!,
        '--request-dir',
        requestName
      ]);
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || 'Не удалось записать согласование изображения.');
    },
    prepareVideoRequest: async ({ project, shot, requestDir, prompt, draft, durationConstraint }) => {
      await ai.requireAccess(project, 'video');
      const settings = readProjectSettings(project).generation?.video;
      const provider = isMediaProvider(settings?.provider, 'video') ? paidMedia[settings.provider]?.video : undefined;
      if (!settings || !provider) throw new Error(`Выберите поддерживаемого провайдера видео: ${mediaProviderTitles('video')}.`);
      await provider.prepare(
        {
          project,
          shot,
          workDir: requestDir,
          prompt,
          kind: 'video',
          ...draft,
          preferredModel: settings.model?.trim() || null,
          durationConstraint,
          requiredParameters: { resolution: settings.resolution, aspect_ratio: settings.aspect_ratio },
          projectOptions: settings.options
        },
        await provider.capabilities(project)
      );
    }
  });
  ipcMain.handle('productionWorkflow:view', (_event, project: string, shot: string, packageDir?: string) => productionFlow.view(project, shot, packageDir));
  ipcMain.handle('productionWorkflow:start', async (_event, input: ProductionWorkflowStart) => {
    await ai.requireAccess(input.project, 'agent');
    return productionFlow.start(input);
  });
  ipcMain.handle('productionWorkflow:apply', (_event, project: string, shot: string, packageDir: string | undefined, id: string) =>
    productionFlow.apply(project, shot, packageDir, id)
  );
  ipcMain.handle('productionWorkflow:discard', (_event, project: string, shot: string, packageDir: string | undefined, id: string) =>
    productionFlow.discard(project, shot, packageDir, id)
  );
  ipcMain.handle('productionWorkflow:generateFrames', async (_event, project: string, shot: string, packageDir: string) => {
    await ai.requireAccess(project, 'image');
    return productionFlow.generateFrames(project, shot, packageDir);
  });
  ipcMain.handle('productionWorkflow:importFrames', (_event, project: string, shot: string, packageDir: string, candidates: ProductionFrameCandidate[]) => {
    if (
      !Array.isArray(candidates) ||
      candidates.some((item) => !item || typeof item.path !== 'string' || !isImageFile(item.path) || nativeImage.createFromPath(item.path).isEmpty())
    )
      throw new Error('Выберите настоящие изображения PNG, JPG или WebP.');
    return productionFlow.importFrames(project, shot, packageDir, candidates);
  });
  const productionIdle = (project: string, packageDir: string): void => {
    const pkg = readPackage(project, packageDir);
    if (pkg && productionFlow.view(project, pkg.shot, packageDir).busy) throw new Error('Для этого пакета уже выполняется задание. Дождитесь завершения.');
  };
  const requirePackageAccess = (project: string, packageDir: string): Promise<void> => requireProductionPackageAccess(project, packageDir, ai.requireAccess);
  const reviewProblem = (project: string): string | null => {
    try {
      return workflow.view(project).scenesNeedReview
        ? 'Кастинг, трактовка или исходники изменились: проверьте и утвердите актуальный сценарий на странице «Сценарий».'
        : null;
    } catch (error) {
      return `Не удалось проверить актуальность сценария: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  ipcMain.handle('scenarioWorkflow:view', (_event, project: string) => workflow.view(project));
  ipcMain.handle('scenarioWorkflow:start', async (_event, input: ScenarioWorkflowStart) => {
    await ai.requireAccess(input.project, 'agent');
    return workflow.start(input);
  });
  ipcMain.handle('scenarioWorkflow:apply', (_event, project: string, id: string) => workflow.apply(project, id));
  ipcMain.handle('scenarioWorkflow:approveCurrent', (_event, project: string) => workflow.approveCurrent(project));
  ipcMain.handle('scenarioWorkflow:approveScenes', (_event, project: string) => workflow.approveScenes(project));
  ipcMain.handle('scenarioWorkflow:discard', (_event, project: string, id: string) => workflow.discard(project, id));
  const subscribers = new Set<Electron.WebContents>();
  const watched = new WeakSet<Electron.WebContents>();
  ipcMain.on('agents:subscribe', (event) => {
    const sender = event.sender;
    subscribers.add(sender);
    if (!watched.has(sender)) {
      watched.add(sender);
      sender.once('destroyed', () => subscribers.delete(sender));
    }
  });
  ipcMain.on('agents:unsubscribe', (event) => subscribers.delete(event.sender));
  agents.onEvent((event) => {
    notifications?.agentEvent(event);
    for (const sender of subscribers) if (!sender.isDestroyed()) sender.send('agents:event', event);
  });
  ipcMain.handle('agents:start', async (_event, input: AgentStartInput) => {
    await ai.requireAccess(input.project, 'agent');
    return agents.start(input);
  });
  ipcMain.handle('agents:cancel', (_event, id: string) => agents.cancel(id));
  ipcMain.handle('agents:get', (_event, id: string) => agents.get(id));
  ipcMain.handle('agents:list', (_event, project?: string) => agents.list(project));
  ipcMain.handle('agents:getSettings', () => getServices().settings.getAgent());
  ipcMain.handle('agents:getProviderSettings', (_event, provider: AgentSettings['provider']) => getServices().settings.getProviderAgent(provider));
  ipcMain.handle('agents:saveProviderSettings', (_event, settings: AgentSettings) => getServices().settings.saveProviderAgent(settings));
  ipcMain.handle('agents:saveSettings', (_event, settings: AgentSettings | null) => getServices().settings.saveAgent(settings));
  ipcMain.handle('agents:check', (_event, settings: AgentSettings) => checkAgent(settings));
  ipcMain.handle('agents:account', (_event, settings: AgentSettings) => {
    const config = normalizeAgentSettings(settings);
    if (!config) throw new Error('Сначала выберите агента.');
    return createAgentAdapter(config.provider).account(config);
  });
  ipcMain.handle('agents:models', (_event, settings: AgentSettings) => {
    const config = normalizeAgentSettings(settings);
    if (!config) throw new Error('Сначала выберите агента.');
    return readAgentModels(createAgentAdapter(config.provider), config);
  });
  ipcMain.handle('app:state', () => getServices().projects.appState());
  ipcMain.handle('app:setToolsRoot', (_event, path: string | null) => {
    if (app.isPackaged && path) throw new Error('Готовое приложение использует собственные ресурсы. Выбор checkout доступен только при разработке.');
    if (path && !existsSync(join(path, 'tools', 'common.py'))) throw new Error(`В папке нет tools/common.py: ${path}`);
    const settings = getServices().settings;
    settings.write({ ...settings.read(), toolsRootOverride: path });
    // Смена ресурсов не создаёт второй менеджер и не объявляет живые задания прерванными.
    const next = { ...createServices({ previousJobs: getServices().jobs }), agents, notifications, cover, diagnostics };
    watchJobs(next.jobs);
    setServices(next);
    return getServices().projects.appState();
  });

  ipcMain.handle('projects:open', (_event, path: string) => {
    // Живую публикацию не откатываем; восстановление относится только к прошлому прерванному запуску.
    if (
      !getServices()
        .jobs.list()
        .some((job) => job.status === 'running' && job.steps.some((step) => step.tool === 'apply_montage'))
    )
      recoverMontageApplications(path);
    return getServices().projects.open(path);
  });
  ipcMain.handle('projects:create', (_event, input: CreateProjectInput) => getServices().projects.create(input));
  ipcMain.handle('projects:validateNew', (_event, input: CreateProjectInput) => validateNewProject(input));
  ipcMain.handle('projects:status', (_event, path: string) => {
    const status = getServices().projects.status(path);
    const problem = reviewProblem(path);
    if (problem) {
      status.problems.push(problem);
      status.checks.animaticFresh = false;
      status.checks.animaticApproved = false;
      if (status.state === 'complete') status.state = 'in_production';
    }
    return status;
  });
  ipcMain.handle('projects:rename', (_event, path: string, name: string) => getServices().projects.rename(path, name));
  ipcMain.handle('projects:close', () => getServices().projects.close());
  ipcMain.handle('projects:forget', (_event, path: string) => getServices().projects.forget(path));
  ipcMain.handle('projects:settings', (_event, project: string) => readProjectSettings(project));
  ipcMain.handle('projects:saveSettings', (_event, project: string, settings: ProjectSettings) => writeProjectSettings(project, settings));

  ipcMain.handle('sources:view', (_event, project: string) => viewSources(project));
  ipcMain.handle('sources:validate', (_event, project: string, input: SourcesInput) => validateSources(project, input));
  ipcMain.handle('sources:save', (_event, project: string, input: SourcesInput) => {
    const media = mediaPaths(getServices().launcher.options);
    return saveSources(project, input, media?.ffprobe);
  });

  ipcMain.handle('timing:modelSetup', () => whisperSetup(getServices().launcher));
  ipcMain.handle('timing:downloadModel', (_event, model: string) => startWhisperDownload(getServices().jobs, model));
  ipcMain.handle('timing:view', (_event, project: string) => viewTiming(project));
  ipcMain.handle('timing:save', (_event, project: string, timing: TimingFile) => saveTiming(project, timing));
  ipcMain.handle('timing:generate', async (_event, project: string, options: TimingGenerateOptions) => {
    try {
      // Предусловие проверяется и в IPC: файл мог исчезнуть после открытия диалога.
      const textPath = join(project, 'source/text.md');
      if (!existsSync(textPath)) throw new Error('Сначала добавьте текст песни на странице «Исходники».');
      const formatProblems = parseLyrics(readFileSync(textPath, 'utf8')).problems;
      if (formatProblems.length) throw new Error(`Исправьте текст песни на странице «Исходники»: ${formatProblems.join(' ')}`);
      const args = ['--json'];
      // Пустое поле использует рекомендацию, а не отсутствующие веса внутри AppImage.
      if (!options.recognition) {
        let modelPath = options.model?.trim();
        if (!modelPath) {
          const setup = await whisperSetup(getServices().launcher);
          modelPath = setup.directories[setup.recommended];
        }
        args.push('--model', modelPath);
      }
      args.push('--device', options.device === 'cpu' ? 'cpu' : 'auto');
      if (options.recognition) args.push('--recognition', options.recognition);
      if (options.reset) args.push('--reset');
      // Разметка не проходит через Jobs: сообщаем только итог единственного вызова launcher.
      const result = await runTool(getServices().toolsRoot, project, 'align_lyrics', args, 30 * 60 * 1000, getServices().launcher);
      notifications?.timingFinished(project, result.code === 0);
      return result;
    } catch (error) {
      notifications?.timingFinished(project, false);
      throw error;
    }
  });

  ipcMain.handle('cast:view', (_event, project: string) => viewCast(project, getServices().toolsRoot));
  ipcMain.handle('cast:init', (_event, project: string) => initCast(project, getServices().toolsRoot));
  ipcMain.handle('cast:save', (_event, project: string, cast: CastFile) => writeCast(project, cast, getServices().toolsRoot));

  ipcMain.handle('scenario:view', (_event, project: string) => viewScenario(project, getServices().toolsRoot));
  ipcMain.handle('scenario:status', (_event, project: string) => readScenarioRegistry(project).status);
  ipcMain.handle('scenario:saveTreatment', (_event, project: string, treatment: TreatmentFile) => saveTreatment(project, treatment));
  ipcMain.handle('scenario:saveScenes', (_event, project: string, scenes: ScenesFile, mode: ScenesSaveMode) => saveScenesWithMode(project, scenes, mode));
  ipcMain.handle('scenario:saveImpact', (_event, project: string, scenes: ScenesFile) => scenesSaveImpact(project, scenes));
  ipcMain.handle('scenario:validateScenes', (_event, project: string, scenes: ScenesFile) => validateScenes(scenes, readCast(project) || null));
  ipcMain.handle('scenario:brief', (_event, project: string, scenes: ScenesFile, shot: string, phase: 'before' | 'after') =>
    buildBrief(scenes, readCast(project) || null, shot, phase, getServices().toolsRoot)
  );

  ipcMain.handle('production:view', (_event, project: string) => {
    const view = viewProduction(project, getServices().launcher);
    const problem = reviewProblem(project);
    if (problem) view.problems.push(problem);
    // Непринятые предложения агента видны в списке планов и попадают в «Ждут вашего действия».
    const proposals = productionFlow.pendingProposals(project);
    view.shots = view.shots.map((shot) => {
      const proposal = proposals[shot.id] ?? null;
      return { ...shot, proposal, attention: shot.attention ?? (proposal ? proposalAttention(proposal) : null) };
    });
    return view;
  });
  ipcMain.handle(
    'production:decide',
    (_event, project: string, packageDir: string, verdict: string, note: string, decisionToken?: string, noteScope?: KeyframeNoteScope) => {
      productionIdle(project, packageDir);
      return getServices().production.decide(project, packageDir, verdict, note, decisionToken, noteScope);
    }
  );
  ipcMain.handle('production:reopenFrame', (_event, project: string, packageDir: string, frame: string, note: string, noteScope: KeyframeNoteScope) => {
    productionIdle(project, packageDir);
    return getServices().production.reopenFrame(project, packageDir, frame, note, noteScope);
  });
  ipcMain.handle('production:keepPackageForScene', (_event, project: string, packageDir: string) => {
    productionIdle(project, packageDir);
    return getServices().production.keepPackageForScene(project, packageDir);
  });
  ipcMain.handle('production:setKeyframeNote', (_event, project: string, packageDir: string, id: number, active: boolean) => {
    productionIdle(project, packageDir);
    return getServices().production.setKeyframeNote(project, packageDir, id, active);
  });
  ipcMain.handle('production:quote', async (_event, project: string, packageDir: string, sha: string, decisionToken?: string) => {
    await requirePackageAccess(project, packageDir);
    connectMedia();
    productionIdle(project, packageDir);
    return getServices().production.quote(project, packageDir, sha, decisionToken);
  });
  ipcMain.handle(
    'production:submit',
    async (_event, project: string, packageDir: string, sha: string, decisionToken?: string, quoteToken?: string, unknownCostConsentToken?: string) => {
      await requirePackageAccess(project, packageDir);
      connectMedia();
      productionIdle(project, packageDir);
      return getServices().production.submit(project, packageDir, sha, decisionToken, quoteToken, unknownCostConsentToken);
    }
  );
  ipcMain.handle('production:resume', async (_event, project: string, packageDir: string) => {
    await requirePackageAccess(project, packageDir);
    productionIdle(project, packageDir);
    return getServices().production.resume(project, packageDir);
  });
  ipcMain.handle('production:attachResult', async (_event, project: string, packageDir: string, files: string[]) => {
    await requirePackageAccess(project, packageDir);
    productionIdle(project, packageDir);
    return getServices().production.attachResult(project, packageDir, files);
  });
  ipcMain.handle('production:markNotCreated', async (_event, project: string, packageDir: string) => {
    await requirePackageAccess(project, packageDir);
    productionIdle(project, packageDir);
    return getServices().production.markNotCreated(project, packageDir);
  });
  ipcMain.handle('production:selectImage', (_event, project: string, packageDir: string, index: number, expectedResultToken: string) => {
    productionIdle(project, packageDir);
    connectMedia();
    return getServices().production.selectImage(project, packageDir, index, expectedResultToken);
  });
  ipcMain.handle('production:regenerate', (_event, project: string, shot: string) => {
    // Повтор только копирует сохранённый запрос; выбор провайдера проверяется без входа в сервис и запуска ИИ.
    // Повтор не должен создавать пакет одновременно с применением предложения того же кадра.
    if (productionFlow.view(project, shot).busy) throw new Error('Для этого кадра уже выполняется задание. Дождитесь завершения.');
    return getServices().production.regenerate(project, shot);
  });
  ipcMain.handle('production:accept', (_event, project: string, shot: string, packageDir: string, options: AcceptOptions) => {
    productionIdle(project, packageDir);
    return getServices().production.accept(project, shot, packageDir, options);
  });
  ipcMain.handle('production:contactSheet', (_event, project: string, packageDir: string) => {
    productionIdle(project, packageDir);
    return getServices().production.contactSheet(project, packageDir);
  });
  ipcMain.handle('production:discardAttempt', (_event, project: string, packageDir: string) => getServices().production.discardAttempt(project, packageDir));
  ipcMain.handle('production:reopenQuestion', (_event, project: string, packageDir: string) => getServices().production.reopenQuestion(project, packageDir));
  ipcMain.handle('production:park', (_event, project: string, packageDir: string) => {
    productionIdle(project, packageDir);
    return getServices().production.park(project, packageDir);
  });
  // Допустимую длину звукового входа задаёт поле lipSync провайдера видео проекта в реестре.
  const speechLimits = (project: string, packageDir?: string): { requestSeconds: number | null; lipSync: { min: number; max: number } | null } => ({
    requestSeconds: (packageDir ? readPackage(project, packageDir)?.timing?.request_seconds : null) ?? null,
    lipSync: mediaProviderInfo(readProjectSettings(project).generation?.video?.provider, 'video')?.lipSync ?? null
  });
  ipcMain.handle('production:speechPlan', (_event, project: string, shot: string, packageDir?: string) =>
    speechPlan(project, shot, speechLimits(project, packageDir))
  );
  ipcMain.handle('production:prepareSpeech', async (_event, project: string, packageDir: string, bounds?: { start: number; end: number }) => {
    productionIdle(project, packageDir);
    const { lipSync } = speechLimits(project, packageDir);
    if (!lipSync) throw new Error('Провайдер видео проекта не синхронизирует губы с заданным звуком.');
    if (bounds && (bounds.end - bounds.start < lipSync.min - 1e-6 || bounds.end - bounds.start > lipSync.max + 1e-6))
      throw new Error(`Провайдер видео принимает звук длиной от ${lipSync.min} до ${lipSync.max} с: поправьте границы среза.`);
    return getServices().production.prepareSpeech(project, packageDir, bounds);
  });
  ipcMain.handle('production:exportBundle', (_event, project: string, options: ExportBundleOptions) => getServices().production.exportBundle(project, options));
  ipcMain.handle('production:listBundles', (_event, project: string) => listBundles(project));
  ipcMain.handle('production:removeBundle', (_event, project: string, path: string) => getServices().production.removeBundle(project, path));
  ipcMain.handle('dashboard:view', (_event, project: string) => {
    const view = viewDashboard(project, getServices().toolsRoot);
    const problem = reviewProblem(project);
    if (problem) view.problems.push(problem);
    return view;
  });
  ipcMain.handle('animatic:view', (_event, project: string) => {
    const view = viewAnimatic(project);
    const problem = reviewProblem(project);
    if (problem) {
      view.problems.push(problem);
      if (view.built) view.built.fresh = false;
      view.cardsFresh = false;
      view.approval.current = false;
      view.blockedReason = problem;
    }
    return view;
  });
  ipcMain.handle('animatic:build', (_event, project: string, planOnly: boolean) => {
    const problem = reviewProblem(project);
    if (problem) throw new Error(problem);
    return getServices().animatic.build(project, planOnly);
  });
  ipcMain.handle('animatic:setStatus', (_event, project: string, status: 'approved' | 'review') => {
    const problem = reviewProblem(project);
    if (status === 'approved' && problem) throw new Error(problem);
    return setAnimaticStatus(project, status);
  });
  ipcMain.handle('checks:list', () => CHECKS);
  ipcMain.handle('checks:run', (_event, project: string, id: CheckId, options: CheckOptions) => getServices().checks.run(project, id, options));
  ipcMain.handle('checks:runAll', (_event, project: string, options?: CheckOptions) => getServices().checks.runAll(project, options));
  ipcMain.handle('checks:updateViews', (_event, project: string) => getServices().checks.updateViews(project));
  ipcMain.handle('checks:buildReview', (_event, project: string, options: ReviewOptions) => getServices().checks.buildReview(project, options));
  ipcMain.handle('checks:listReviews', (_event, project: string) => listReviews(project));
  ipcMain.handle('checks:removeReview', (_event, project: string, path: string) => getServices().checks.removeReview(project, path));
  ipcMain.handle('montage:view', (_event, project: string) => getServices().montage.view(project));
  ipcMain.handle('montage:load', (_event, project: string, id: string) => getServices().montage.load(project, id));
  ipcMain.handle('montage:save', (_event, project: string, draft: MontageDraft, id?: string) => getServices().montage.save(project, draft, id));
  ipcMain.handle('montage:export', (_event, project: string, draft: MontageDraft) => getServices().montage.export(project, draft));
  ipcMain.handle('montage:apply', (_event, project: string, draft: MontageDraft) => {
    const problem = reviewProblem(project);
    if (problem) throw new Error(problem);
    return getServices().montage.apply(project, draft);
  });
  ipcMain.handle('montage:saveVideo', async (event, project: string, video: string) => {
    const source = montageVideoPath(project, video);
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(window!, {
      title: 'Сохранить видеопробу',
      defaultPath: 'Монтажная проба.mp4',
      filters: [{ name: 'Видео MP4', extensions: ['mp4'] }]
    });
    if (result.canceled || !result.filePath) return null;
    return copyMontageVideo(project, source, result.filePath);
  });
  ipcMain.handle('jobs:list', () => getServices().jobs.list());
  ipcMain.handle('jobs:get', (_event, id: string) => getServices().jobs.get(id));
  ipcMain.handle('jobs:copyText', (_event, id: string) => {
    const job = getServices().jobs.get(id);
    if (!job) throw new Error('Задание не найдено в журнале.');
    return jobText(job, getServices().jobs.readLog(id));
  });

  ipcMain.on('diagnostics:rendererError', (_event, report) => diagnostics?.rendererError(report));
  ipcMain.handle('diagnostics:crashNotice', () => diagnostics?.takeCrashNotice() ?? null);
  ipcMain.handle('diagnostics:saveReport', async (event) => {
    const { jobs, settings } = getServices();
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(window!, {
      title: 'Сохранить отчёт для разработчика',
      defaultPath: join(app.getPath('downloads'), `songframe-report-${stamp}.txt`),
      filters: [{ name: 'Текст', extensions: ['txt'] }]
    });
    if (result.canceled || !result.filePath) return null;
    const report = buildReport({
      localDir: settings.localDir,
      info: runtimeInfo(),
      previous: diagnostics?.previous ?? { crashed: false, startedAt: null, version: null },
      jobs: jobs.list(),
      readLog: (id) => jobs.readLog(id, 256 * 1024),
      agents: agents.list(),
      now
    });
    writeFileSync(result.filePath, report);
    return result.filePath;
  });

  const environmentChecks = new WeakMap<
    PythonLauncher,
    {
      promise: Promise<EnvironmentCheck[]>;
      latest: Map<string, EnvironmentCheck>;
      listeners: Set<(check: EnvironmentCheck) => void>;
    }
  >();
  ipcMain.handle('environment:check', (event, requestId: string) => {
    const { toolsRoot, launcher } = getServices();
    let pending = environmentChecks.get(launcher);
    if (!pending) {
      const latest = new Map<string, EnvironmentCheck>();
      const listeners = new Set<(check: EnvironmentCheck) => void>();
      // Создание процессов и импорты остаются в worker; окно получает готовые строки, не ожидая остальных.
      const promise = runEnvironmentTask(toolsRoot, launcher.options, (check) => {
        latest.set(check.id, check);
        for (const listener of listeners) listener(check);
      }).finally(() => environmentChecks.delete(launcher));
      pending = { promise, latest, listeners };
      environmentChecks.set(launcher, pending);
    }
    const send = (check: EnvironmentCheck): void => {
      if (!event.sender.isDestroyed()) event.sender.send('environment:progress', { requestId, check });
    };
    pending.listeners.add(send);
    for (const check of pending.latest.values()) send(check);
    const current = pending;
    return current.promise.finally(() => current.listeners.delete(send));
  });
  const pendingProviderAuth = new Map<string, Promise<ProviderAuth>>();
  ipcMain.handle('environment:providerAuth', (_event, provider: string) => {
    const adapter = requirePaid(provider);
    // Повторное открытие страницы использует уже выполняющуюся проверку входа.
    // Готовый результат не сохраняем: следующая проверка заново обращается к программе провайдера.
    let pending = pendingProviderAuth.get(adapter.id);
    if (!pending) {
      pending = adapter.checkAuth(getServices().launcher.options).finally(() => {
        pendingProviderAuth.delete(adapter.id);
      });
      pendingProviderAuth.set(adapter.id, pending);
    }
    return pending;
  });
  // Ожидание входа можно отменить; адрес авторизации приложение открывает само и сообщает странице.
  const loginAborts = new Map<string, AbortController>();
  ipcMain.handle('environment:loginProvider', async (event, provider: string) => {
    const adapter = requirePaid(provider);
    loginAborts.get(adapter.id)?.abort();
    const controller = new AbortController();
    loginAborts.set(adapter.id, controller);
    try {
      return await adapter.login(getServices().launcher.options, {
        signal: controller.signal,
        authorizeUrl: (url) => {
          void shell.openExternal(url).catch(() => undefined);
          if (!event.sender.isDestroyed()) event.sender.send('environment:loginUrl', { provider: adapter.id, url });
        }
      });
    } finally {
      if (loginAborts.get(adapter.id) === controller) loginAborts.delete(adapter.id);
    }
  });
  ipcMain.handle('environment:cancelLogin', (_event, provider: string) => {
    loginAborts.get(provider)?.abort();
  });
  ipcMain.handle('tools:run', (_event, project: string, name: string, args: string[]) =>
    runTool(getServices().toolsRoot, project, name, args, undefined, getServices().launcher)
  );

  ipcMain.handle('dialog:pickFolder', async (event, options: PickOptions = {}) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window!, { title: options.title, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:pickFiles', async (event, options: PickOptions = {}) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const properties: ('openFile' | 'multiSelections')[] = options.multiple ? ['openFile', 'multiSelections'] : ['openFile'];
    const result = await dialog.showOpenDialog(window!, { title: options.title, filters: options.filters, properties });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('shell:openPath', (_event, path: string) => openDesktopPath(path, (target) => shell.openPath(target)));
  ipcMain.handle('shell:readText', (_event, path: string) => {
    if (statSync(path).size > 2 * 1024 * 1024) throw new Error('Файл больше 2 МБ: выберите текстовый файл меньшего размера.');
    return readFileSync(path, 'utf-8');
  });
}
