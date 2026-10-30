import { countLabel } from '../plural';
import { commonTexts } from './common';
import { navigationTexts } from './navigation';

// Фильтр доступности опор узнаёт ошибку настроек по тому же префиксу, что выводится в сообщении.
const videoSettingsIncomplete = 'Заполните настройки генерации видео';
/** Повторяемые подписи домена имеют один источник для таблиц и отдельных блоков. */
const labels = {
  accept: commonTexts.accept,
  send: 'Отправить',
  firstFrame: commonTexts.media.firstFrame,
  lastFrame: 'Последний кадр',
  audio: commonTexts.media.audio,
  video: commonTexts.media.video,
  image: commonTexts.media.image,
  startSeconds: commonTexts.fields.startSeconds,
  endSeconds: commonTexts.fields.endSeconds,
  reopenFrame: 'Вернуть на доработку',
  description: 'Описание плана',
  inputs: 'Входные материалы',
  notCreated: 'Задание не создано',
  showAllShots: 'Показать все планы',
  deleteFolder: 'Удалить папку',
  prepareRetry: 'Подготовить повтор'
} as const;

/** Одинаковые причины в main и интерфейсе сохраняют один дословный текст. */
const messages = {
  requestProviderMissing: 'В сохранённом запросе не указан провайдер.',
  frameRevisionRequired: 'Опишите, что исправить в опоре.',
  replacementConsentRequired: 'У плана уже есть принятый комплект. Подтвердите замену в диалоге приёмки.',
  descriptionAndFramePlanRequired: 'Сначала утвердите описание и план опор.'
} as const;

/** Тексты производства; целые фразы и параметры сохраняют согласования по @link ../../../docs/ui/texts.md. */
export const productionTexts = {
  /** Готовые сообщения главного процесса сохраняют прежний контракт Error.message и полей API. */
  main: {
    package: {
      descriptionReview: 'описание на согласовании',
      keyframesReview: 'опоры на согласовании',
      promptReview: 'видеопромпт на согласовании',
      requestChoice: 'запрос на подтверждении',
      imageRequestChoice: 'запрос изображения на подтверждении',
      imageSubmitted: 'изображение отправлено, ждём результат',
      imageDownloaded: 'изображение получено, выберите вариант опоры',
      queued: 'отложено в очередь',
      needsRevision: 'требует исправления',
      submitted: 'отправлено, ждём результат',
      downloaded: 'результат получен, ждёт просмотра',
      editReview: 'генерация принята, участок не выбран',
      acceptedPendingMove: 'принята, перенос в assets не завершён',
      requestProviderMissing: messages.requestProviderMissing,
      imageKindRequired: 'Активный запрос опоры должен иметь kind=image.',
      videoReferencesImage: 'Видео-запрос не может ссылаться на попытку изображения.',
      imageHistoryMismatch: 'Активный запрос изображения не совпадает с историей пакета.',
      requestFileMissing: 'В папке запроса нет request.json.',
      packageMaterialsOutside: 'Материалы пакета ссылаются за пределы своей папки.',
      resultFileRequired: 'Результат должен быть обычным файлом в папке запроса.',
      packageFolderRequired: 'Выберите обычную папку рабочего пакета в plan/batches или plan/awaiting.',
      attentionQuestion: ({ name, question }: { name: string; question: string }) => `${name}: ${question || 'вопрос ждёт ответа'}`,
      attentionRevision: ({ name }: { name: string }) => `${name}: замечание записано, доработка с агентом не запущена`,
      attentionPrepared: ({ name }: { name: string }) => `${name}: запрос подготовлен, ждёт отправки, очереди или отказа`,
      attentionUnknownSubmission: ({ name }: { name: string }) => `${name}: исход отправки неизвестен: проверьте историю генераций сервиса`,
      attentionResult: ({ name }: { name: string }) => `${name}: результат получен, ждёт просмотра`,
      attentionImage: ({ name }: { name: string }) => `${name}: изображение получено, выберите опору`,
      retryProviderRequired: ({ shot }: { shot: string }) => `${shot}: сначала выберите провайдера видео в настройках проекта.`,
      retryOriginalProviderMissing: ({ shot }: { shot: string }) => `${shot}: провайдер сцены не указан. Подготовьте новый пакет.`,
      retryProviderMismatch: ({ shot, provider, selectedProvider }: { shot: string; provider: string; selectedProvider: string }) =>
        `${shot}: провайдер сцены — ${provider}, текущий выбранный — ${selectedProvider}. Для подготовки повтора провайдеры должны совпадать.`,
      retryRequestMissing: ({ shot }: { shot: string }) => `${shot}: нет сохранённого запроса для повтора. Подготовьте новый пакет.`,
      retrySnapshotUnreadable: ({ shot }: { shot: string }) => `${shot}: не удалось прочитать снимок сохранённого запроса.`,
      brokenWorkflowMissing: 'нет workflow.json: папка осталась после прерванной операции',
      acceptedOldScene: 'принят по прежней постановке: нужно новое производство',
      acceptedVideoSaved: 'принят, монтажное видео сохранено',
      acceptedVideoMissing: 'принят, файл монтажного видео отсутствует',
      notStarted: 'постановка есть, работа не начата',
      acceptedDecisionPending: ({ question }: { question: string }) => `принят; новая попытка ждёт решения: ${question}`,
      decisionPending: ({ question }: { question: string }) => `ждёт вашего решения: ${question}`,
      orphanPackages: ({ packages }: { packages: string }) => `Пакеты планов, которых нет в реестре: ${packages}.`,
      brokenPackageBlocksQueue: ({ path, reason }: { path: string; reason: string }) =>
        `${path}: ${reason}. Папка мешает сохранению в очередь; удалите её в очереди или у плана.`,
      adapterMissing: ({ provider }: { provider: string | null | undefined }) => `Для провайдера ${provider ?? 'не указан'} не подключён исполнитель.`,
      packageBusy: 'Для этого пакета уже выполняется операция. Дождитесь её завершения.',
      sceneChangedBeforeSubmit: ({ reason }: { reason: string }) => `${reason} Оставьте пакет для текущей постановки или подготовьте новый.`,
      requestChanged: 'Показанный запрос изменился. Откройте подтверждение заново.',
      attemptNotPrepared: 'Эта попытка уже отправлялась или не готова к отправке.',
      submitAdapterMissing: ({ provider }: { provider: string | undefined }) => `Для провайдера ${provider ?? 'не указан'} не подключён исполнитель отправки.`,
      questionOrMaterialsChanged: 'Вопрос или материалы изменились. Откройте подтверждение заново.',
      costAndBalanceUnknown: 'Не удалось определить стоимость и остаток кредитов.',
      materialsChangedDuringQuote: 'Материалы изменились во время проверки стоимости.',
      frameQuestionWriteFailed: ({ frame }: { frame: string }) => `Кандидат сохранён; не удалось записать вопрос об опоре ${frame}.`,
      decisionMaterialsChanged: 'Вопрос или материалы изменились. Обновите пакет перед ответом.',
      refreshQuestion: 'Обновите вопрос перед ответом.',
      separateCostConfirmationRequired: 'Используйте отдельное подтверждение запроса со стоимостью.',
      decideFailed: ({ code }: { code: number | null }) => `shot_workflow decide завершился с кодом ${code}`,
      returnToImageFailed: 'Замечание сохранено; не удалось вернуться к подготовке изображения.',
      frameUnknown: 'Неизвестная опора.',
      frameRevisionRequired: messages.frameRevisionRequired,
      reopenFrameFailed: 'Не удалось вернуть опору на доработку.',
      sceneUnchanged: 'Постановка пакета не менялась.',
      submittedOldSceneCannotRestamp: 'Попытка уже отправлялась: её материалы относятся к прежней постановке, оставить их для новой нельзя.',
      restampFailed: 'Не удалось обновить отпечаток постановки в workflow.json пакета.',
      noteUnknown: 'Неизвестное замечание.',
      noteChangeFailed: 'Не удалось изменить замечание.',
      unfinishedAttemptBlocksRemoval: ({ status }: { status: string }) => `В папке есть попытка в состоянии «${status}»: удалять её без результата нельзя.`,
      folderUsedByMontageDraft: ({ draft }: { draft: string }) => `Папка используется сохранённым черновиком монтажа «${draft}». Сначала удалите черновик.`,
      acceptedPackageCannotRemove: 'Принятый пакет не удаляется: комплект уже в assets.',
      submissionBlocksRemoval: 'Отправка ещё не завершена: сначала получите результат, иначе оплаченная генерация потеряется без файла.',
      packageUsedByMontageDraft: ({ draft }: { draft: string }) => `Пакет используется сохранённым черновиком монтажа «${draft}». Сначала удалите черновик.`,
      packageMissingRefresh: 'Пакет не найден. Обновите страницу производства.',
      questionAlreadyAsked: 'Вопрос уже задан.',
      resultQuestionOnly: 'Вернуть можно только вопрос о полученном результате.',
      askFailed: ({ code }: { code: number | null }) => `shot_workflow ask завершился с кодом ${code}`,
      parkFailed: ({ code }: { code: number | null }) => `shot_workflow park завершился с кодом ${code}`,
      packageMissing: 'Пакет не найден.',
      submittedSpeechImmutable: 'Запрос этой попытки уже отправлен: её WAV менять нельзя. Подготовьте новую попытку.',
      speechBoundsInvalid: 'Конец среза должен быть позже начала, границы — неотрицательные секунды.',
      cutSpeechFailed: ({ code }: { code: number | null }) => `cut_speech завершился с кодом ${code}`,
      speechWavMissing: 'WAV речи не появился в пакете.',
      quoteRequired: 'Сначала откройте запрос и подтвердите актуальную стоимость.',
      quoteMaterialsChanged: 'Показанные материалы изменились: требуется новое подтверждение.',
      quoteExpired: 'Стоимость, остаток или материалы изменились. Откройте подтверждение заново; отправка не выполнялась.',
      unparkFailed: 'Не удалось возобновить отложенный пакет. Отправка не выполнялась.',
      queuedQuestionFailed: 'Не удалось записать вопрос отложенного запроса. Отправка не выполнялась.',
      imageConfirmationFailed: 'Не удалось записать новое подтверждение изображения. Отправка не выполнялась.',
      submitConfirmationFailed: 'Не удалось записать подтверждение отправки.',
      submitJob: ({ shot }: { shot: string }) => `Отправка ${shot}`,
      submitImageJob: ({ frame }: { frame: string | undefined }) => `Отправка опоры ${frame}`,
      verifyMaterialsStep: 'проверка материалов',
      submitStep: 'отправка',
      recordChargeStep: 'запись расхода',
      submittedStep: 'задание отправлено',
      jobNotCreated: 'Исполнитель не создал задание.',
      retryBusy: 'Повтор уже подготавливается.',
      shotMissingRefresh: ({ shot }: { shot: string }) => `План ${shot} не найден. Обновите страницу производства.`,
      unknownSubmissionBlocksRetry: 'Сначала выясните исход существующей отправки; новая оплата запрещена.',
      retryJob: ({ shot }: { shot: string }) => `Подготовка повтора ${shot}`,
      prepareRetryStep: 'новая попытка без отправки',
      retrievePreviousStep: 'получение прежнего задания',
      resultDownloadedStep: 'результат скачан',
      resultIncomplete: 'Результат не получен полностью. Проверьте состояние задания; вопрос приёмки не создан.',
      reviewResultStep: 'просмотр результата',
      technicalSummaryStep: 'техническая сводка',
      attemptMissing: 'В пакете нет попытки.',
      retrieveAdapterMissing: ({ provider }: { provider: string | undefined }) =>
        `Для провайдера ${provider ?? 'не указан'} не подключён исполнитель получения результата.`,
      requestNotSubmitted: 'Запрос ещё не отправлен.',
      generationIdUnknown:
        'ID задания неизвестен. Проверьте историю генераций сервиса: загрузите найденный результат вручную или отметьте, что задание не создано.',
      restoreSubmissionStep: 'восстановление этапа отправки',
      retrieveJob: ({ shot }: { shot: string }) => `Получение ${shot}`,
      unknownSubmissionOnly: 'Действие доступно только попытке с неизвестным исходом отправки и без ID задания. Обновите пакет.',
      resultFileMissing: 'Выберите файл результата.',
      attachResultStep: 'загрузка результата вручную',
      manualResultJob: ({ shot }: { shot: string }) => `Ручной результат ${shot}`,
      markNotCreatedFailed: 'Не удалось отметить, что задание не создано.',
      returnToRequestFailed: 'Не удалось вернуть пакет к подтверждению запроса.',
      requestQuestionFailed: 'Не удалось записать вопрос о запросе.',
      candidateChanged: 'Кандидат изменился или недоступен. Обновите пакет и просмотрите результат.',
      selectFrameFailed: 'Не удалось выбрать опору.',
      imageAcceptedSeparately: 'Изображение выбирается как кандидат опоры и утверждается отдельно.',
      packageShotMismatch: 'Пакет относится к другому плану.',
      acceptResultChanged: 'Результат изменился. Обновите пакет и просмотрите его перед приёмкой.',
      completeResultRequired: 'Сначала получите полный результат задания.',
      replacementConsentRequired: messages.replacementConsentRequired,
      acceptBoundsInvalid: ({ fps }: { fps: number }) =>
        `Границы участка должны быть конечными неотрицательными секундами на сетке ${countLabel(fps, 'кадр', 'кадра', 'кадров')}/с.`,
      acceptEndInvalid: 'Конец участка должен быть позже начала.',
      acceptSpeechRequired: 'Речевой план: сначала подготовьте WAV речи в блоке «Речь» этого пакета.',
      acceptJob: ({ shot }: { shot: string }) => `Приёмка ${shot}`,
      replaceAssetsStep: 'замена комплекта в assets',
      moveAssetsStep: 'перенос в assets',
      bundleAbsolutePathRequired: 'Укажите абсолютный путь папки пакета.',
      bundlePathInvalid: 'Внутри проекта пакет можно собирать только в plan/batches; иначе выберите папку вне проекта.',
      bundleFolderNotEmpty: ({ path }: { path: string }) => `Папка не пуста: ${path}`,
      bundleViewsStep: commonTexts.runtime.updateViewsStep,
      bundleJob: ({ copy }: { copy: boolean | undefined }) => `Пакет для монтажёра${copy ? ' с медиа' : ''}`,
      bundleExportStep: 'Сборка пакета для монтажёра',
      bundleBusy: 'Пакет ещё собирается. Дождитесь завершения задания.',
      bundleMissing: 'Собранный пакет не найден. Обновите список.',
      scenePackageCannotRemoveAsBundle: 'Нельзя удалить рабочий пакет сцены как пакет для монтажёра.',
      contactSheetJob: ({ name }: { name: string }) => `Сводка ${name}`,
      contactSheetStep: 'контактный лист'
    },
    access: {
      savedRequestRequired: 'В пакете нет сохранённого запроса.',
      requestProviderMissing: messages.requestProviderMissing,
      mediaProviderChanged: 'Провайдер медиа изменился. Подготовьте новый запрос для выбранного провайдера.'
    },
    proposal: {
      unknownFields: 'Ответ содержит неизвестные поля.',
      pathRequired: 'Нужен путь файла.',
      pathOutsideProject: ({ path }: { path: string }) => `Путь выходит из проекта: ${path}`,
      parentMissing: 'Не найден родитель пути.',
      linkOutsideProject: ({ path }: { path: string }) => `Ссылка ведёт за пределы проекта: ${path}`,
      durationPositiveIntegerRequired: 'Длительность запроса должна быть положительным целым числом секунд.',
      durationRuleViolation: ({ seconds, rule, window }: { seconds: number; rule: string; window: number }) =>
        `Длительность ${seconds} с нарушает правило ${rule} для окна ${window} с.`,
      frameImageRequired: 'Добавьте изображение хотя бы для одной опоры.',
      frameCandidateInvalid: 'Неверный кандидат опоры.',
      frameCandidateOrderInvalid:
        'Кандидаты должны относиться к неутверждённым опорам плана, без повторов и в порядке плана; нужен абсолютный путь изображения.',
      frameFileRequired: ({ frame }: { frame: unknown }) => `${frame}: нужен обычный файл изображения.`,
      frameFormatRequired: ({ frame }: { frame: unknown }) => `${frame}: требуется PNG, JPEG или WebP.`,
      proposalVersionOrStageInvalid: 'Неверная версия или этап предложения.',
      descriptionInvalid: 'Описание требует текст, длительность и минимум две опоры.',
      speechDurationRange: ({ min, max }: { min: number; max: number }) =>
        `Речевой план: длительность запроса должна быть от ${min} до ${max} с — столько звука принимает провайдер видео.`,
      frameStructureInvalid: 'Неверная структура опоры.',
      framePlanInvalid: 'Неверные ID, роли, порядок, промпт или референсы опор.',
      frameBoundariesInvalid: 'Первая опора должна быть на 0, последняя — на границе запроса.',
      videoPromptRequired: 'Нужен непустой видеопромпт.',
      requestSpecificationRequired: 'Нужна спецификация запроса.',
      requestStructureInvalid: 'Неверная модель, команда, параметры, входы или число результатов.',
      requestReservedParameter: 'Недопустимое техническое поле параметров; файлы задаются только через inputs, промпт — сохранённым файлом.',
      requestDurationMismatch: 'Длительность запроса отличается от согласованного плана опор.',
      requestInputInvalid: 'Неверный вход запроса.',
      requestInputPathInvalid: 'Вход запроса должен ссылаться на объявленный исходник или утверждённую опору.',
      videoAdapterMissing: ({ provider }: { provider: string }) => `Для провайдера видео ${provider} не подключён исполнитель запроса.`,
      inputFlagUnknown: ({ flag, flags }: { flag: string; flags: string }) => `Неизвестный флаг входа ${flag}; допустимы input и ${flags}.`,
      providerUnspecified: 'не указан'
    },
    workflow: {
      sceneChangedReason:
        'постановка плана изменилась после подготовки пакета: оставьте пакет для текущей постановки, доработайте описание или подготовьте новый пакет',
      packageFolderRequired: 'Выберите отдельный пакет в plan/batches или plan/awaiting.',
      fileUnreadable: ({ path }: { path: string }) => `Не удалось прочитать файл: ${path}`,
      packageLink: ({ path }: { path: string }) => `Пакет содержит ссылку: ${path}`,
      shotIdRequired: 'Укажите один явный ID плана Mxx.',
      sceneRegistryInvalid: 'Нет корректного plan/scenes.json.',
      shotMissing: ({ shot }: { shot: string }) => `План ${shot} отсутствует в реестре.`,
      shotWindowInvalid: 'Неверное кадровое окно плана.',
      videoSettingsRequired: ({ providers }: { providers: string }) => `${videoSettingsIncomplete} проекта: поддерживается провайдер ${providers}.`,
      providerLipSyncUnsupported: ({ provider }: { provider: string }) =>
        `Речевой план: ${provider} не синхронизирует губы с заданным звуком. Снимите отметку «Липсинк» у плана на странице «Сценарий» или выберите другого провайдера видео.`,
      speechWindowTooLong: ({ seconds, provider, max }: { seconds: string; provider: string; max: number }) =>
        `Речевой план: окно плана ${seconds} с длиннее, чем ${provider} принимает звук (до ${max} с). Разделите план на странице «Сценарий».`,
      packageMissingOrWrongShot: 'Пакет отсутствует или относится к другому плану.',
      jobInterrupted: commonTexts.proposal.interrupted,
      proposalIncomplete: 'Агент не завершил подготовку предложения.',
      agentRefused: 'Агент отказался подготовить предложение. Возможно, в сценарии есть противоречия.',
      videoSettingsIncomplete,
      operationBusy: 'идёт задание агента или операция пакета',
      resolveProposalFirst: 'сначала примените или отклоните текущее предложение',
      resolvePackageQuestionFirst: 'сначала ответьте на вопрос согласования в карточке пакета',
      speechLengthOutOfRange: ({ seconds, min, max }: { seconds: string; min: number; max: number }) =>
        `речевой план: WAV длится ${seconds} с, а провайдер принимает звук от ${min} до ${max} с — обрежьте заново в блоке «Речь»`,
      resolveImageFirst: 'сначала завершите согласование или получение изображения',
      approveScenarioFirst: 'сценарий не утверждён в приложении: утвердите кастинг, трактовку и сцены на странице «Сценарий»',
      acceptedDescriptionAndFramesRequired: 'нужен выбранный пакет с принятым описанием и опорами',
      sentAttemptNeedsRetry: 'попытка уже отправлена: дальше только повтор или возврат с замечанием',
      speechRequiredHint: 'речевой план: сначала подготовьте WAV речи в блоке «Речь»',
      framesAcceptedPromptNext: 'опоры приняты, видеопромпт готовится этой кнопкой после принятия описания',
      createAndAcceptFramesFirst: 'сначала создайте и примите опоры',
      applyAndAcceptDescriptionFirst: 'сначала примените и примите описание плана',
      acceptedDescriptionRequired: 'нужен выбранный пакет с принятым описанием',
      attemptAlreadySent: 'попытка уже отправлена',
      framesAlreadyAccepted: 'опоры уже приняты',
      acceptFrameFirstHint: ({ frame }: { frame: string | null }) => `сначала утвердите опору ${frame} или отправьте её на доработку`,
      framePlanMissing: 'в пакете нет плана опор: примените описание с промптами опор',
      acceptDescriptionFirst: 'сначала примите описание плана',
      startParametersInvalid: 'Неверные параметры подготовки производства.',
      currentImageUnresolved: 'Сначала завершите согласование или получение текущего изображения. Новая отправка автоматически не создаётся.',
      waitForJob: 'Дождитесь завершения текущего задания.',
      resolveProposalFirstError: commonTexts.proposal.resolveCurrent,
      scenarioAndSettingsRequired: 'Сначала утвердите актуальный сценарий и настройки генерации.',
      packageUnavailable: 'Выберите доступный пакет приложения.',
      resolveQuestionFirst: 'Сначала ответьте на текущий вопрос согласования.',
      descriptionOrFramesReviewRequired: 'На этом этапе требуется согласование описания или опор.',
      stageUnavailable: 'Запрошенный этап ещё не доступен.',
      resolveSceneChangedPackageFirst: ({ reason }: { reason: string }) => `Сначала решите судьбу пакета: ${reason}.`,
      toolsRootMissing: commonTexts.runtime.rootMissing,
      continuityFailed: 'Не удалось получить врезку непрерывности.',
      providerCapabilitiesMissing: 'Выбранный провайдер видео не объявляет возможности.',
      providerModelsFailed: ({ provider, problem }: { provider: string | undefined; problem: string | null }) =>
        `Не удалось получить актуальные модели ${provider ?? 'провайдера видео'}: ${problem || 'нет объявлений аккаунта'}`,
      speechRequired: 'Речевой план: сначала подготовьте WAV речи в блоке «Речь».',
      providerAudioUnsupported: ({ provider }: { provider: string | undefined }) =>
        `Модели ${provider ?? 'провайдера'} в этом аккаунте не принимают звуковой вход: точный липсинк по WAV недоступен. Чтобы сделать план без синхронизации губ, снимите отметку «Липсинк» у плана на странице «Сценарий».`,
      inputsChangedDuringPreparation: 'Входные материалы изменились во время подготовки задания.',
      descriptionAndFramePlanRequired: messages.descriptionAndFramePlanRequired,
      acceptFrameFirst: ({ frame }: { frame: string | null }) => `Сначала утвердите опору ${frame} или отправьте её на доработку.`,
      allFramesCreated: 'Все опоры уже созданы.',
      imageProviderRequired: ({ providers }: { providers: string }) => `Выберите провайдера генерации изображений в настройках проекта: ${providers}.`,
      imageAdapterMissing: ({ provider }: { provider: string }) => `Исполнитель изображений ${provider} не подключён.`,
      discardUnavailable: 'Предложение недоступно для отклонения; выполняющееся задание сначала отмените.',
      proposalDiscarded: 'Предложение отклонено пользователем.',
      applyUnavailable: 'Применимо только завершённое актуальное предложение.',
      scenarioApprovalStale: 'Утверждение сценария устарело.',
      agentResultMissing: 'Нет успешного результата агента.',
      proposalImagesChanged: 'Изображения предложения изменились.',
      proposalStale: 'Предложение устарело: изменились материалы или пакет.',
      toolExitCode: ({ tool, code }: { tool: string; code: number | null }) => `${tool}: код ${code}`,
      workflowNotCreated: 'Инструмент не создал workflow.json.',
      workflowFrameInvalid: 'Неверная опора в workflow.',
      acceptedFramesChanged: 'Утверждённые опоры изменились.',
      workflowMissing: 'Отсутствует workflow.json.',
      frameOrPromptApprovalStale: 'Утверждение опор или промпта устарело.',
      speechInputRequired: 'Речевой план: запрос должен передавать подготовленный WAV из блока «Речь» звуковым входом модели.',
      requestShorterThanSpeech: ({ seconds }: { seconds: string }) => `Речевой план: длительность запроса должна быть не меньше длины WAV (${seconds} с).`
    },
    apply: {
      packageFolderRequired: 'Нужен отдельный рабочий пакет внутри plan/batches или plan/awaiting.',
      workflowCorrupt: 'Повреждён workflow рабочего пакета.',
      activeImageHistoryMissing: 'Активная image-попытка отсутствует в истории.',
      imageHistoryCorrupt: 'Повреждена история запросов изображений.',
      imageHistoryEntryInvalid: 'Неверная запись истории image-попытки.',
      imageFolderUnavailable: 'Папка image-попытки недоступна внутри пакета.',
      imageFoldersOverlap: 'Папки image-попыток пересекаются.',
      imageReplacesVideoRequest: 'Image-попытка не должна заменять video request_dir.',
      imageHashOrKindMismatch: 'SHA или kind защищённой image-попытки не совпадает с историей.',
      imageContainsVideoOrPaidRequest: 'Image-попытка содержит видео или вложенную неизвестную оплату.',
      imageContainsLink: 'Защищённая image-попытка содержит ссылку вместо локального файла.',
      imageFileTypeUnknown: 'Защищённая image-попытка содержит неизвестный тип файла.',
      protectedImageHistoryChanged: 'История защищённых image-попыток изменилась.',
      protectedImageChanged: 'Защищённая image-попытка или её оригиналы изменились; автоматическое восстановление остановлено.',
      packageContainsPaidRequest: 'Пакет содержит видео или неизвестную платную попытку; резерв сохранён.',
      projectUnavailable: 'Проект недоступен по прежнему пути; резерв сохранён.',
      backupMissing: 'Отсутствует резерв рабочего пакета.',
      paidPackageBlocksRecovery: 'Пакет уже содержит платную попытку; автоматическое восстановление остановлено, резерв сохранён.',
      paidBackupBlocksRecovery: 'Резерв содержит платную попытку; автоматическое восстановление остановлено.',
      paidVideoRequiresRetry: 'После платной отправки видео или неизвестного запроса нужна новая попытка с retry_of.',
      resolveImageAttemptFirst: 'Сначала завершите image-попытку и выберите опору.',
      previousApplyUnrecovered: 'Предыдущее применение не восстановлено. Перезапустите приложение.',
      applyRecoveryFailed: ({ error, restoreError }: { error: string; restoreError: string }) =>
        `Применение прервано: ${error}. Восстановление не завершено: ${restoreError}. Резерв сохранён.`,
      recoveryRecordInvalid: 'Неверная запись восстановления.',
      protectedImagesSnapshotInvalid: 'Неверный снимок защищённых image-попыток.',
      recoveryPathMismatch: 'Путь восстановления не совпадает с журналом.',
      recoveryFailed: ({ errors }: { errors: string }) => `Не удалось восстановить применение производства: ${errors}`
    },
    imageRequest: {
      providerRequired: ({ provider }: { provider: string }) => `Выберите ${provider} для изображений в настройках проекта.`,
      oneFrameRequired: 'Один платный запрос подготавливается для одной опоры.',
      seriesUnsupported: ({ series }: { series: string }) => `Для одной опоры выберите обычный режим без серии ${series}.`,
      referenceUnavailable: ({ path }: { path: string }) => `Недоступен референс опоры: ${path}`
    },
    images: {
      frameDescriptionsRequired: commonTexts.generation.frameDescriptionsRequired,
      referenceUnavailable: ({ path }: { path: string }) => `Недоступен референс опоры: ${path}`,
      approvedFrameUnavailable: ({ frame }: { frame: string }) => `Недоступна утверждённая опора ${frame}.`,
      jobTitle: ({ shot, frames, provider }: { shot: string; frames: string; provider: string }) => `Опоры ${shot}: ${frames} · ${provider}`,
      jobIncomplete: 'Задание опор не завершено успешно.',
      jobRequestMismatch: 'Задание опор относится к другому согласованному запросу.',
      jobRecordCorrupt: 'Повреждена запись задания опор.',
      referencesChanged: 'Референсы изменились: подготовьте опоры заново.',
      fileListMissing: ({ provider }: { provider: string }) => `${provider} не вернул список файлов опор.`,
      resultContractInvalid: 'Неверный контракт результата опор.',
      frameEntryInvalid: 'Неверная запись опоры.',
      framePathInvalid: 'Неверный путь опоры.',
      frameImageRequired: ({ frame }: { frame: unknown }) => `Опора ${frame}: нужен настоящий файл изображения в папке кандидатов.`,
      frameExtensionMismatch: ({ frame }: { frame: unknown }) =>
        `Опора ${frame}: расширение не соответствует фактическому формату изображения. Исходный файл сохранён.`,
      framesIncomplete: ({ provider }: { provider: string }) => `${provider} вернул не все согласованные опоры.`,
      workDirectoryUnavailable: 'Рабочая папка опор недоступна. Подготовьте новое задание.',
      requestHashCorrupt: 'Повреждён SHA запроса опор.'
    },
    acceptance: {
      sceneComparisonFailed: ({ error }: { error: string }) => `Постановку планов не удалось сверить с принятыми комплектами: ${error}`,
      productionStatusCorrupt: ({ path }: { path: string }) => `${path} повреждён: исправьте файл, чтобы записать принятые отпечатки.`
    },
    speech: {
      sceneRegistryUnreadable: 'Не удалось прочитать реестр сцен.',
      shotMissing: ({ shot }: { shot: string }) => `${shot}: план отсутствует в реестре сцен.`
    }
  },
  verdictLabels: {
    approve: labels.accept,
    revise: 'Вернуть с замечанием',
    send: labels.send,
    park: 'Сохранить в очередь',
    accept: labels.accept,
    retry: 'Повторить запрос',
    review: 'Собрать пробу'
  },
  verdictHints: {
    approve: 'Подтверждает показанные материалы и открывает следующий этап.',
    revise: 'Сохраняет замечание для агента; доработку вы запускаете отдельно в блоке «Подготовка плана».',
    send: 'Открывает проверку стоимости и отдельное подтверждение платной отправки.',
    park: 'Сохраняет подготовленный запрос в очередь без отправки; вернуться к нему можно через «Очередь».',
    accept: 'Переносит результат в assets как принятый комплект сцены.',
    retry: 'Готовит новую попытку с теми же опорами и промптом; оплата подтверждается отдельно.',
    review: 'Открывает «Монтаж пробы» с соседними планами: выберите в материалах результат этой попытки. Вопрос остаётся открытым.'
  },
  filterLabels: {
    all: 'Все планы',
    attention: 'Ждут вашего действия',
    progress: 'В работе',
    planned: 'Не начатые',
    completed: 'Принятые',
    stale: 'Постановка изменена',
    queued: navigationTexts.blocks.productionQueue
  },
  filterEmptyHints: {
    all: 'В реестре сцен нет планов. Создайте сценарий на странице «Сценарий».',
    attention:
      'Ни один пакет не ждёт вашего действия. Здесь появятся планы с открытым вопросом, подготовленным запросом, незапущенной доработкой или полученным результатом.',
    progress: 'Нет планов в работе. Они появятся после подготовки описания или повтора по сохранённому запросу.',
    planned: 'Нет не начатых планов: у каждого есть пакет или принятый комплект.',
    completed: 'Принятых планов ещё нет. Они появятся после приёмки результата в assets.',
    stale: 'Нет планов, принятых по прежней постановке. Они появятся, если сохранить правку постановки принятого плана на странице «Сценарий».',
    queued: 'Очередь пуста. Здесь появятся запросы после нажатия «Сохранить в очередь».'
  },
  passLabels: { description: 'Описание', frames: 'Опорные кадры', prompt: 'Видеопромпт', request: 'Запрос' },
  proposalLabels: {
    running: 'Агент готовит предложение',
    ready: 'Готово к просмотру',
    invalid: 'Результат требует исправления',
    failed: 'Задание завершилось с ошибкой',
    interrupted: 'Задание прервано',
    applied: commonTexts.proposal.applied
  },
  attemptLabels: {
    prepared: 'попытка подготовлена',
    submitting: 'отправляется',
    submission_unknown: 'исход отправки неизвестен',
    submitted: 'отправлено',
    running: 'генерируется',
    watermark_free_pending: 'ждём версию без логотипа',
    outputs_pending: 'ждём результаты',
    download_pending: 'ждём скачивания',
    downloading: 'скачивается',
    downloaded: 'скачано',
    failed: 'сервис сообщил об ошибке'
  },
  inputRoles: {
    first: labels.firstFrame,
    middle: 'Промежуточный кадр',
    last: labels.lastFrame,
    reference: 'Референс',
    audio: labels.audio,
    video: labels.video
  },
  inputSlots: { first_image: labels.firstFrame, tail_image: labels.lastFrame, image: labels.image, audio: labels.audio, video: labels.video },
  revisionExamples: {
    description_review: 'Например: герой должен выйти из дома, а не остаться у окна.',
    keyframes_review: 'Например: в первом опорном кадре сохранить одежду героя из предыдущего плана.',
    prompt_review: 'Например: камера медленно приближается к герою, без смены ракурса.',
    request_choice: 'Например: заменить последнюю опору и уточнить движение камеры перед отправкой.',
    image_request_choice: 'Например: уточнить позу героя и освещение в запросе изображения.'
  },
  frameRoleLabels: { first: 'первый кадр', middle: 'промежуточный', last: 'последний кадр' },

  derivedShotNotice: {
    description: 'План собирается из материала {source}. Соберите предпросмотр по явному рецепту и примите результат.'
  },
  productionPage: {
    pythonMissing: `Python не найден: просмотр работает, кнопки решений и отправки недоступны.`,
    paidProviderMissing: `Программа платного провайдера генерации не найдена: отправка и получение результатов недоступны, подготовка и согласования работают.`,
    packageLabel: 'Пакет для просмотра и подготовки',
    packageSelectionHint: 'Выбор закреплён: пакеты, созданные агентом, не переключают просмотр. Новая попытка после «Подготовить повтор» открывается сама.',
    choosePackage: `Выберите пакет`,
    newPreparation: `Новая подготовка`,
    queuedPrefix: ({ queued, relative, stage }: { queued: boolean; relative: string; stage: string }) =>
      `${queued ? 'В очереди · ' : ''}${relative} · ${stage}`,
    choosePackageHint: `Выберите пакет, чтобы увидеть материалы, согласования и действия агента.`,
    summaryStarted: 'Сводка запущена',
    resultQuestionReopened: 'Вопрос о результате задан снова',
    resumeStarted: 'Получение результата запущено',
    importStarted: 'Загрузка результата запущена',
    submissionReset: 'Попытка снова ждёт подтверждения отправки',
    chooseShot: `Выберите план.`,
    retryStarted: 'Подготовка повтора запущена',
    acceptanceStarted: 'Приёмка запущена'
  },
  constants: {
    pythonReason: 'Python не найден: проверьте его на странице «Среда».'
  },
  decisions: {
    requestHashMissing: 'У показанного запроса нет SHA256. Обновите пакет перед отправкой.',
    quoteRequired: 'Перед отправкой обновите и подтвердите стоимость запроса.',
    consentMismatch: 'Согласие относится к другой проверке стоимости. Подтвердите запрос заново.',
    resultUnconfirmed: 'Результат не подтверждён. Обновите пакет и откройте приёмку заново.',
    replacementRequired: messages.replacementConsentRequired
  },
  useProductionPage: {
    jobFailed: ({ title, error, code }: { title: string; error: string | undefined; code: number | null }) =>
      `${title}: ${error ?? `завершилось с кодом ${code}`}`,
    jobDone: ({ title }: { title: string }) => `${title}: выполнено.`,
    launchingAction: 'Запуск действия…',
    revisionNoteRequired: 'Для возврата напишите замечание: что исправить.',
    submissionUnknown: 'Исход отправки ещё неизвестен. Продолжите получение по существующему ID.',
    parked: 'Пакет сохранён в очередь: он в списке «Очередь», генерация не запускалась.',
    frameNoteSaved: ({ frame }: { frame: string }) =>
      `Замечание к ${frame} сохранено. Создайте опору заново кнопкой «Создать ${frame}» в блоке «Подготовка плана».`,
    revisionSaved: 'Замечание сохранено. Нажмите «Запустить доработку с агентом» в блоке подготовки.',
    frameApproved: ({ frame }: { frame: string }) => `Опора ${frame} утверждена.`,
    answerSaved: ({ label }: { label: string }) => `Ответ записан: ${label}`,
    relocated: 'Пакет перенесён. Откройте его в очереди на странице «Производство».',
    frameReopened: ({ frame }: { frame: string }) =>
      `Опора ${frame} возвращена на доработку. Создайте её заново кнопкой «Создать ${frame}» в блоке «Подготовка плана».`,
    sceneRetained: 'Пакет оставлен для текущей постановки: подготовку и отправку можно продолжать.',
    frameNoteActivated: 'Замечание к опорам снова действует.',
    frameNoteDeactivated: 'Замечание снято: агент больше не получит его при создании опор.',
    candidateUnconfirmed: 'Результат не подтверждён. Обновите пакет перед выбором опоры.',
    candidateSelected: 'Изображение выбрано как опора. Утвердите опоры отдельно.',
    requestSubmitted: ({ shot }: { shot: string }) => `Запрос ${shot} отправлен. Результат придёт уведомлением, когда сервис его вернёт.`,
    attemptDeleted: ({ relative }: { relative: string }) => `Попытка ${relative} удалена`,
    folderDeleted: ({ relative }: { relative: string }) => `Папка ${relative} удалена`
  },
  useProductionWorkflow: {
    proposalReady: ({ stage }: { stage: string }) => `${stage}: предложение агента готово. Откройте «Просмотреть предложение и сравнение».`,
    proposalRefused: ({ stage }: { stage: string }) =>
      `${stage}: агент отказался подготовить предложение. Возможно, в сценарии есть противоречия. Причина — в «Просмотреть предложение и сравнение».`,
    proposalInvalid: ({ stage, message }: { stage: string; message?: string }) =>
      `${stage}: результат агента требует исправления.${message ? ` ${message}` : ''}`,
    proposalFailed: ({ stage, failed, message }: { stage: string; failed: boolean; message?: string }) =>
      `${stage}: задание агента ${failed ? 'завершилось с ошибкой' : 'прервано'}.${message ? ` ${message}` : ''}`,
    jobFailed: ({ task, failed }: { task: string; failed: boolean }) => `${task}: задание агента ${failed ? 'завершилось с ошибкой' : 'прервано'}.`,
    applied: commonTexts.proposal.appliedSentence,
    discarded: 'Предложение отклонено.'
  },
  useRequestQuote: {
    quoteMismatch: 'Оценка относится к другому запросу. Откройте пакет заново.'
  },
  acceptResultDialog: {
    title: ({ shot }: { shot: string }) => `Принять результат ${shot}`,
    replace: 'Заменить комплект',
    accept: labels.accept,
    resultUnconfirmed: 'Данные показанного результата не подтверждены: обновите пакет и откройте приёмку заново.',
    speechRequired: 'Это речевой план: сначала подготовьте WAV речи в блоке «Речь» этого пакета.',
    replacementRequired: 'Отметьте «Заменить принятый комплект этим результатом».',
    replacementDescription: ({ shot }: { shot: string }) =>
      `У плана ${shot} уже есть принятый комплект. Новый результат займёт его место в assets/shots, а прежний комплект целиком переедет в assets/replaced/${shot}: оригинал, монтаж, опоры и промпт сохранятся, но в сборку он больше не войдёт. Аниматик после замены нужно пересобрать.`,
    replaceCheckbox: 'Заменить принятый комплект этим результатом',
    durationMismatch: ({ originalSeconds, windowSeconds, holdLast }: { originalSeconds: string; windowSeconds: string; holdLast: boolean }) =>
      `Оригинал длиной ${originalSeconds} с не совпадает с окном плана ${windowSeconds} с, поэтому принять его целиком нельзя. Предложен участок ${holdLast ? 'с удержанием последнего кадра' : 'по длине окна'}; при необходимости поправьте его.`,
    section: 'Монтажный участок',
    full: `Оригинал целиком совпадает с окном плана`,
    cut: `Участок оригинала (секунды, конец исключительно)`,
    cutStart: labels.startSeconds,
    cutEnd: labels.endSeconds,
    speed: 'Скорость',
    speedHint: 'множитель, например 1 или 0.8',
    holdLast: 'Удержать последний кадр, кадров',
    consequences: `Оригинал, принятый монтаж, кадры, промпт и сведения о приёмке будут сохранены в комплекте сцены. Рабочие пакеты плана будут очищены, карточки и списки — обновлены.`
  },
  keyframeNoteScopeField: {
    following: 'Учесть и для следующих опор',
    followingHint: 'Замечание передаётся агенту при создании этой опоры и всех следующих опор пакета.',
    singleHint: 'Замечание передаётся агенту только при повторном создании этой опоры.'
  },
  keyframeNotes: {
    heading: ({ active }: { active: number }) => `Замечания к опорам · ${active}`,
    description: ({ inactive }: { inactive: number }) =>
      `Агент получает их в задании создания опоры. Замечание «только Kxx» учитывается при создании этой опоры, «Kxx и следующие» — также при создании всех следующих опор пакета.${inactive ? ` Снятых замечаний: ${inactive}, они больше не передаются.` : ''}`,
    allFrames: 'все',
    followingFrames: ({ frame }: { frame: string }) => `${frame} и следующие опоры`,
    allFramesLabel: 'все опоры',
    singleFrame: ({ frame }: { frame: string }) => `только ${frame}`,
    singleFrameLabel: 'только одна опора',
    removeFrame: ({ frame }: { frame: string }) => `Снять замечание к ${frame}`,
    removeAll: 'Снять замечание ко всем опорам',
    removeHint: 'Снять замечание: агент перестанет его получать'
  },
  keyframeReopenDialog: {
    title: ({ frame }: { frame: string }) => `Вернуть опору ${frame} на доработку`,
    description: ({ frame }: { frame: string }) =>
      `Утверждение ${frame} будет снято, файл кандидата останется в папке пакета. Опору нужно создать заново кнопкой «Создать ${frame}» в блоке «Подготовка плана», затем снова утвердить; видеопромпт после этого согласуется заново.`,
    confirm: labels.reopenFrame,
    reason: messages.frameRevisionRequired,
    note: 'Что исправить в опоре',
    placeholder: 'Например: сохранить одежду героя из предыдущего плана, свет — тёплый вечерний.',
    hint: 'Обязательно. Замечание сохраняется в пакете и передаётся агенту при создании опоры.'
  },
  packageCard: {
    retry: ({ attempt }: { attempt: string | undefined }) => `повтор ${attempt}`,
    lastAnswer: ({ label, note }: { label: string | null | undefined; note?: string }) => `последний ответ: ${label ?? ''}${note ? ` («${note}»)` : ''}`,
    queued: `Запрос сохранён в очереди, генерация не запущена. Нажмите «Отправить» ниже: приложение заново проверит стоимость и покажет подтверждение перед списанием кредитов.`,
    description: labels.description,
    promptTitle: ({ approved, characters }: { approved: boolean; characters: number }) =>
      `Видеопромпт ${approved ? '· принят' : '· не принят'} · ${countLabel(characters, 'символ', 'символа', 'символов')}`,
    discard: 'Отказаться от попытки',
    delete: 'Удалить попытку',
    discardFolder: ({ relative, paid }: { relative: string; paid: boolean }) =>
      `Папка ${relative} будет удалена безвозвратно вместе с запросом, опорами и промптом${paid ? ', включая оплаченный оригинал генерации: кредиты не возвращаются' : ''}. Принятый комплект сцены и исходники не затрагиваются; после удаления снова доступны новая подготовка и «Подготовить повтор».`
  },
  packageDecision: {
    approveHint: ({ frame }: { frame: string }) =>
      `Утверждает опору ${frame}: она станет референсом следующих опор, приложение спросит о следующем готовом кандидате.`,
    reviseHint: ({ frame }: { frame: string }) =>
      `Снимает кандидата ${frame} и сохраняет замечание; опору создайте заново кнопкой «Создать ${frame}» в блоке «Подготовка плана».`,
    approve: ({ frame }: { frame: string }) => `Утвердить ${frame}`,
    revise: ({ frame }: { frame: string }) => `Доработать ${frame}`,
    frame: ({ frame }: { frame: string }) => `Опора ${frame}`,
    candidateHint: ({ frame }: { frame: string }) =>
      `Кандидат ${frame} показан в блоке «Опоры» выше (щелчок открывает его крупно). Опоры утверждаются по одной: «Утвердить ${frame}» утверждает только её, «Доработать ${frame}» снимает кандидата, а обязательное замечание получит агент при повторном создании опоры кнопкой «Создать ${frame}» в блоке «Подготовка плана».`,
    workflowHint: `Этот пакет ведёт приложение: нажатие кнопки сразу записывает ответ и выполняет действие. «Отправить» открывает подтверждение стоимости перед списанием, «Сохранить в очередь» переносит пакет в очередь, «Принять» открывает приёмку. Поле ниже нужно только для «Вернуть с замечанием»: замечание сохраняется в пакете и передаётся агенту, когда вы нажмёте «Запустить доработку с агентом» в блоке «Подготовка плана». Текст запроса здесь не редактируется.`,
    frameNote: ({ frame }: { frame: string }) => `Что исправить в опоре ${frame}`,
    note: 'Что нужно исправить',
    frameExample: 'Например: сохранить одежду героя из предыдущего плана, камера ниже, свет тёплый вечерний.',
    example: 'Например: укажите, что изменить в показанных материалах и каким должен быть результат.',
    frameNoteHint: ({ frame }: { frame: string }) =>
      `Обязательно для «Доработать ${frame}». Замечание сохранится в списке замечаний к опорам и будет передано агенту при создании ${frame}.`,
    noteHint:
      'Опишите нужные изменения. Обязательно только для «Вернуть с замечанием». Замечание сохранится вместе с ответом. Агент автоматически не запускается. После возврата нажмите «Запустить доработку с агентом» в блоке «Подготовка плана».',
    submissionUnknown: 'Исход отправки этой попытки ещё не известен: дождитесь его или разберите в блоке получения выше.',
    frameNoteRequired: ({ frame }: { frame: string }) => `Опишите в поле выше, что исправить в опоре ${frame}.`,
    noteRequired: 'Опишите в поле выше, что нужно исправить.'
  },
  packageKeyframes: {
    reopenHint: ({ id }: { id: string }) => `Снять утверждение ${id} и создать опору заново с замечанием`,
    missing: 'не создана',
    candidate: 'кандидат ждёт решения',
    pending: 'вопрос ниже: утвердить?',
    approved: 'утверждена',
    promptApproved: 'Видеопромпт уже утверждён по этим опорам: исправленную опору создайте в новой попытке («Подготовить повтор»).',
    requestPrepared: 'Запрос видео уже подготовлен по этим опорам: исправленную опору создайте в новой попытке.',
    imagePending: 'Сначала завершите отправку изображения и выберите её результат.',
    candidateLabel: ({ id, role, timeSeconds, approved }: { id: string; role: string; timeSeconds: number; approved: boolean }) =>
      `${id} · ${role} · ${timeSeconds} с · ${approved ? 'утверждена' : 'кандидат, не принят'}`,
    heading: ({
      approved,
      frames,
      requestSeconds,
      windowSeconds
    }: {
      approved: number;
      frames: number;
      requestSeconds?: number | null;
      windowSeconds?: number;
    }) => `Опоры · утверждено ${approved} из ${frames}${requestSeconds ? ` · запрос ${requestSeconds} с на окно ${windowSeconds} с` : ''}`,
    hint: `Опоры создаются и утверждаются по одной; утверждённые передаются агенту референсами следующих. Щелчок по миниатюре открывает её крупно.`,
    fileMissing: commonTexts.media.fileMissing,
    notCreated: 'ещё не создана',
    frameCaption: ({ role, timeSeconds }: { role: string; timeSeconds: number }) => `${role} · ${timeSeconds} с`,
    reopen: labels.reopenFrame,
    galleryKind: commonTexts.media.keyframe
  },
  packageRequest: {
    sendHint: 'Платная отправка из приложения',
    providerMissing: ({ providerTitle }: { providerTitle: string }) => `${providerTitle} не найден: проверьте его на странице «Среда».`,
    provider: 'Провайдер генерации',
    image: 'Запрос изображения',
    video: 'Запрос видео',
    parameter: `Параметр`,
    value: `Значение`,
    executor: `Исполнитель`,
    unspecified: 'не указан',
    frame: `Опорный кадр`,
    model: `Модель`,
    inputs: labels.inputs,
    attempt: `Попытка`,
    charged: ({ status, generationId, credits }: { status: string; generationId: string | null; credits: number | null }) =>
      `${status}${generationId ? ` · ID ${generationId}` : ''}${credits !== null ? ` · списано ${credits}` : ''}`,
    hash: `Хеш запроса (SHA-256)`,
    send: labels.send
  },
  packageResult: {
    decisionRequired: 'Сначала ответьте на вопрос пакета.',
    selectionUnavailable: 'Попытка уже не ждёт выбора варианта опоры.',
    resultUnconfirmed: 'Данные показанного результата не подтверждены: обновите страницу.',
    candidateLabel: ({ frame, variant }: { frame: string; variant: number }) => `${frame}вариант ${variant} · кандидат, не принят`,
    summaryLabel: ({ filename }: { filename: string | number }) => `Техническая сводка · ${filename}`,
    heading: `Результат`,
    galleryKind: 'Вариант опорного кадра',
    select: `Выбрать как опору`,
    selectionHint: `Выбор сохраняет оригинал кандидатом опоры. Утвердить её нужно отдельно: приложение задаст вопрос об этой опоре.`,
    summary: 'Техническая сводка',
    createSummary: `Сделать техническую сводку`,
    accept: labels.accept,
    reopen: `Вернуть вопрос о результате`
  },
  packageResume: {
    unknownDescription: ({ title, history }: { title: string; history: string }) =>
      `Исход отправки неизвестен: ${title} мог создать задание и списать кредиты, но приложение не получило ID задания, а узнать его позже нельзя. Проверьте сами: откройте ${history} и найдите генерацию с промптом этой попытки, созданную во время её отправки.`,
    recoveryDescription:
      'Нашли — скачайте оригинал и загрузите его сюда: он станет результатом попытки без новой оплаты. Не нашли — отметьте, что задание не создано, и отправьте запрос заново с новым подтверждением стоимости. Если генерация ещё в работе, дождитесь её завершения в истории.',
    providerMissing: ({ title }: { title: string }) => `Программа ${title} не найдена: проверьте её на странице «Среда».`,
    service: 'сервиса',
    imageHistory: 'Изображение из истории генераций',
    videoHistory: 'Видео из истории генераций',
    image: labels.image,
    video: 'Видео MP4',
    receivingImage: ({ frameId }: { frameId: string | undefined }) => `Получение изображения${frameId ? ` · опора ${frameId}` : ''}`,
    receivingVideo: 'Получение видео',
    history: ({ title }: { title: string }) => `историю генераций ${title}`,
    upload: `Загрузить результат вручную`,
    notCreated: labels.notCreated,
    notCreatedTitle: 'Задание не создано?',
    notCreatedConfirm: labels.notCreated,
    notCreatedDescription: ({ title }: { title: string }) =>
      `Отмечайте, только если генерации нет в истории ${title}. Попытка снова станет неотправленной, и на вопрос об отправке можно будет ответить заново: потребуется новая оценка стоимости и отдельное подтверждение.`,
    duplicateWarning: `Если задание всё-таки было создано, повторная отправка спишет кредиты ещё раз.`,
    resume: `Продолжить получение`
  },
  packageRevisionNotice: {
    frameTitle: `Опора возвращена на доработку`,
    frameDescription:
      'Замечание сохранено в списке «Замечания к опорам» ниже и будет передано агенту при создании опоры. Создайте её заново кнопкой «Создать …» в блоке «Подготовка плана». Доработка с агентом нужна, только если надо изменить само описание или промпты опор.',
    openPreparation: `Перейти к подготовке плана`,
    title: `Пакет возвращён с замечанием`,
    description:
      'Возврат с замечанием не запускает агента автоматически. Запуск и результат доработки — в блоке «Подготовка плана». Нажмите там «Запустить доработку с агентом», если ещё не запускали её.',
    openRevision: `Перейти к доработке`
  },
  packageSceneChanged: {
    sentReason: 'Попытка уже отправлялась по прежней постановке: подготовьте новый пакет.',
    blockedDescription: ({ reason }: { reason: string }) => `${reason} Пока это не решено, опоры, промпт и отправка для пакета недоступны.`,
    retain: `Оставить пакет для текущей постановки`,
    revise: `Доработать описание`,
    confirmTitle: 'Оставить пакет для текущей постановки?',
    description:
      'Описание, опоры, видеопромпт и подготовленный запрос останутся как есть и будут считаться соответствующими текущему сценарию плана. Выбирайте это, если правка сценария их не меняет: например, сокращены формулировки или исправлена опечатка. Если изменились действие, положение героев или их состояние в кадре, лучше доработать описание.',
    confirm: 'Оставить пакет'
  },
  productionFrameGenerationButton: {
    unavailable: ({ problem, choices }: { problem: string; choices: string }) => `${problem} Выберите ${choices} в настройках проекта.`,
    create: ({ frame, title }: { frame: string | null | undefined; title: string }) => `${frame ? `Создать ${frame}` : 'Создать опоры'} в ${title}`,
    prepareRequest: ({ frame, title }: { frame?: string | null; title: string }) => `Подготовить запрос изображения${frame ? ` ${frame}` : ''} (${title})`,
    alternatives: ({ preceding, last }: { preceding: string; last: string | undefined }) => `${preceding} или ${last}`,
    provider: 'провайдера',
    unsupported: ({ provider }: { provider: string }) => `Провайдер изображений «${provider}» не поддерживается.`,
    missing: 'Провайдер изображений не задан.',
    createFrames: `Создать опоры`
  },
  productionFrameImport: {
    fileRequired: 'Выберите файл хотя бы для одной опоры.',
    filesMissing: 'Файлы ещё не выбраны.',
    title: ({ id }: { id: string }) => `Изображение опоры ${id}`,
    images: commonTexts.files.images,
    heading: `Импортировать свои опоры PNG, JPG, WebP`,
    description: `Выберите файлы только для нужных опор. Каждая получит свой вопрос об утверждении; недостающие агент создаст по одной, учитывая утверждённые.`,
    choose: ({ id }: { id: string }) => `Выбрать ${id}`,
    caption: ({ role, timeSeconds, path }: { role: string; timeSeconds: number; path: string }) => `${role} · ${timeSeconds} с · ${path ?? 'Файл не выбран'}`,
    preview: `Показать кандидаты`,
    clear: `Очистить выбор`
  },
  productionProposalDialog: {
    open: `Просмотреть предложение и сравнение`,
    title: ({ stage }: { stage: string }) => `Предложение для производства · ${stage}`,
    applying: commonTexts.proposal.applying,
    close: `Закрыть без применения`
  },
  productionProposalPreview: {
    time: ({ timeSeconds }: { timeSeconds: number }) => `${timeSeconds} с от начала плана`,
    references: ({ filenames }: { filenames: string }) => `Референсы: ${filenames}`,
    candidate: ({ id }: { id: string }) => `${id} · кандидат, не принят`,
    galleryKind: 'Кандидат опоры',
    modelAndCommand: 'Модель и команда',
    requestSummary: ({ model, command, outputs }: { model: string; command: string; outputs: number }) => `${model} · ${command} · результатов: ${outputs}`,
    inputs: labels.inputs,
    noInputs: `Без входных файлов`,
    unread: 'Текущий запрос пакета не прочитан.',
    stage: ({ stage }: { stage: string | undefined }) => `Этап пакета: ${stage ?? 'не задан'}.`,
    currentState: ({ requestDir, frames, approved }: { requestDir: string | undefined; frames: number; approved: boolean | undefined }) =>
      `${requestDir ? `Подготовленный запрос: папка ${requestDir}. ` : 'Подготовленного запроса ещё нет. '}Опор в пакете: ${frames}; видеопромпт ${approved ? 'принят' : 'не принят'}.`,
    firstDescription:
      'В пакете ещё нет описания и плана опор: это первое предложение для него. После применения здесь будет текущее описание для сравнения со следующими.',
    firstPrompt: 'В пакете ещё нет видеопромпта: это первое предложение. После применения здесь будет текущий текст.',
    refused: `Агент отказался подготовить предложение. Возможно, в сценарии есть противоречия.`,
    refusalReason: 'Причина отказа',
    noProposal: `Агент не подготовил предложение`,
    agentAnswer: 'Ответ агента',
    validationReason: 'Причина проверки',
    pending: 'Предложение ещё не получено.',
    description: labels.description,
    duration: 'Длительность запроса',
    seconds: ({ requestSeconds }: { requestSeconds: number }) => `${requestSeconds} с`,
    frames: ({ frames }: { frames: number }) => `Опоры · ${frames}`,
    staleReason: 'Исходные материалы изменились: отклоните предложение и подготовьте новое.',
    invalidReason: 'Агент не подготовил годное предложение: отклоните его и запустите агента заново.',
    emptyReason: 'В предложении нет материалов для применения.',
    discard: commonTexts.proposal.discard,
    discardDescription: 'Предложение будет отклонено без применения к пакету.',
    discardConfirm: commonTexts.proposal.discardConfirm,
    apply: 'Применить предложение',
    applyDescription: 'Предложение будет записано в пакет и изменит соответствующие материалы. Принятие и платная отправка требуют отдельного согласования.',
    applyConfirm: commonTexts.apply,
    title: ({ stage }: { stage: string }) => `Предложение агента · ${stage}`,
    notice: ({ stale, message, status }: { stale: boolean; message?: string; status: string }) =>
      `${stale ? 'Исходные материалы изменились. Подготовьте новое предложение.' : (message ?? `${status}.`)} Применение сохраняет материалы для отдельного согласования; оно не принимает опоры, промпт или платную отправку.`,
    current: 'Сейчас в пакете',
    currentHint: 'Что уже сохранено и будет заменено применением',
    proposed: 'Предложение агента',
    proposedHint: 'Станет материалами пакета после применения; согласование отдельно'
  },
  productionQueue: {
    heading: ({ count }: { count: number }) => `Очередь (${count})`,
    description: `Сохранённые запросы ждут продолжения, генерация автоматически не запускается. «Открыть запрос» показывает его материалы: кнопка «Отправить» заново проверит стоимость и запросит подтверждение, «Отказаться от попытки» удалит запрос из очереди.`,
    showAll: labels.showAllShots,
    frame: ({ shot, frameId }: { shot: string; frameId?: string }) => `${shot}${frameId ? ` · опора ${frameId}` : ''}`,
    queued: 'В очереди',
    sendHint: `Кнопка «Отправить» откроет проверку стоимости и отдельное подтверждение.`,
    open: `Открыть запрос`,
    noShot: 'Без плана',
    broken: 'Повреждённая папка',
    brokenHint: ({ reason, shot }: { reason: string; shot: string }) =>
      `${reason}. Запроса в ней нет, открыть её нельзя; пока папка есть, план ${shot} не сохранить в очередь.`,
    delete: labels.deleteFolder,
    deleteDescription: ({ relative }: { relative: string }) =>
      `Папка ${relative} будет удалена безвозвратно вместе со всем содержимым. Принятый комплект сцены и исходники не затрагиваются.`,
    deleteConfirm: labels.deleteFolder
  },
  productionShotCard: {
    deleteFolder: labels.deleteFolder,
    deleteFolderDescription: ({ relative }: { relative: string }) =>
      `Папка ${relative} будет удалена безвозвратно вместе со всем содержимым. Принятый комплект сцены и исходники не затрагиваются.`,
    openPackage: 'Открыть пакет',
    retryHint: 'Создать новую попытку по сохранённому запросу без отправки и оплаты',
    submissionUnknown: 'Исход отправки попытки этого плана ещё не известен: сначала выясните его в карточке пакета.',
    title: ({ title, start, end, seconds, lipsync }: { title: string; start: string; end: string; seconds: string; lipsync: boolean }) =>
      `${title} · ${start}–${end} · ${seconds} с${lipsync ? ' · липсинк' : ''}`,
    stale:
      'Постановка плана изменилась после приёмки: комплект в assets принят по прежней постановке. Подготовьте новое производство в блоке «Подготовка плана» и примите новый результат.',
    brokenHint: ({ relative, reason }: { relative: string; reason: string }) =>
      `Папка ${relative}: ${reason}. Пока она есть, «Сохранить в очередь» для этого плана не сработает.`,
    pending: ({ relative, question }: { relative: string; question: string }) => `Пакет ${relative} ждёт вашего решения: ${question}`,
    accepted: `Принятые материалы`,
    missingVideo: `Файл принятого монтажного видео отсутствует. Приёмка сохранена; восстановите файл перед сборкой с этим видео.`,
    retry: labels.prepareRetry
  },
  productionShotList: {
    showAll: labels.showAllShots,
    derivedFrom: ({ derivedFrom }: { derivedFrom: string }) => `из ${derivedFrom}`,
    derivedHint: ({ derivedFrom }: { derivedFrom: string }) => `План собирается из материала ${derivedFrom}`,
    proposal: 'предложение агента',
    invalidProposal: 'предложение: отклоните',
    missingVideo: commonTexts.media.videoMissing,
    attention: ({ attention }: { attention: string }) => `ждёт вас: ${attention}`,
    attentionLabel: 'Ждёт вашего действия'
  },
  productionSpeechPanel: {
    seconds: (value: number) => `${value.toFixed(2).replace('.', ',')} с`,
    invalidRange: 'Укажите начало и конец среза в секундах; конец позже начала.',
    unsupported: 'Провайдер видео проекта не синхронизирует губы с заданным звуком.',
    duration: ({ min, max }: { min: number; max: number }) => `Провайдер видео принимает звук длиной от ${min} до ${max} с.`,
    sent: 'Запрос этой попытки уже отправлен: её WAV менять нельзя.',
    prepared: ({ shot, seconds }: { shot: string; seconds: string }) => `WAV речи ${shot} подготовлен: ${seconds}.`,
    heading: navigationTexts.blocks.productionLipSync,
    description: `Губы синхронизируются с точным фрагментом песни. Срез берётся из исходного трека без обработки и начинается с начала окна плана, поэтому в монтаже губы совпадут с песней. Он уходит в запрос звуковым входом и сохраняется в комплекте при приёмке. Прослушайте срез перед подготовкой запроса.`,
    window: ({ start, end }: { start: string; end: string }) => `Окно плана: ${start}–${end}`,
    emptyLine: 'строка без текста',
    noTiming: `В окне плана нет строк разметки: задайте границы среза вручную.`,
    ready: ({ start, end, seconds }: { start: string; end: string; seconds: string }) => `Подготовлен срез ${start}–${end} (${seconds}).`,
    cutStart: labels.startSeconds,
    cutEnd: labels.endSeconds,
    recut: 'Обрезать заново',
    prepare: 'Подготовить WAV',
    timing: `Границы по разметке`
  },
  productionToolbar: {
    heading: navigationTexts.pages.production,
    accepted: ({ completed, total }: { completed: number; total: number }) => `принято ${completed} из ${total}`,
    attention: ({ attention }: { attention: number }) => `ждут вас: ${attention}`,
    attentionHint: 'Планы, у которых пакет ждёт вашего действия; щелчок показывает их',
    stale: ({ stale }: { stale: number }) => `постановка изменена: ${stale}`,
    staleHint: 'Планы, принятые по прежней постановке: им нужно новое производство; щелчок показывает их',
    show: 'Показать',
    refresh: commonTexts.refresh
  },
  productionWorkflowPanel: {
    noteReason: 'Опишите в поле выше, что агенту нужно исправить.',
    loadingReason: 'Дождитесь загрузки состояния плана.',
    prepareHint: 'Начинает новый пакет с описания плана',
    continueHint: 'Готовит следующий этап: видеопромпт, затем запрос',
    noteRequired: 'Напишите, что агенту нужно исправить.',
    title: ({ shot }: { shot: string }) => `Подготовка плана ${shot}`,
    package: ({ packageDir }: { packageDir: string }) => `Выбран пакет: ${packageDir}`,
    newPreparation: 'Новая подготовка: папка пакета появится после применения описания.',
    sent: 'Запрос этой попытки уже отправлен: решения о результате принимаются в карточке пакета ниже. Возврат с замечанием создаст новый пакет для доработки.',
    description: 'Описание, опоры, видеопромпт и запрос согласуются по отдельности. Платная отправка провайдеру подтверждается отдельно.',
    revisionHint: ({ savedNote }: { savedNote: string }) =>
      `${savedNote ? 'Замечание из возврата подставлено ниже. ' : ''}Агент автоматически не запускается. Проверьте замечание и нажмите «Запустить доработку с агентом». После завершения появится предложение для просмотра и отдельного применения.`,
    savedNote: 'Сохранённое замечание для доработки',
    note: 'Что исправить в текущем этапе',
    noteHint: 'Можно уточнить текст перед запуском. Генерация изображения или видео согласуется отдельно.',
    revise: `Запустить доработку с агентом`,
    descriptionRequired: messages.descriptionAndFramePlanRequired,
    prepare: `Подготовить описание`,
    continue: `Продолжить подготовку`,
    frameHint: ({ nextFrame }: { nextFrame: string }) =>
      `Создаёт кандидата опоры ${nextFrame} по принятому описанию; утверждённые опоры и действующие замечания передаются в задание`,
    createHint: 'Создаёт кандидата следующей опоры по принятому описанию'
  },
  regenerateDialog: {
    title: ({ shot }: { shot: string }) => `Подготовить повтор ${shot}`,
    confirm: labels.prepareRetry,
    description: `Будет взят сохранённый запрос плана и создана новая попытка. Запрос не отправляется, кредиты не списываются. Перед платной отправкой приложение покажет новую таблицу параметров, входы и SHA256 запроса для отдельного подтверждения.`
  },
  requestModelSelection: {
    replaced: ({ preferredModel, selectedModel, reason }: { preferredModel: string | null; selectedModel: string; reason: string }) =>
      `Предпочтительная модель ${preferredModel} заменена на ${selectedModel}. ${reason}`,
    selected: ({ selectedModel, reason }: { selectedModel: string; reason: string }) => `Выбрана модель ${selectedModel}. ${reason}`
  },
  requestParameters: {
    heading: `Параметры запроса`,
    empty: `Дополнительные параметры не заданы.`
  },
  requestPrompt: {
    heading: `Промпт запроса`
  },
  sendRequestDialog: {
    consentGiven: 'Согласие на этот запрос уже дано.',
    service: 'сервисе',
    sending: 'Запрос уже отправляется.',
    quotePending: 'Дождитесь проверки стоимости.',
    quoteRequired: 'Стоимость не проверена: нажмите «Обновить стоимость».',
    insufficient: commonTexts.generation.insufficientCredits,
    unknownBalance: 'Стоимость неизвестна: нажмите «Я согласен», чтобы разрешить один запрос.',
    balanceUnconfirmed: 'Остаток кредитов не подтверждён: обновите стоимость.',
    hashMissing: 'У запроса нет хеша: подготовьте запрос заново.',
    quoteMismatch: 'Стоимость проверена для другой версии запроса: обновите стоимость.',
    title: commonTexts.generation.confirmPrompt,
    sendPending: 'Дождитесь окончания отправки запроса.',
    confirm: 'Отправить и списать кредиты',
    description: `Проверьте промпт и материалы перед отправкой платного запроса. Подтверждение разрешает одну попытку генерации.`,
    requestSummary: ({
      shot,
      image,
      frameId,
      provider,
      command,
      model
    }: {
      shot: string;
      image: string | boolean | undefined;
      frameId: string | undefined;
      provider: string | undefined;
      command: string | undefined;
      model: string;
    }) => `План ${shot}${image ? `, опора ${frameId}` : ''}, провайдер ${provider ?? 'не указан'}${command ? `, команда ${command}` : ''}, модель ${model}.`,
    paymentDescription: ({ providerTitle }: { providerTitle: string }) =>
      `Это платная операция: будут списаны кредиты аккаунта ${providerTitle}. Запрос отправляется ровно один раз, затем приложение ждёт результат и запишет его в пакет.`,
    checking: ({ providerTitle }: { providerTitle: string }) => `Проверяем стоимость запроса и остаток кредитов в ${providerTitle}.`,
    agreed: `Вы согласились отправить этот запрос с неизвестной стоимостью.`,
    agree: `Я согласен`,
    refresh: `Обновить стоимость`,
    sendError: ({ sendError }: { sendError: string }) =>
      `${sendError} Закройте диалог для проверки состояния пакета или обновите стоимость для нового подтверждения.`,
    hash: ({ sha256 }: { sha256: string | null }) => `Хеш запроса (SHA-256): ${sha256 ?? ''}`
  },
  input: {
    keyframeSlot: 'Ключевой кадр',
    input: 'Входной материал',
    sceneChanged:
      'Постановка или унаследованное состояние плана изменились после подготовки пакета: описание, опоры и промпт могут не соответствовать сценарию.'
  },
  workflow: {
    derived: ({ source }: { source: string }) => `План собирается из материала ${source}: описание, опоры и генерация для него не нужны.`,
    stale: 'предложение агента устарело: отклоните его или подготовьте заново',
    ready: 'предложение агента ждёт применения или отклонения',
    invalid: 'ответ агента не прошёл проверку: просмотрите и отклоните',
    failed: 'задание агента завершилось ошибкой: просмотрите и отклоните'
  }
} as const;
