/**
 * Типополный каркас window.api: createApi заменяет каждый метод вызовом binding Wails.
 * Каркас нужен, чтобы новый метод контракта сразу требовал записи здесь и в адаптере;
 * незаменённый метод бросает ошибку программиста, а тест адаптера проверяет, что таких не осталось.
 */
import type { Api } from '@shared/api';

export type ApiMethod = { [Group in keyof Api]: `${Group}.${Extract<keyof Api[Group], string>}` }[keyof Api];

/** Заглушки каркаса: по ним тест отличает незаменённый метод от реализации адаптера. */
const stubs = new WeakSet<object>();

/** Заглушка метода: вызов означает пропуск в createApi, а не отказ работающего Go-сервиса. */
function stub(method: ApiMethod): () => never {
  const fn = (): never => {
    throw new Error(`Метод window.api ${method} не подключён к binding Wails.`);
  };
  stubs.add(fn);
  return fn;
}

/** true — метод остался заглушкой каркаса и не подключён адаптером. */
export function isApiStub(value: unknown): boolean {
  return typeof value === 'function' && stubs.has(value);
}

/** Создаёт каркас со всеми методами контракта; каждый вызов даёт новый объект для заполнения. */
export function apiSkeleton(): Api {
  return {
    ai: {
      access: stub('ai.access')
    },
    cover: {
      inspect: stub('cover.inspect'),
      create: stub('cover.create'),
      prepare: stub('cover.prepare'),
      generate: stub('cover.generate'),
      view: stub('cover.view'),
      accept: stub('cover.accept'),
      close: stub('cover.close')
    },
    referenceImages: {
      inspect: stub('referenceImages.inspect'),
      prepare: stub('referenceImages.prepare'),
      generate: stub('referenceImages.generate'),
      view: stub('referenceImages.view'),
      close: stub('referenceImages.close'),
      context: stub('referenceImages.context'),
      create: stub('referenceImages.create'),
      accept: stub('referenceImages.accept'),
      attach: stub('referenceImages.attach')
    },
    derivedShots: {
      view: stub('derivedShots.view'),
      save: stub('derivedShots.save'),
      build: stub('derivedShots.build'),
      accept: stub('derivedShots.accept')
    },
    montage: {
      view: stub('montage.view'),
      load: stub('montage.load'),
      save: stub('montage.save'),
      remove: stub('montage.remove'),
      export: stub('montage.export'),
      apply: stub('montage.apply'),
      saveVideo: stub('montage.saveVideo')
    },
    montageWindow: {
      open: stub('montageWindow.open'),
      close: stub('montageWindow.close'),
      send: stub('montageWindow.send'),
      onMessage: stub('montageWindow.onMessage'),
      onClosed: stub('montageWindow.onClosed')
    },
    updates: {
      view: stub('updates.view'),
      check: stub('updates.check'),
      download: stub('updates.download'),
      install: stub('updates.install')
    },
    videoReview: {
      view: stub('videoReview.view'),
      start: stub('videoReview.start'),
      cancel: stub('videoReview.cancel')
    },
    notifications: {
      onOpen: stub('notifications.onOpen')
    },
    media: {
      capabilities: stub('media.capabilities')
    },
    productionWorkflow: {
      view: stub('productionWorkflow.view'),
      start: stub('productionWorkflow.start'),
      apply: stub('productionWorkflow.apply'),
      discard: stub('productionWorkflow.discard'),
      generateFrames: stub('productionWorkflow.generateFrames'),
      importFrames: stub('productionWorkflow.importFrames'),
      buildManual: stub('productionWorkflow.buildManual')
    },
    scenarioWorkflow: {
      view: stub('scenarioWorkflow.view'),
      start: stub('scenarioWorkflow.start'),
      apply: stub('scenarioWorkflow.apply'),
      approveCurrent: stub('scenarioWorkflow.approveCurrent'),
      approveScenes: stub('scenarioWorkflow.approveScenes'),
      discard: stub('scenarioWorkflow.discard')
    },
    agents: {
      getSettings: stub('agents.getSettings'),
      getProviderSettings: stub('agents.getProviderSettings'),
      saveProviderSettings: stub('agents.saveProviderSettings'),
      saveSettings: stub('agents.saveSettings'),
      check: stub('agents.check'),
      account: stub('agents.account'),
      models: stub('agents.models'),
      start: stub('agents.start'),
      cancel: stub('agents.cancel'),
      get: stub('agents.get'),
      list: stub('agents.list'),
      onEvent: stub('agents.onEvent')
    },
    app: {
      state: stub('app.state')
    },
    projects: {
      open: stub('projects.open'),
      create: stub('projects.create'),
      validateNew: stub('projects.validateNew'),
      status: stub('projects.status'),
      rename: stub('projects.rename'),
      close: stub('projects.close'),
      forget: stub('projects.forget'),
      settings: stub('projects.settings'),
      saveSettings: stub('projects.saveSettings')
    },
    sources: {
      view: stub('sources.view'),
      validate: stub('sources.validate'),
      save: stub('sources.save')
    },
    timing: {
      vocalsView: stub('timing.vocalsView'),
      downloadVocalModel: stub('timing.downloadVocalModel'),
      separateVocals: stub('timing.separateVocals'),
      selectVocal: stub('timing.selectVocal'),
      deleteVocal: stub('timing.deleteVocal'),
      songModelSetup: stub('timing.songModelSetup'),
      downloadSongModels: stub('timing.downloadSongModels'),
      start: stub('timing.start'),
      cancel: stub('timing.cancel'),
      view: stub('timing.view'),
      save: stub('timing.save')
    },
    cast: {
      view: stub('cast.view'),
      init: stub('cast.init'),
      save: stub('cast.save')
    },
    scenario: {
      status: stub('scenario.status'),
      view: stub('scenario.view'),
      saveTreatment: stub('scenario.saveTreatment'),
      validateTreatment: stub('scenario.validateTreatment'),
      saveScenes: stub('scenario.saveScenes'),
      saveImpact: stub('scenario.saveImpact'),
      validateScenes: stub('scenario.validateScenes'),
      brief: stub('scenario.brief')
    },
    production: {
      view: stub('production.view'),
      decide: stub('production.decide'),
      reopenFrame: stub('production.reopenFrame'),
      reopenPrompt: stub('production.reopenPrompt'),
      keepPackageForScene: stub('production.keepPackageForScene'),
      addKeyframeNote: stub('production.addKeyframeNote'),
      setKeyframeNote: stub('production.setKeyframeNote'),
      quote: stub('production.quote'),
      submit: stub('production.submit'),
      resume: stub('production.resume'),
      attachResult: stub('production.attachResult'),
      attachManual: stub('production.attachManual'),
      markNotCreated: stub('production.markNotCreated'),
      selectImage: stub('production.selectImage'),
      regenerate: stub('production.regenerate'),
      accept: stub('production.accept'),
      contactSheet: stub('production.contactSheet'),
      park: stub('production.park'),
      speechPlan: stub('production.speechPlan'),
      acceptedKit: stub('production.acceptedKit'),
      spend: stub('production.spend'),
      prepareSpeech: stub('production.prepareSpeech'),
      reopenQuestion: stub('production.reopenQuestion'),
      discardAttempt: stub('production.discardAttempt'),
      exportBundle: stub('production.exportBundle'),
      listBundles: stub('production.listBundles'),
      removeBundle: stub('production.removeBundle')
    },
    dashboard: {
      view: stub('dashboard.view')
    },
    animatic: {
      view: stub('animatic.view'),
      build: stub('animatic.build'),
      fragment: stub('animatic.fragment'),
      setStatus: stub('animatic.setStatus')
    },
    checks: {
      list: stub('checks.list'),
      run: stub('checks.run'),
      runAll: stub('checks.runAll'),
      updateViews: stub('checks.updateViews'),
      buildReview: stub('checks.buildReview'),
      listReviews: stub('checks.listReviews'),
      removeReview: stub('checks.removeReview')
    },
    jobs: {
      list: stub('jobs.list'),
      get: stub('jobs.get'),
      copyText: stub('jobs.copyText')
    },
    diagnostics: {
      reportRendererError: stub('diagnostics.reportRendererError'),
      crashNotice: stub('diagnostics.crashNotice'),
      saveReport: stub('diagnostics.saveReport')
    },
    environment: {
      check: stub('environment.check'),
      loginProvider: stub('environment.loginProvider'),
      cancelLogin: stub('environment.cancelLogin'),
      onLoginUrl: stub('environment.onLoginUrl'),
      providerAuth: stub('environment.providerAuth')
    },
    tools: {
      run: stub('tools.run')
    },
    dialog: {
      pickFolder: stub('dialog.pickFolder'),
      pickFiles: stub('dialog.pickFiles')
    },
    shell: {
      openPath: stub('shell.openPath'),
      openExternal: stub('shell.openExternal'),
      readText: stub('shell.readText'),
      clipboardText: stub('shell.clipboardText'),
      fileUrl: stub('shell.fileUrl'),
      onFilesDropped: stub('shell.onFilesDropped')
    },
    components: {
      state: stub('components.state'),
      connect: stub('components.connect'),
      download: stub('components.download'),
      configure: stub('components.configure'),
      check: stub('components.check'),
      cancel: stub('components.cancel'),
      catalog: stub('components.catalog'),
      installation: stub('components.installation'),
      install: stub('components.install'),
      cancelInstall: stub('components.cancelInstall'),
      chooseDirectory: stub('components.chooseDirectory'),
      chooseFile: stub('components.chooseFile')
    }
  };
}
