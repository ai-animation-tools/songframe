/** Явный перечень границы API: новые методы требуют реализации или объяснённой недоступности. */
import type { Api } from '@shared/api';

export type ApiMethod = { [Group in keyof Api]: `${Group}.${Extract<keyof Api[Group], string>}` }[keyof Api];

/** Подписка на событие ещё не перенесённой области: событие не наступит, отписка ничего не делает. */
const unsubscribed = () => () => undefined;

/** Фабрика создаёт формы всех методов без удачных пустых результатов и обращения к неготовым сервисам. */
export function unavailableApi(asyncFailure: (method: ApiMethod) => Promise<never>, syncFailure: (method: ApiMethod) => never): Api {
  return {
    ai: {
      access: () => asyncFailure('ai.access')
    },
    cover: {
      inspect: () => asyncFailure('cover.inspect'),
      create: () => asyncFailure('cover.create'),
      prepare: () => asyncFailure('cover.prepare'),
      generate: () => asyncFailure('cover.generate'),
      view: () => asyncFailure('cover.view'),
      accept: () => asyncFailure('cover.accept'),
      close: () => asyncFailure('cover.close')
    },
    referenceImages: {
      inspect: () => asyncFailure('referenceImages.inspect'),
      prepare: () => asyncFailure('referenceImages.prepare'),
      generate: () => asyncFailure('referenceImages.generate'),
      view: () => asyncFailure('referenceImages.view'),
      close: () => asyncFailure('referenceImages.close'),
      context: () => asyncFailure('referenceImages.context'),
      create: () => asyncFailure('referenceImages.create'),
      accept: () => asyncFailure('referenceImages.accept'),
      attach: () => asyncFailure('referenceImages.attach')
    },
    derivedShots: {
      view: () => asyncFailure('derivedShots.view'),
      save: () => asyncFailure('derivedShots.save'),
      build: () => asyncFailure('derivedShots.build'),
      accept: () => asyncFailure('derivedShots.accept')
    },
    montage: {
      view: () => asyncFailure('montage.view'),
      load: () => asyncFailure('montage.load'),
      save: () => asyncFailure('montage.save'),
      remove: () => asyncFailure('montage.remove'),
      export: () => asyncFailure('montage.export'),
      apply: () => asyncFailure('montage.apply'),
      saveVideo: () => asyncFailure('montage.saveVideo')
    },
    montageWindow: {
      open: () => asyncFailure('montageWindow.open'),
      close: () => asyncFailure('montageWindow.close'),
      send: () => syncFailure('montageWindow.send'),
      onMessage: unsubscribed,
      onClosed: unsubscribed
    },
    updates: {
      view: () => asyncFailure('updates.view'),
      check: () => asyncFailure('updates.check'),
      download: () => asyncFailure('updates.download'),
      install: () => asyncFailure('updates.install')
    },
    videoReview: {
      view: () => asyncFailure('videoReview.view'),
      start: () => asyncFailure('videoReview.start'),
      cancel: () => asyncFailure('videoReview.cancel')
    },
    notifications: {
      onOpen: unsubscribed
    },
    media: {
      capabilities: () => asyncFailure('media.capabilities')
    },
    productionWorkflow: {
      view: () => asyncFailure('productionWorkflow.view'),
      start: () => asyncFailure('productionWorkflow.start'),
      apply: () => asyncFailure('productionWorkflow.apply'),
      discard: () => asyncFailure('productionWorkflow.discard'),
      generateFrames: () => asyncFailure('productionWorkflow.generateFrames'),
      importFrames: () => asyncFailure('productionWorkflow.importFrames')
    },
    scenarioWorkflow: {
      view: () => asyncFailure('scenarioWorkflow.view'),
      start: () => asyncFailure('scenarioWorkflow.start'),
      apply: () => asyncFailure('scenarioWorkflow.apply'),
      approveCurrent: () => asyncFailure('scenarioWorkflow.approveCurrent'),
      approveScenes: () => asyncFailure('scenarioWorkflow.approveScenes'),
      discard: () => asyncFailure('scenarioWorkflow.discard')
    },
    agents: {
      getSettings: () => asyncFailure('agents.getSettings'),
      getProviderSettings: () => asyncFailure('agents.getProviderSettings'),
      saveProviderSettings: () => asyncFailure('agents.saveProviderSettings'),
      saveSettings: () => asyncFailure('agents.saveSettings'),
      check: () => asyncFailure('agents.check'),
      account: () => asyncFailure('agents.account'),
      models: () => asyncFailure('agents.models'),
      start: () => asyncFailure('agents.start'),
      cancel: () => asyncFailure('agents.cancel'),
      get: () => asyncFailure('agents.get'),
      list: () => asyncFailure('agents.list'),
      onEvent: unsubscribed
    },
    app: {
      state: () => asyncFailure('app.state'),
      setToolsRoot: () => asyncFailure('app.setToolsRoot')
    },
    projects: {
      open: () => asyncFailure('projects.open'),
      create: () => asyncFailure('projects.create'),
      validateNew: () => asyncFailure('projects.validateNew'),
      status: () => asyncFailure('projects.status'),
      rename: () => asyncFailure('projects.rename'),
      close: () => asyncFailure('projects.close'),
      forget: () => asyncFailure('projects.forget'),
      settings: () => asyncFailure('projects.settings'),
      saveSettings: () => asyncFailure('projects.saveSettings')
    },
    sources: {
      view: () => asyncFailure('sources.view'),
      validate: () => asyncFailure('sources.validate'),
      save: () => asyncFailure('sources.save')
    },
    timing: {
      vocalsView: () => asyncFailure('timing.vocalsView'),
      downloadVocalModel: () => asyncFailure('timing.downloadVocalModel'),
      separateVocals: () => asyncFailure('timing.separateVocals'),
      selectVocal: () => asyncFailure('timing.selectVocal'),
      deleteVocal: () => asyncFailure('timing.deleteVocal'),
      songModelSetup: () => asyncFailure('timing.songModelSetup'),
      downloadSongModels: () => asyncFailure('timing.downloadSongModels'),
      start: () => asyncFailure('timing.start'),
      cancel: () => asyncFailure('timing.cancel'),
      view: () => asyncFailure('timing.view'),
      save: () => asyncFailure('timing.save')
    },
    cast: {
      view: () => asyncFailure('cast.view'),
      init: () => asyncFailure('cast.init'),
      save: () => asyncFailure('cast.save')
    },
    scenario: {
      status: () => asyncFailure('scenario.status'),
      view: () => asyncFailure('scenario.view'),
      saveTreatment: () => asyncFailure('scenario.saveTreatment'),
      validateTreatment: () => asyncFailure('scenario.validateTreatment'),
      saveScenes: () => asyncFailure('scenario.saveScenes'),
      saveImpact: () => asyncFailure('scenario.saveImpact'),
      validateScenes: () => asyncFailure('scenario.validateScenes'),
      brief: () => asyncFailure('scenario.brief')
    },
    production: {
      view: () => asyncFailure('production.view'),
      decide: () => asyncFailure('production.decide'),
      reopenFrame: () => asyncFailure('production.reopenFrame'),
      keepPackageForScene: () => asyncFailure('production.keepPackageForScene'),
      addKeyframeNote: () => asyncFailure('production.addKeyframeNote'),
      setKeyframeNote: () => asyncFailure('production.setKeyframeNote'),
      quote: () => asyncFailure('production.quote'),
      submit: () => asyncFailure('production.submit'),
      resume: () => asyncFailure('production.resume'),
      attachResult: () => asyncFailure('production.attachResult'),
      markNotCreated: () => asyncFailure('production.markNotCreated'),
      selectImage: () => asyncFailure('production.selectImage'),
      regenerate: () => asyncFailure('production.regenerate'),
      accept: () => asyncFailure('production.accept'),
      contactSheet: () => asyncFailure('production.contactSheet'),
      park: () => asyncFailure('production.park'),
      speechPlan: () => asyncFailure('production.speechPlan'),
      prepareSpeech: () => asyncFailure('production.prepareSpeech'),
      reopenQuestion: () => asyncFailure('production.reopenQuestion'),
      discardAttempt: () => asyncFailure('production.discardAttempt'),
      exportBundle: () => asyncFailure('production.exportBundle'),
      listBundles: () => asyncFailure('production.listBundles'),
      removeBundle: () => asyncFailure('production.removeBundle')
    },
    dashboard: {
      view: () => asyncFailure('dashboard.view')
    },
    animatic: {
      view: () => asyncFailure('animatic.view'),
      build: () => asyncFailure('animatic.build'),
      setStatus: () => asyncFailure('animatic.setStatus')
    },
    checks: {
      list: () => asyncFailure('checks.list'),
      run: () => asyncFailure('checks.run'),
      runAll: () => asyncFailure('checks.runAll'),
      updateViews: () => asyncFailure('checks.updateViews'),
      buildReview: () => asyncFailure('checks.buildReview'),
      listReviews: () => asyncFailure('checks.listReviews'),
      removeReview: () => asyncFailure('checks.removeReview')
    },
    jobs: {
      list: () => asyncFailure('jobs.list'),
      get: () => asyncFailure('jobs.get'),
      copyText: () => asyncFailure('jobs.copyText')
    },
    diagnostics: {
      reportRendererError: () => syncFailure('diagnostics.reportRendererError'),
      crashNotice: () => asyncFailure('diagnostics.crashNotice'),
      saveReport: () => asyncFailure('diagnostics.saveReport')
    },
    environment: {
      check: () => asyncFailure('environment.check'),
      loginProvider: () => asyncFailure('environment.loginProvider'),
      cancelLogin: () => asyncFailure('environment.cancelLogin'),
      onLoginUrl: unsubscribed,
      providerAuth: () => asyncFailure('environment.providerAuth')
    },
    tools: {
      run: () => asyncFailure('tools.run')
    },
    dialog: {
      pickFolder: () => asyncFailure('dialog.pickFolder'),
      pickFiles: () => asyncFailure('dialog.pickFiles')
    },
    shell: {
      openPath: () => asyncFailure('shell.openPath'),
      readText: () => asyncFailure('shell.readText'),
      fileUrl: () => syncFailure('shell.fileUrl'),
      onFilesDropped: unsubscribed
    },
    components: {
      state: () => asyncFailure('components.state'),
      connect: () => asyncFailure('components.connect'),
      download: () => asyncFailure('components.download'),
      configure: () => asyncFailure('components.configure'),
      check: () => asyncFailure('components.check'),
      cancel: () => asyncFailure('components.cancel'),
      catalog: () => asyncFailure('components.catalog'),
      installation: () => asyncFailure('components.installation'),
      install: () => asyncFailure('components.install'),
      cancelInstall: () => asyncFailure('components.cancelInstall'),
      chooseDirectory: () => asyncFailure('components.chooseDirectory'),
      chooseFile: () => asyncFailure('components.chooseFile')
    }
  };
}
