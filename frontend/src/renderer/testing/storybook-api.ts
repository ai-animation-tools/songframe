/** Полный контракт API: новый метод Go-сервиса требует явного решения для витрины. */
import type { Api } from '@shared/api';
import { videoReviewTexts } from '@shared/texts/video-review';

function unconfigured(method: string): never {
  throw new Error(`Storybook: метод ${method} не настроен для этой истории.`);
}

export function unconfiguredStoryApi(): Api {
  // Черновики страниц — страховка любой редактирующей страницы, поэтому по умолчанию они хранятся в памяти
  // витрины, а не требуют настройки в каждой истории; история восстановления подменяет readDraft.
  const drafts = new Map<string, string>();
  const draftKey = (project: string, kind: string): string => `${project}\n${kind}`;
  return {
    ai: {
      access: async () => unconfigured('ai.access')
    },
    updates: {
      view: async () => unconfigured('updates.view'),
      check: async () => unconfigured('updates.check'),
      download: async () => unconfigured('updates.download'),
      install: async () => unconfigured('updates.install')
    },
    cover: {
      inspect: async () => unconfigured('cover.inspect'),
      create: async () => unconfigured('cover.create'),
      prepare: async () => unconfigured('cover.prepare'),
      generate: async () => unconfigured('cover.generate'),
      view: async () => unconfigured('cover.view'),
      accept: async () => unconfigured('cover.accept'),
      close: async () => unconfigured('cover.close')
    },
    referenceImages: {
      inspect: async () => unconfigured('referenceImages.inspect'),
      context: async () => unconfigured('referenceImages.context'),
      create: async () => unconfigured('referenceImages.create'),
      prepare: async () => unconfigured('referenceImages.prepare'),
      generate: async () => unconfigured('referenceImages.generate'),
      view: async () => unconfigured('referenceImages.view'),
      accept: async () => unconfigured('referenceImages.accept'),
      close: async () => unconfigured('referenceImages.close'),
      attach: async () => unconfigured('referenceImages.attach')
    },
    effects: {
      view: async () => unconfigured('effects.view'),
      preview: async () => unconfigured('effects.preview'),
      render: async () => unconfigured('effects.render'),
      remove: async () => unconfigured('effects.remove')
    },
    derivedShots: {
      view: async () => unconfigured('derivedShots.view'),
      save: async () => unconfigured('derivedShots.save'),
      build: async () => unconfigured('derivedShots.build'),
      accept: async () => unconfigured('derivedShots.accept')
    },
    montage: {
      view: async () => unconfigured('montage.view'),
      load: async () => unconfigured('montage.load'),
      save: async () => unconfigured('montage.save'),
      remove: async () => unconfigured('montage.remove'),
      export: async () => unconfigured('montage.export'),
      apply: async () => unconfigured('montage.apply'),
      saveVideo: async () => unconfigured('montage.saveVideo')
    },
    montageWindow: {
      open: async () => unconfigured('montageWindow.open'),
      close: async () => unconfigured('montageWindow.close'),
      send: () => unconfigured('montageWindow.send'),
      onMessage: () => unconfigured('montageWindow.onMessage'),
      onClosed: () => unconfigured('montageWindow.onClosed')
    },
    cameraWindow: {
      open: async () => unconfigured('cameraWindow.open'),
      close: async () => unconfigured('cameraWindow.close'),
      send: () => unconfigured('cameraWindow.send'),
      onMessage: () => unconfigured('cameraWindow.onMessage'),
      onClosed: () => unconfigured('cameraWindow.onClosed')
    },
    notifications: {
      onOpen: () => unconfigured('notifications.onOpen')
    },
    media: {
      capabilities: async () => unconfigured('media.capabilities')
    },
    videoReview: {
      view: async () => ({
        status: 'idle',
        job: null,
        report: null,
        frames: [],
        stale: false,
        canStart: false,
        reason: videoReviewTexts.main.toolsMissing,
        error: null,
        durationSeconds: null
      }),
      start: async () => unconfigured('videoReview.start'),
      cancel: async () => unconfigured('videoReview.cancel')
    },
    productionWorkflow: {
      view: async () => unconfigured('productionWorkflow.view'),
      start: async () => unconfigured('productionWorkflow.start'),
      apply: async () => unconfigured('productionWorkflow.apply'),
      discard: async () => unconfigured('productionWorkflow.discard'),
      fixScenario: async () => unconfigured('productionWorkflow.fixScenario'),
      retryWithFrames: async () => unconfigured('productionWorkflow.retryWithFrames'),
      retryFirstFrame: async () => unconfigured('productionWorkflow.retryFirstFrame'),
      generateFrames: async () => unconfigured('productionWorkflow.generateFrames'),
      importFrames: async () => unconfigured('productionWorkflow.importFrames'),
      buildManual: async () => unconfigured('productionWorkflow.buildManual'),
      prepareRequest: async () => unconfigured('productionWorkflow.prepareRequest'),
      requestOptions: async () => unconfigured('productionWorkflow.requestOptions'),
      setGenerationMethod: async () => unconfigured('productionWorkflow.setGenerationMethod'),
      saveComposition: async () => unconfigured('productionWorkflow.saveComposition'),
      setComposition: async () => unconfigured('productionWorkflow.setComposition'),
      saveOwn: async () => unconfigured('productionWorkflow.saveOwn'),
      referenceImages: async () => unconfigured('productionWorkflow.referenceImages')
    },
    scenarioWorkflow: {
      view: async () => unconfigured('scenarioWorkflow.view'),
      start: async () => unconfigured('scenarioWorkflow.start'),
      apply: async () => unconfigured('scenarioWorkflow.apply'),
      approveCurrent: async () => unconfigured('scenarioWorkflow.approveCurrent'),
      approveScenes: async () => unconfigured('scenarioWorkflow.approveScenes'),
      discard: async () => unconfigured('scenarioWorkflow.discard'),
      checkView: async () => unconfigured('scenarioWorkflow.checkView'),
      startCheck: async () => unconfigured('scenarioWorkflow.startCheck'),
      checkFixPreview: async () => unconfigured('scenarioWorkflow.checkFixPreview'),
      applyCheckFixes: async () => unconfigured('scenarioWorkflow.applyCheckFixes'),
      resolveCheckIssue: async () => unconfigured('scenarioWorkflow.resolveCheckIssue')
    },
    agents: {
      getSettings: async () => unconfigured('agents.getSettings'),
      getProviderSettings: async () => unconfigured('agents.getProviderSettings'),
      saveProviderSettings: async () => unconfigured('agents.saveProviderSettings'),
      saveSettings: async () => unconfigured('agents.saveSettings'),
      check: async () => unconfigured('agents.check'),
      account: async () => unconfigured('agents.account'),
      models: async () => unconfigured('agents.models'),
      start: async () => unconfigured('agents.start'),
      cancel: async () => unconfigured('agents.cancel'),
      get: async () => unconfigured('agents.get'),
      list: async () => unconfigured('agents.list'),
      onEvent: () => unconfigured('agents.onEvent')
    },
    app: {
      state: async () => unconfigured('app.state')
    },
    projects: {
      open: async () => unconfigured('projects.open'),
      create: async () => unconfigured('projects.create'),
      validateNew: async () => unconfigured('projects.validateNew'),
      status: async () => unconfigured('projects.status'),
      rename: async () => unconfigured('projects.rename'),
      close: async () => unconfigured('projects.close'),
      forget: async () => unconfigured('projects.forget'),
      settings: async () => unconfigured('projects.settings'),
      saveSettings: async () => unconfigured('projects.saveSettings'),
      readDraft: async (project, kind) => drafts.get(draftKey(project, kind)) ?? '',
      writeDraft: async (project, kind, content) => {
        drafts.set(draftKey(project, kind), content);
      },
      removeDraft: async (project, kind) => {
        drafts.delete(draftKey(project, kind));
      }
    },
    sources: {
      view: async () => unconfigured('sources.view'),
      validate: async () => unconfigured('sources.validate'),
      save: async () => unconfigured('sources.save')
    },
    timing: {
      vocalsView: async () => unconfigured('timing.vocalsView'),
      downloadVocalModel: async () => unconfigured('timing.downloadVocalModel'),
      separateVocals: async () => unconfigured('timing.separateVocals'),
      selectVocal: async () => unconfigured('timing.selectVocal'),
      deleteVocal: async () => unconfigured('timing.deleteVocal'),
      songModelSetup: async () => unconfigured('timing.songModelSetup'),
      downloadSongModels: async () => unconfigured('timing.downloadSongModels'),
      start: async () => unconfigured('timing.start'),
      cancel: async () => unconfigured('timing.cancel'),
      view: async () => unconfigured('timing.view'),
      save: async () => unconfigured('timing.save')
    },
    cast: {
      view: async () => unconfigured('cast.view'),
      init: async () => unconfigured('cast.init'),
      save: async () => unconfigured('cast.save')
    },
    schemes: {
      view: async () => unconfigured('schemes.view'),
      save: async () => unconfigured('schemes.save'),
      frame: async () => unconfigured('schemes.frame')
    },
    scenario: {
      status: async () => unconfigured('scenario.status'),
      view: async () => unconfigured('scenario.view'),
      saveScenes: async () => unconfigured('scenario.saveScenes'),
      saveScenesKeeping: async () => unconfigured('scenario.saveScenesKeeping'),
      saveImpact: async () => unconfigured('scenario.saveImpact'),
      validateScenes: async () => unconfigured('scenario.validateScenes'),
      brief: async () => unconfigured('scenario.brief')
    },
    production: {
      view: async () => unconfigured('production.view'),
      decide: async () => unconfigured('production.decide'),
      reopenFrame: async () => unconfigured('production.reopenFrame'),
      restoreFrame: async () => unconfigured('production.restoreFrame'),
      reopenPrompt: async () => unconfigured('production.reopenPrompt'),
      keepPackageForScene: async () => unconfigured('production.keepPackageForScene'),
      addKeyframeNote: async () => unconfigured('production.addKeyframeNote'),
      setKeyframeNote: async () => unconfigured('production.setKeyframeNote'),
      quote: async () => unconfigured('production.quote'),
      submit: async () => unconfigured('production.submit'),
      resume: async () => unconfigured('production.resume'),
      attachResult: async () => unconfigured('production.attachResult'),
      attachManual: async () => unconfigured('production.attachManual'),
      replaceManual: async () => unconfigured('production.replaceManual'),
      attachOwnVideo: async () => unconfigured('production.attachOwnVideo'),
      markNotCreated: async () => unconfigured('production.markNotCreated'),
      selectImage: async () => unconfigured('production.selectImage'),
      regenerate: async () => unconfigured('production.regenerate'),
      accept: async () => unconfigured('production.accept'),
      staticShot: async () => unconfigured('production.staticShot'),
      saveStaticRecipe: async () => unconfigured('production.saveStaticRecipe'),
      buildStatic: async () => unconfigured('production.buildStatic'),
      acceptStatic: async () => unconfigured('production.acceptStatic'),
      contactSheet: async () => unconfigured('production.contactSheet'),
      park: async () => unconfigured('production.park'),
      speechPlan: async () => unconfigured('production.speechPlan'),
      // Комплект без сведений генерации: принятые планы историй показывают только видео, пока модель не задана.
      acceptedKit: async () => null,
      resultMedia: async () => null,
      cutPreview: async () => unconfigured('production.cutPreview'),
      recut: async () => unconfigured('production.recut'),
      recutPreview: async () => unconfigured('production.recutPreview'),
      takeFrame: async () => unconfigured('production.takeFrame'),
      spend: async () => ({
        attempts: 0,
        removed: 0,
        images: 0,
        videos: 0,
        rejected: 0,
        ownImages: 0,
        unknown: 0,
        unpriced: 0,
        missing: false,
        local: false,
        manual: 0,
        totals: [],
        acceptedSeconds: null,
        perSecond: [],
        entries: []
      }),
      projectSpend: async () => ({ shots: [], totals: [], unpriced: [], unknown: [], videos: 0, images: 0, manual: 0, ownImages: 0, rejected: 0 }),
      setSpendAmount: async () => unconfigured('production.setSpendAmount'),
      priceAccepted: async () => unconfigured('production.priceAccepted'),
      prepareSpeech: async () => unconfigured('production.prepareSpeech'),
      reopenQuestion: async () => unconfigured('production.reopenQuestion'),
      discardAttempt: async () => unconfigured('production.discardAttempt'),
      exportBundle: async () => unconfigured('production.exportBundle'),
      listBundles: async () => unconfigured('production.listBundles'),
      removeBundle: async () => unconfigured('production.removeBundle')
    },
    dashboard: {
      view: async () => unconfigured('dashboard.view')
    },
    projectHistory: {
      status: async () => ({ available: false, sections: [], changedFiles: 0, head: null, autoError: '' }),
      save: async () => unconfigured('projectHistory.save'),
      checkpoint: async () => undefined,
      points: async () => [],
      restore: async () => unconfigured('projectHistory.restore'),
      compareScenario: async () => unconfigured('projectHistory.compareScenario')
    },
    promptLog: {
      list: async () => [],
      get: async () => null
    },
    animatic: {
      view: async () => unconfigured('animatic.view'),
      build: async () => unconfigured('animatic.build'),
      fragment: async () => unconfigured('animatic.fragment'),
      setStatus: async () => unconfigured('animatic.setStatus')
    },
    checks: {
      list: async () => unconfigured('checks.list'),
      run: async () => unconfigured('checks.run'),
      runAll: async () => unconfigured('checks.runAll'),
      updateViews: async () => unconfigured('checks.updateViews'),
      buildReview: async () => unconfigured('checks.buildReview'),
      listReviews: async () => unconfigured('checks.listReviews'),
      removeReview: async () => unconfigured('checks.removeReview')
    },
    jobs: {
      list: async () => unconfigured('jobs.list'),
      get: async () => unconfigured('jobs.get'),
      copyText: async () => unconfigured('jobs.copyText')
    },
    diagnostics: {
      reportRendererError: () => unconfigured('diagnostics.reportRendererError'),
      crashNotice: async () => unconfigured('diagnostics.crashNotice'),
      previousSession: async () => unconfigured('diagnostics.previousSession'),
      saveReport: async () => unconfigured('diagnostics.saveReport')
    },
    environment: {
      check: async () => unconfigured('environment.check'),
      loginProvider: async () => unconfigured('environment.loginProvider'),
      cancelLogin: async () => unconfigured('environment.cancelLogin'),
      onLoginUrl: () => unconfigured('environment.onLoginUrl'),
      providerAuth: async () => unconfigured('environment.providerAuth'),
      providerBalance: async () => unconfigured('environment.providerBalance')
    },
    tools: {
      run: async () => unconfigured('tools.run')
    },
    dialog: {
      pickFolder: async () => unconfigured('dialog.pickFolder'),
      pickFiles: async () => unconfigured('dialog.pickFiles')
    },
    shell: {
      openPath: async () => unconfigured('shell.openPath'),
      openExternal: async () => unconfigured('shell.openExternal'),
      readText: async () => unconfigured('shell.readText'),
      clipboardText: async () => unconfigured('shell.clipboardText'),
      // Режим окна в витрине ни на что не влияет: полноэкранный просмотр видео проверяется без него.
      setFullscreen: async () => undefined,
      fileUrl: () => unconfigured('shell.fileUrl'),
      onFilesDropped: () => unconfigured('shell.onFilesDropped')
    },
    components: {
      state: async () => unconfigured('components.state'),
      connect: async () => unconfigured('components.connect'),
      download: async () => unconfigured('components.download'),
      configure: async () => unconfigured('components.configure'),
      check: async () => unconfigured('components.check'),
      cancel: async () => unconfigured('components.cancel'),
      catalog: async () => unconfigured('components.catalog'),
      installation: async () => unconfigured('components.installation'),
      install: async () => unconfigured('components.install'),
      cancelInstall: async () => unconfigured('components.cancelInstall'),
      chooseDirectory: async () => unconfigured('components.chooseDirectory'),
      chooseFile: async () => unconfigured('components.chooseFile')
    }
  };
}
