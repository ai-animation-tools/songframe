/** Полный контракт API: новый метод главного процесса требует явного решения для витрины. */
import type { Api } from '@shared/api';

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
      create: async () => unconfigured('cover.create'),
      prepare: async () => unconfigured('cover.prepare'),
      generate: async () => unconfigured('cover.generate'),
      view: async () => unconfigured('cover.view'),
      accept: async () => unconfigured('cover.accept'),
      close: async () => unconfigured('cover.close')
    },
    referenceImages: {
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
    productionWorkflow: {
      view: async () => unconfigured('productionWorkflow.view'),
      start: async () => unconfigured('productionWorkflow.start'),
      apply: async () => unconfigured('productionWorkflow.apply'),
      discard: async () => unconfigured('productionWorkflow.discard'),
      generateFrames: async () => unconfigured('productionWorkflow.generateFrames'),
      importFrames: async () => unconfigured('productionWorkflow.importFrames')
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
      state: async () => unconfigured('app.state'),
      setToolsRoot: async () => unconfigured('app.setToolsRoot')
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
      modelSetup: async () => unconfigured('timing.modelSetup'),
      downloadModel: async () => unconfigured('timing.downloadModel'),
      view: async () => unconfigured('timing.view'),
      save: async () => unconfigured('timing.save'),
      generate: async () => unconfigured('timing.generate')
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
      saveScenes: async () => unconfigured('scenario.saveScenes'),
      saveImpact: async () => unconfigured('scenario.saveImpact'),
      validateScenes: async () => unconfigured('scenario.validateScenes'),
      brief: async () => unconfigured('scenario.brief')
    },
    production: {
      view: async () => unconfigured('production.view'),
      decide: async () => unconfigured('production.decide'),
      reopenFrame: async () => unconfigured('production.reopenFrame'),
      keepPackageForScene: async () => unconfigured('production.keepPackageForScene'),
      setKeyframeNote: async () => unconfigured('production.setKeyframeNote'),
      quote: async () => unconfigured('production.quote'),
      submit: async () => unconfigured('production.submit'),
      resume: async () => unconfigured('production.resume'),
      attachResult: async () => unconfigured('production.attachResult'),
      markNotCreated: async () => unconfigured('production.markNotCreated'),
      selectImage: async () => unconfigured('production.selectImage'),
      regenerate: async () => unconfigured('production.regenerate'),
      accept: async () => unconfigured('production.accept'),
      contactSheet: async () => unconfigured('production.contactSheet'),
      park: async () => unconfigured('production.park'),
      speechPlan: async () => unconfigured('production.speechPlan'),
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
    animatic: {
      view: async () => unconfigured('animatic.view'),
      build: async () => unconfigured('animatic.build'),
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
      readText: async () => unconfigured('shell.readText'),
      fileUrl: () => unconfigured('shell.fileUrl'),
      pathForFile: () => unconfigured('shell.pathForFile')
    }
  };
}
