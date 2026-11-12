/** Полный контракт API: новый метод Go-сервиса требует явного решения для витрины. */
import type { Api } from '@shared/api';
import { videoReviewTexts } from '@shared/texts/video-review';

function unconfigured(method: string): never {
  throw new Error(`Storybook: метод ${method} не настроен для этой истории.`);
}

export function unconfiguredStoryApi(): Api {
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
      generateFrames: async () => unconfigured('productionWorkflow.generateFrames'),
      importFrames: async () => unconfigured('productionWorkflow.importFrames'),
      buildManual: async () => unconfigured('productionWorkflow.buildManual'),
      setGenerationMethod: async () => unconfigured('productionWorkflow.setGenerationMethod'),
      saveOwn: async () => unconfigured('productionWorkflow.saveOwn'),
      referenceImages: async () => unconfigured('productionWorkflow.referenceImages')
    },
    scenarioWorkflow: {
      view: async () => unconfigured('scenarioWorkflow.view'),
      start: async () => unconfigured('scenarioWorkflow.start'),
      apply: async () => unconfigured('scenarioWorkflow.apply'),
      approveCurrent: async () => unconfigured('scenarioWorkflow.approveCurrent'),
      approveScenes: async () => unconfigured('scenarioWorkflow.approveScenes'),
      discard: async () => unconfigured('scenarioWorkflow.discard')
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
      saveSettings: async () => unconfigured('projects.saveSettings')
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
    scenario: {
      status: async () => unconfigured('scenario.status'),
      view: async () => unconfigured('scenario.view'),
      saveTreatment: async () => unconfigured('scenario.saveTreatment'),
      validateTreatment: async () => unconfigured('scenario.validateTreatment'),
      saveScenes: async () => unconfigured('scenario.saveScenes'),
      saveImpact: async () => unconfigured('scenario.saveImpact'),
      validateScenes: async () => unconfigured('scenario.validateScenes'),
      brief: async () => unconfigured('scenario.brief')
    },
    production: {
      view: async () => unconfigured('production.view'),
      decide: async () => unconfigured('production.decide'),
      reopenFrame: async () => unconfigured('production.reopenFrame'),
      reopenPrompt: async () => unconfigured('production.reopenPrompt'),
      keepPackageForScene: async () => unconfigured('production.keepPackageForScene'),
      addKeyframeNote: async () => unconfigured('production.addKeyframeNote'),
      setKeyframeNote: async () => unconfigured('production.setKeyframeNote'),
      quote: async () => unconfigured('production.quote'),
      submit: async () => unconfigured('production.submit'),
      resume: async () => unconfigured('production.resume'),
      attachResult: async () => unconfigured('production.attachResult'),
      attachManual: async () => unconfigured('production.attachManual'),
      attachOwnVideo: async () => unconfigured('production.attachOwnVideo'),
      markNotCreated: async () => unconfigured('production.markNotCreated'),
      selectImage: async () => unconfigured('production.selectImage'),
      regenerate: async () => unconfigured('production.regenerate'),
      accept: async () => unconfigured('production.accept'),
      contactSheet: async () => unconfigured('production.contactSheet'),
      park: async () => unconfigured('production.park'),
      speechPlan: async () => unconfigured('production.speechPlan'),
      // Комплект без сведений генерации: принятые планы историй показывают только видео, пока модель не задана.
      acceptedKit: async () => null,
      spend: async () => ({
        attempts: 0,
        removed: 0,
        images: 0,
        videos: 0,
        rejected: 0,
        unknown: 0,
        manual: 0,
        totals: [],
        acceptedSeconds: null,
        perSecond: []
      }),
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
      saveReport: async () => unconfigured('diagnostics.saveReport')
    },
    environment: {
      check: async () => unconfigured('environment.check'),
      loginProvider: async () => unconfigured('environment.loginProvider'),
      cancelLogin: async () => unconfigured('environment.cancelLogin'),
      onLoginUrl: () => unconfigured('environment.onLoginUrl'),
      providerAuth: async () => unconfigured('environment.providerAuth')
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
