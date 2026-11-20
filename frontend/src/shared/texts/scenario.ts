import { commonTexts } from './common';
import { countLabel } from '../plural';
import type { ScenarioCheckGroup, ScenarioCheckSeverity, ScenarioInput } from '../scenario-workflow';

/** Подпись поля длины плана части сценария: на неё ссылаются и советы при отказе пересчёта границ. */
const maxShotLabel = 'Макс. план, с';

/** Кнопки утверждения пары и сценария: на них ссылается и предупреждение о пересмотре сценария. */
const approveScenesLabel = 'Утвердить текущий сценарий';
const approveTreatmentLabel = 'Утвердить текущие кастинг и части';

/** Входы утверждения в предупреждении о пересмотре сценария. */
const scenarioInputLabels: Record<ScenarioInput, string> = {
  sources: 'исходники',
  timing: 'разметка песни',
  cast: 'кастинг',
  treatment: 'части сценария'
};

/** Тексты сценария; правила владения описаны в @link ../../../docs/ui/texts.md. */
export const scenarioTexts = {
  // Готовые сообщения Go в Error.message; порядок проверок задаёт Go.
  main: {
    damagedDocument: ({ label }: { label: string }) => `${label} повреждён.`,
    damagedCast: commonTexts.project.castDamaged,
    referencesRefresh: 'Карта референсов сценария расходится с кастингом; при сохранении она будет обновлена.',
    treatmentRequiresParts: 'Сценарий: нужна хотя бы одна часть песни.',
    partCodeLatin: ({ title }: { title: string }) => `Часть «${title}»: код латиницей.`,
    duplicatePartCode: ({ id }: { id: string }) => `Код части повторяется: ${id}.`,
    partTitleMissing: ({ id }: { id: string }) => `Часть ${id}: нет названия.`,
    partStartMismatch: ({ id, start, previousEnd }: { id: string; start: number; previousEnd: string }) =>
      `Часть ${id}: начало ${start} не стыкуется с ${previousEnd}.`,
    partEndsBeforeStart: ({ id }: { id: string }) => `Часть ${id}: конец раньше начала.`,
    treatmentDurationMismatch: ({ end, duration }: { end: string; duration: string }) => `Части заканчиваются на ${end}, а трек длится ${duration}.`,
    treatmentInvalidDocument: 'Сценарий: нужны schema_version 1, логлайн и список частей.',
    treatmentInvalidPart: 'Сценарий: неверная структура части песни.',
    registryRequiresScenes: ({ fps }: { fps: number }) => `Сценарий: нужны schema_version 1, fps ${fps} и список планов.`,
    shotCodeInvalid: ({ shot }: { shot: string }) => `${shot}: код плана вида M01 или M23.5.`,
    duplicateShotCode: ({ shot }: { shot: string }) => `${shot}: код повторяется.`,
    shotFramesInteger: ({ shot }: { shot: string }) => `${shot}: границы в кадрах должны быть целыми.`,
    shotStartMismatch: ({ shot, start, previousEnd }: { shot: string; start: number; previousEnd: number }) =>
      `${shot}: начало ${start} не совпадает с концом предыдущего плана ${previousEnd}.`,
    shotEndsBeforeStart: ({ shot }: { shot: string }) => `${shot}: конец раньше начала.`,
    shotUnknownPart: ({ shot, part }: { shot: string; part: string }) => `${shot}: неизвестная часть ${part}.`,
    shotCameraMissing: ({ shot }: { shot: string }) => `${shot}: не заполнена камера.`,
    shotActionMissing: ({ shot }: { shot: string }) => `${shot}: не заполнено действие.`,
    shotUnknownReference: ({ shot, reference }: { shot: string; reference: string }) => `${shot}: неизвестный референс ${reference}.`,
    shotPrimaryReferenceMissing: ({ shot }: { shot: string }) => `${shot}: главный референс карточки не объявлен.`,
    registryDurationMismatch: ({ end, duration }: { end: string; duration: string | undefined }) =>
      `Монтажный конец ${end} с расходится с концом песни ${duration}.`,
    derivedInvalidShape: ({ shot }: { shot: string }) => `${shot}: derived_from должен быть объектом {"shot": "Mxx"}.`,
    derivedSelfReference: ({ shot }: { shot: string }) => `${shot}: derived_from не может ссылаться на сам план.`,
    derivedUnknownSource: ({ shot, source }: { shot: string; source: string }) => `${shot}: derived_from ссылается на неизвестный план ${source}.`,
    derivedChainedSource: ({ shot, source }: { shot: string; source: string }) =>
      `${shot}: источник ${source} сам собирается из другого плана; укажите исходный план.`,
    stateChangesInvalid: ({ shot }: { shot: string }) => `${shot}: изменения состояния должны быть объектом.`,
    stateEntityInvalid: ({ shot, entity }: { shot: string; entity: string }) => `${shot}: неверный объект состояния ${entity}.`,
    statePropertyInvalid: ({ shot, entity, property }: { shot: string; entity: string; property: string }) =>
      `${shot}: неверное свойство состояния ${entity}.${property}.`,
    stateCycle: ({ chain }: { chain: string }) => `Цикл state_from: ${chain}`,
    stateUnknownSource: ({ shot }: { shot: string }) => `${shot}: неизвестный источник state_from.`,
    stateInvalidPhase: ({ shot }: { shot: string }) => `${shot}: неверная фаза state_from.`,
    stateSameHasChanges: ({ shot }: { shot: string }) => `${shot}: повтор same не допускает своих state_changes.`,
    briefShotMissing: ({ shot }: { shot: string }) => `${shot}: плана нет в сценарии.`,
    invalidRelativePath: ({ path }: { path: string }) => `Недопустимый относительный путь сценария: ${path}`,
    ordinaryPathRequired: ({ name, directory }: { name: string; directory: boolean }) =>
      `${name}: для применения сценария нужен обычный ${directory ? 'каталог' : 'файл'}, без ссылки.`,
    staleFile: ({ path }: { path: string }) => `Предложение устарело: изменился ${path}. Подготовьте новое предложение.`,
    stagingDirectoryRequired: ({ path }: { path: string }) => `${path}: staging требует обычную папку без ссылки.`,
    stagingSymlink: ({ path }: { path: string }) => `${path}: staging не копирует символические ссылки.`,
    acceptedVideoPathRequired: ({ path }: { path: string }) => `${path}: не задан относительный путь принятого видео.`,
    acceptedVideoMissing: ({ path }: { path: string }) => `Нет принятого видео: ${path}`,
    cardsDirectoryRequired: 'plan/animatic/cards: нужна обычная папка.',
    shotsDirectoryRequired: 'assets/shots: нужна обычная папка.',
    recoveryProjectUnavailable: ({ project }: { project: string }) =>
      `Проект недоступен по прежнему пути или отсутствует plan/project.json: ${project}. Восстановите доступ к папке проекта; резервные копии сохранены.`,
    recoveryPending: 'Не завершено восстановление прошлого применения сценария. Перезапустите приложение.',
    unsupportedApplicationFile: ({ path }: { path: string }) => `Неподдерживаемый файл применения: ${path}`,
    recoveryIncomplete: ({ error, restoreError }: { error: string; restoreError: string }) =>
      `Применение сценария прервано: ${error}. Восстановление не завершено: ${restoreError}. Резервы сохранены для следующего запуска.`,
    snapshotMissing: 'Нет исходного снимка файлов сценарного предложения. Повторите подготовку.',
    staleAddedFile: ({ path }: { path: string }) => `Предложение устарело: появился производный файл ${path}. Подготовьте новое предложение.`,
    applyPairRequired: 'Для применения нужны кастинг и части.',
    proposedRegistryMissing: 'Нет предложенного сценария.',
    staleStagingFile: ({ path }: { path: string }) => `Предложение устарело: изменился ${path} при подготовке проверки.`,
    validationFailed: ({ name, details }: { name: string; details: string }) => `Не пройдена проверка ${name}: ${details}`,
    validationExitCode: ({ code }: { code: number | null }) => `код ${code}`,
    staleMaterials: 'Предложение устарело: изменился состав материалов или производных файлов проекта. Подготовьте новое предложение.',
    recoveryFormatInvalid: 'Неизвестный формат pending или недопустимые пути восстановления.',
    recoveryFailed: ({ failures }: { failures: string }) => `Не удалось восстановить применение сценария; резервы сохранены. ${failures}`,
    registryInvalidDocument: 'Сценарий: неверная структура документа.',
    registryInvalidReferences: 'Сценарий: неверная карта референсов.',
    registryInvalidParts: 'Сценарий: неверные части песни.',
    registryInvalidShot: ({ id }: { id: string | null }) => `Сценарий${id !== null ? `, ${id}` : ''}: неверная структура плана.`,
    registryInvalidStateFrom: ({ id }: { id: unknown }) => `Сценарий, ${id}: неверный state_from.`,
    registryInvalidStatePhases: ({ id, phases }: { id: unknown; phases: string[] | null }) =>
      `Сценарий, ${id}: в state_changes допустимы только фазы before и after${phases === null ? '' : `, получено: ${phases.join(', ')}`}. Коды сущностей вкладываются в фазы.`,
    registryInvalidStateChanges: ({ id }: { id: unknown }) => `Сценарий, ${id}: изменения состояния должны быть объектом.`,
    registryInvalidStateProperties: ({ id }: { id: unknown }) => `Сценарий, ${id}: неверные свойства состояния.`,
    treatmentLoglineMissing: 'Сценарий: заполните логлайн.',
    partDirectionMissing: ({ id }: { id: string }) => `Часть ${id}: заполните постановку.`,
    partUnknownEntity: ({ part, entity }: { part: string; entity: string }) => `Часть ${part}: неизвестная сущность ${entity}.`,
    registryDecodedDurationMismatch: 'Конец сценария расходится с длительностью декодированного звука.',
    registryReferencesMismatch: 'Карта референсов должна соответствовать кастингу.',
    registryDirectionMissing: 'Заполните общую визуальную постановку.',
    stateUnknownEntity: ({ shot, entity }: { shot: string; entity: string }) => `${shot}: неизвестная сущность состояния ${entity}.`,
    stateUnknownProperty: ({ shot, entity, property }: { shot: string; entity: string; property: string }) =>
      `${shot}: неизвестное свойство ${entity}.${property}.`,
    unfilledShots: ({ count, ids }: { count: number; ids: string[] }) =>
      `Осталась незаполненная постановка: ${countLabel(count, 'план', 'плана', 'планов')} (${ids.slice(0, 6).join(', ')}${count > 6 ? ' и другие' : ''}).`,
    proposalInvalidDocument: 'Нужен один JSON-документ с schemaVersion 1 и ожидаемым pass.',
    proposalUnknownFields: 'В ответе есть поля вне контракта предложения.',
    proposalCastMissing: 'Нет кастинга для проверки сценария.',
    proposalScaffoldChanged: 'Ответ изменил исходный каркас сценария.',
    proposalShotWindowChanged: ({ shot }: { shot: string }) => `${shot}: нельзя менять ID, текст и кадровые окна каркаса.`,
    proposalPatchesMissing: 'Нужен непустой список patches выбранных планов.',
    proposalPatchesInvalid: 'patches может менять только постановку выбранных неповторяющихся ID.',
    impactNewShot: 'новый план в сценарии',
    impactStagingChanged: 'изменена постановка плана',
    impactViewpointOnly: 'изменена только точка съёмки',
    impactBoundsChanged: 'сдвинуты границы плана',
    impactInheritedState: ({ source }: { source: string }) => `изменилось состояние, унаследованное от ${source}`,
    impactStateLink: ({ source }: { source: string }) => `ссылка на состояние перешла к ${source}, само состояние то же`,
    impactInitialState: 'изменилось начальное состояние',
    impactGlobalRules: 'изменены общие правила или направление части',
    impactDerivedSource: ({ source }: { source: string }) => `собирается из материала ${source}`,
    invalidSaveMode: 'Неизвестный режим сохранения сценария.',
    snapshotInvalidDocuments: 'Неверный снимок документов.',
    workflowInvalidState: 'Неверная запись утверждения сценария plan/scenario-workflow.json.',
    workflowInvalidProposal: 'Неверная запись предложения.',
    workflowInvalidProposalMetadata: 'Неверные метаданные предложения.',
    sourcePathUnreadable: 'Не удалось прочитать путь исходного файла. Загрузите его заново на странице «Исходники».',
    sourceOutsideProject: 'Исходный файл находится вне папки исходников проекта. Загрузите его заново на странице «Исходники».',
    projectSettingsUnreadable: 'Не удалось прочитать настройки проекта. Выберите папку проекта заново.',
    sourcesMissing: 'Сведения об исходниках отсутствуют или повреждены. Загрузите трек, текст песни и идею на странице «Исходники».',
    scenarioSourcesRequired: 'Для сценария нужны трек, текст песни и идея. Загрузите недостающие файлы на странице «Исходники».',
    sourceFileChanged: ({ path }: { path: string }) => `${path}: файл отсутствует или изменён после загрузки исходников.`,
    sourceReferenceInvalid: 'Сведения об исходном референсе повреждены. Загрузите его заново на странице «Исходники».',
    sourceImageInvalid: 'Сведения об исходном изображении повреждены. Загрузите его заново на странице «Исходники».',
    sourceImageChanged: ({ path }: { path: string }) => `${path}: изображение отсутствует или изменено после загрузки.`,
    scenarioTimingRequired: 'Для сценария нужна разметка строк и длительность трека. На странице «Тайминги» разметьте трек и сохраните результат.',
    timingTrackMismatch: 'Разметка относится к другому треку.',
    timingUnverified: 'Подтвердите на слух все строки разметки.',
    timingIncomplete: 'Разметка должна покрывать все строки песни.',
    castImageMissing: ({ name, path }: { name: string; path: string }) => `${name}: отсутствует ${path}.`,
    proposalInterrupted: commonTexts.proposal.interrupted,
    proposalCancelled: commonTexts.proposal.cancelled,
    proposalAgentFailed: 'Агент завершил задание без успешного результата.',
    proposalImageMissing: ({ name, image }: { name: string; image: string }) => `${name}: отсутствует изображение source/${image}.`,
    proposalImageOutsideContext: ({ name }: { name: string }) =>
      `${name}: изображение не входило в исходный контекст. Загрузите его в исходники и повторите запрос.`,
    castWithoutReferences: ({ names }: { names: string }) =>
      `Без референса в кастинге: ${names}. Агент описывает их в опорах только текстом; если нужна узнаваемость, добавьте изображение на странице «Исходники» и обновите кастинг.`,
    workflowInvalidStart: 'Неверные параметры сценарного прохода.',
    workflowStartBlocked: 'Сначала утвердите актуальные кастинг и части; дождитесь завершения текущего задания.',
    workflowReviseSelection: 'Для доработки выберите существующий план и заполните замечание.',
    toolsMissing: 'Комплекс не найден. Выберите его папку заново.',
    inputsChanged: 'Входные файлы изменились при подготовке задания. Повторите запуск.',
    proposalNotApplicable: 'Применимо только завершённое актуальное предложение. Подготовьте новый запрос.',
    pairApprovalStale: 'Утверждение кастинга и частей устарело.',
    agentResultMissing: 'Нет успешно завершённого результата агента.',
    staleProjectFiles: 'Предложение устарело: изменились файлы проекта.',
    pairApprovalUnavailable: 'Нет корректной неутверждённой пары кастинга и частей.',
    scenesApprovalUnavailable: 'Сначала утвердите актуальную пару и заполните весь сценарий.',
    proposalMissing: 'Предложение больше не найдено.'
  },
  page: {
    castMissing: 'Сначала создайте кастинг: без сущностей нет референсов для планов и состояния героев.',
    proposalEditingPaused: 'Предложение агента ждёт решения. Редактирование приостановлено, пока вы не примените или не отклоните его.',
    agentEditingPaused: 'Агент работает с сохранёнными данными. Редактирование приостановлено до завершения или остановки задания.',
    registryMissing: 'Сценария пока нет.',
    noShots: 'Планов пока нет. Заполните и сохраните части, утвердите кастинг и части, затем нажмите «Создать сценарий»: агент разобьёт части на планы.'
  },
  brief: {
    planSource: ({ shot, phase }: { shot: string; phase: 'before' | 'after' }) => `${shot} · ${phase === 'before' ? 'первый кадр' : 'итог'}`,
    agentText: 'Текст для агента',
    agentTextHint: 'Эти абзацы идут в промпт опор дословно; копировать их не нужно.',
    checklist: 'Что сверить в опорах и результате',
    firstFrameMarker: ' · первый кадр',
    lastFrameMarker: ' · последний кадр',
    unsetMark: '—',
    firstShotFrame: ({ shot }: { shot: string }) => `Первый кадр ${shot}`,
    lastShotFrame: ({ shot }: { shot: string }) => `Последний кадр ${shot}`,
    entityChanges: ({ changes, hidden }: { changes: number; hidden: number }) =>
      `${changes ? `изменений: ${changes}` : 'без изменений за план'}${hidden ? ` · скрыто без изменений: ${countLabel(hidden, 'свойство', 'свойства', 'свойств')}` : ''}`,
    propertyCode: ({ key }: { key: string }) => `Код свойства: ${key}`,
    beforeBlockQuoted: '«Первый кадр (before)»',
    afterBlockQuoted: '«Итог плана (after)»',
    openCastState: ({ name }: { name: string }) => `Открыть начальное состояние «${name}» на странице «Кастинг»`,
    scrollCurrentState: ({ block }: { block: string }) => `Прокрутить к блоку «Состояние героев и мира» этого плана: значение задано в ${block}`,
    openShotState: ({ shot, block }: { shot: string; block: string }) =>
      `Открыть план ${shot} и его блок «Состояние героев и мира»: значение задано в ${block}`,
    empty: 'пусто',
    unspecified: 'не задано',
    title: 'Врезка непрерывности',
    changes: ({ count }: { count: number }) => `Изменений за план: ${count}`,
    noChanges: 'Без изменений за план',
    onlyChanges: 'Только изменения за план',
    description:
      'Складывается из начального состояния сущностей в кастинге и изменений «Первый кадр (before)» и «Итог плана (after)» в блоке «Состояние героев и мира» этого и предыдущих планов. Агенту для опор и видеопромпта приложение само передаёт сущности этого плана: мир, «В кадре (референсы)» и тех, чьё состояние план меняет. Чтобы исправить или сократить значение, нажмите его источник.',
    stateMissing: 'Состояние не задано: в кастинге нет начального состояния, а в планах нет изменений.',
    outsidePlan: ({ count }: { count: number }) => `Вне плана: ${countLabel(count, 'сущность', 'сущности', 'сущностей')}`,
    outsidePlanHint: 'Их нет в кадре этого плана, и план их не меняет: во врезку для агента и в вопросы сверки они не входят.',
    availableAfterValidation: 'Врезка появится, когда сценарий пройдёт проверку.'
  },
  fields: {
    property: 'Свойство',
    kind: commonTexts.type,
    name: commonTexts.fields.name,
    shortName: commonTexts.fields.shortName,
    title: commonTexts.title,
    lyric: 'Строка песни',
    part: 'Часть',
    firstFrame: commonTexts.media.firstFrame,
    endExclusive: 'Конец (не включая)',
    camera: 'Камера',
    action: commonTexts.fields.action,
    continuity: 'Непрерывность',
    references: commonTexts.fields.references,
    lipsync: commonTexts.fields.lipSync,
    card: commonTexts.media.card,
    stateFrom: 'Наследование состояния',
    stateChanges: 'Изменения состояния',
    derivedFrom: 'Собирается из плана',
    notes: 'Примечания',
    registry: 'Планы',
    visualRules: 'Визуальные правила',
    parts: 'Части',
    audio: commonTexts.media.audio,
    fps: 'Частота кадров',
    startSeconds: commonTexts.fields.startSeconds,
    endSeconds: commonTexts.fields.endSeconds,
    entities: commonTexts.fields.entities,
    maxShotSeconds: commonTexts.fields.maxShotSeconds,
    treatment: 'Части сценария',
    logline: 'Логлайн',
    aboutClip: 'О чём клип',
    globalVisualRules: 'Общие визуальные правила',
    code: commonTexts.code,
    partDirection: 'Направление части',
    maxShotShortSeconds: maxShotLabel
  },
  comparison: {
    changed: 'изменено',
    added: 'добавлено',
    removed: 'снято',
    noEntities: 'Сущностей нет.',
    imagesMissing: ({ name }: { name: string }) => `${name}: изображения отсутствуют. Референс ещё нужно подготовить.`,
    entityTitle: ({ id, added, removed }: { id: string; added: boolean; removed: boolean }) =>
      `${id}${added ? ' · новая сущность' : removed ? ' · удаление' : ''}`,
    propertiesTitle: commonTexts.stateProperty.dictionaryTitle,
    propertiesByKind: 'Свойства по типам',
    changedField: ({ label }: { label: string }) => `изменено: ${label}`,
    changedFields: ({ count }: { count: number }) => `изменено полей: ${count}`,
    unchanged: 'без изменений',
    field: 'Поле',
    current: 'Сейчас в проекте',
    proposal: 'Предложение',
    continuity: 'Влияние на наследуемые состояния',
    continuityFailed: 'Не удалось рассчитать сравнение состояний соседей. Проверьте непрерывность перед применением.',
    continuityPending: 'Проверяем состояния остальных планов…',
    stateBefore: ({ shot }: { shot: string }) => `Состояние перед ${shot}`,
    entityState: 'Состояние сущностей',
    continuityUnchanged: 'Наследуемые состояния остальных планов не изменились.',
    allowedTargets: ({ ids }: { ids: string[] }) =>
      `Разрешённые цели: ${ids.join(', ')}. Изменения состояния могут влиять на наследуемое состояние следующих планов; проверьте непрерывность ниже и в редакторе перед дальнейшим производством.`,
    globalRules: 'Общие правила и шкала',
    shotTitle: ({ id, changed }: { id: string; changed: boolean }) => `План ${id}${changed ? ' · изменён' : ''}`,
    partTitle: ({ id, added, removed }: { id: string; added: boolean; removed: boolean }) => `Часть ${id}${added ? ' · новая' : removed ? ' · удаление' : ''}`
  },
  delta: {
    empty: 'Изменений пока нет. Состояние наследуется.',
    partialChanges: ({ changing, total }: { changing: number; total: number }) => `изменений: ${changing} из ${total}`,
    changes: ({ count }: { count: number }) => `изменений: ${count}`,
    changeSummary: ({ total, changing, same }: { total: number; changing: number; same: number }) =>
      `Задано свойств в этом блоке: ${total}; отличаются от унаследованного: ${changing}.${same ? ` Совпадают с унаследованным и ничего не меняют: ${same} — их можно убрать.` : ''}`,
    removeEntity: ({ name }: { name: string }) => `Удалить изменения сущности «${name}»`,
    removeDescription: 'Все изменения этой сущности в данном блоке будут удалены. Состояние снова будет наследоваться.',
    removeChanges: 'Удалить изменения',
    entity: 'Сущность для изменения',
    allAdded: 'Все сущности уже добавлены',
    noEntities: 'В кастинге пока нет сущностей',
    selectEntity: 'Сначала выберите сущность для изменения.',
    allAddedReason: 'Все сущности уже добавлены.',
    noEntitiesReason: 'В кастинге пока нет сущностей.',
    addEntity: 'Добавить сущность'
  },
  drafts: {
    returnToEditor: 'Вернуться к редактору',
    waitSaving: 'Дождитесь сохранения правок.',
    saveAndContinue: 'Сохранить и продолжить',
    discardAndContinue: 'Отменить правки и продолжить',
    changed: 'Изменён сценарий: части или планы.',
    resolveBeforeAgent: 'Сначала сохраните правки или явно отмените их. Агент получает только сохранённые данные проекта.',
    applyNeedsSaved:
      'Предложение подготовлено по сохранённым документам: после записи правок оно устареет и не применится. Отмените правки, чтобы применить его, или вернитесь к редактору.'
  },
  proposal: {
    castAndTreatment: 'Кастинг и части',
    revision: 'Доработка плана',
    scenarioTitle: ({ pass }: { pass: string }) => 'Предложение для сценария · ' + pass,
    agentTitle: ({ pass }: { pass: string }) => 'Предложение агента · ' + pass,
    applying: commonTexts.proposal.applying,
    notApplied: 'Предложение ещё не записано в проект. Изменённые поля выделены фоном.',
    sourcesChanged: 'Исходные файлы изменились. Предложение устарело: запустите новый проход.',
    changedShots: ({ ids }: { ids: string[] }) => `Изменённые планы: ${ids.join(', ') || 'нет'}`,
    close: 'Закрыть без применения',
    discard: commonTexts.proposal.discard,
    discardDescription: 'Предложение будет отклонено без записи в проект.',
    discardConfirm: commonTexts.proposal.discardConfirm,
    applyTreatment: 'Применить и утвердить кастинг и части',
    applyScenes: 'Применить сценарий',
    applyDescription: 'Предложение будет записано в проект и заменит соответствующие сохранённые данные.',
    staleReason: 'Предложение устарело: запустите новый проход.',
    notReady: 'Предложение ещё не готово к применению.'
  },
  revise: {
    title: 'Доработать выбранный план',
    context: ({ ids }: { ids: string[] }) => `Планы: ${ids.join(', ') || 'не выбраны'}. Соседние планы используются как контекст; их постановка не меняется.`,
    note: 'Что нужно изменить',
    selectShot: 'Сначала выберите план для доработки.',
    explainChanges: 'Опишите, что нужно изменить.',
    prepare: 'Подготовить доработку'
  },
  /** Принятые в производстве планы: их постановка закрыта для правки, проходы агента предупреждают о последствиях. */
  accepted: {
    lockedTitle: ({ shot }: { shot: string }) => `План ${shot} принят`,
    lockedHint:
      'Видео плана принято по этой постановке, поэтому правка закрыта: любое изменение потребует снимать план заново. Если постановку всё же нужно изменить, используйте «Доработать выбранный план» — приложение предупредит о последствиях.',
    boundaryReason: ({ shot }: { shot: string }) => `Граница сдвигает начало принятого плана ${shot}.`,
    mergeReason: ({ shot }: { shot: string }) => `Следующий план ${shot} принят: объединение изменит его постановку.`,
    confirmTitle: 'Принятые планы могут измениться',
    confirm: 'Продолжить',
    treatment: ({ shots }: { shots: string[] }) =>
      `Принято в производстве: ${shots.join(', ')}. Новые части потребуют новых планов. Если он изменит постановку этих планов, они получат отметку «Постановка изменена» и их придётся снимать заново.`,
    scenes: ({ shots }: { shots: string[] }) =>
      `Принято в производстве: ${shots.join(', ')}. Если новый сценарий изменит постановку этих планов, они получат отметку «Постановка изменена» и их придётся снимать заново.`,
    revise: ({ shots }: { shots: string[] }) =>
      `Среди выбранных планов приняты в производстве: ${shots.join(', ')}. Доработка изменит их постановку: они получат отметку «Постановка изменена», и их придётся снимать заново.`,
    kept: 'Файлы меняются только после применения предложения. Принятые видео сохраняются и остаются в монтаже, пока планы не сняты заново.'
  },
  toolbar: {
    fixRegistry: ({ count }: { count: number }) => `Исправьте проблемы сценария: ${count}.`,
    noChanges: commonTexts.noChangesToSave,
    problems: ({ count }: { count: number }) => `Проблем: ${count}`,
    replaceParts: 'Заменить части сценария по разметке',
    replacePartsDescription:
      'Текущие части сценария будут заменены частями из разметки. Их описания, участники и настройки будут потеряны. Логлайн и планы сохранятся; для записи результата в проект нужно сохранить сценарий.',
    replacePartsConfirm: 'Заменить части',
    partsFromTiming: 'Части из разметки',
    recalculateBounds: 'Пересчитать границы',
    recalculateBoundsHint:
      'Сдвинуть окна планов и их строки песни по сохранённым частям и разметке. Постановка планов не меняется; результат попадёт в черновик сценария, его нужно сохранить.',
    saveWithoutProductionHint: 'Сохранить правку, не меняющую сюжет: принятые комплекты и пакеты затронутых планов останутся в силе',
    saveWithoutProduction: 'Сохранить без производства'
  },
  prerequisites: {
    timing: 'На странице «Тайминги» разметьте строки песни и сохраните результат.',
    cast: 'На странице «Кастинг» создайте героев и другие объекты клипа.',
    reference: 'На странице «Кастинг» добавьте изображение хотя бы одному герою или объекту.',
    duration: 'На странице «Тайминги» заново разметьте трек, чтобы определить его длительность.',
    treatment: 'Заполните и сохраните части сценария.',
    savedDrafts: 'Сначала сохраните сценарий: границы пересчитываются по сохранённым частям.'
  },
  workflow: {
    agentBusy: 'Агент уже работает в этом проекте.',
    resolveProposal: commonTexts.proposal.resolveCurrent,
    title: 'Подготовка с агентом',
    treatmentApproved: 'Кастинг и части утверждены',
    treatmentUnapproved: 'Кастинг и части не утверждены',
    description: 'Агент готовит предложение. Сначала просмотрите сравнение, затем отдельно примените результат. Ручные редакторы доступны без агента.',
    /**
     * Предупреждение о пересмотре сценария называет изменившиеся входы; без них — прежняя общая причина. next —
     * доступное сейчас действие, которое снимает предупреждение: «scenes» — утвердить сценарий; «pair» — сначала
     * утвердить пару (правка разметки, кастинга или частей снимает и её утверждение), затем сценарий.
     */
    scenesNeedReview: (changed: readonly ScenarioInput[], next: 'scenes' | 'pair' | null = null): string => {
      const approve =
        next === 'scenes'
          ? ` Когда планы проверены и сценарий сохранён, нажмите «${approveScenesLabel}»: предупреждение исчезнет.`
          : next === 'pair'
            ? ` Когда планы проверены и сценарий сохранён, нажмите «${approveTreatmentLabel}», затем «${approveScenesLabel}»: предупреждение исчезнет.`
            : '';
      if (!changed.length) return `Кастинг или части изменились. Существующий сценарий требует пересмотра.${approve}`;
      const list = changed.map((input) => scenarioInputLabels[input]).join(', ');
      const bounds = changed.includes('timing')
        ? ' Границы планов в сценарии могут не совпадать с новыми участками песни: пересчитайте их кнопкой «Пересчитать границы» и сохраните сценарий. Принятые планы со сдвинутыми границами потребуют нового производства.'
        : '';
      return `После утверждения изменились: ${list}.${bounds} Существующий сценарий требует пересмотра.${approve}`;
    },
    proposalAppliedSentence: commonTexts.proposal.appliedSentence,
    proposalStale: 'Предложение устарело. Исходные файлы изменились; нужен новый запуск.',
    reviewProposal: 'Просмотреть предложение и сравнение',
    newProposal: 'Создать новое предложение',
    createTreatment: 'Создать части',
    approveTreatmentHint: 'Сначала утвердите текущие кастинг и части: готовую ручную пару можно утвердить без повторной генерации.',
    createScenes: 'Создать сценарий',
    approveTreatmentReason: 'Сначала утвердите текущие кастинг и части.',
    selectShot: 'Выберите план в списке планов.',
    fixRegistry: 'Сначала исправьте ошибки сценария.',
    approveTreatment: approveTreatmentLabel,
    approveScenes: approveScenesLabel,
    collapseProblems: 'Свернуть',
    showAllProblems: ({ count }: { count: number }) => `Показать все (${count})`,
    scenesApproved: 'Сценарий утверждён'
  },
  /** Блок «Проверка сценария»: отчёт агента о противоречиях до производства. */
  check: {
    title: 'Проверка сценария',
    description:
      'Агент сверяет части и планы сценария с кастингом, изображениями и состоянием героев и находит то, что испортит опоры и видео. Сценарий он не меняет: что исправить, решаете вы. Правки состояния приложение вносит само кнопкой «Исправить», остальное дорабатывает агент по описанию проблемы.',
    start: 'Проверить сценарий',
    restart: 'Проверить заново',
    statusNone: 'Не проверялся',
    statusRunning: 'Проверяется',
    statusClean: 'Проблем не найдено',
    statusIssues: ({ count }: { count: number }) => `Найдено ${countLabel(count, 'проблема', 'проблемы', 'проблем')}`,
    statusStale: 'Отчёт устарел',
    statusFailed: 'Проверка не удалась',
    stale: 'После проверки изменились сценарий, кастинг или исходники: отчёт может не совпадать с текущими файлами. Проверьте сценарий заново.',
    clean: 'Агент не нашёл противоречий, которые испортят опоры или видео.',
    groups: {
      state: 'Состояние героев и мира',
      story: 'Сюжет и части',
      cast: 'Кастинг и референсы',
      joins: 'Стыки планов'
    } satisfies Record<ScenarioCheckGroup, string>,
    severities: {
      high: 'Важно',
      medium: 'Заметно',
      low: 'Мелочь'
    } satisfies Record<ScenarioCheckSeverity, string>,
    problem: 'Что не так',
    why: 'Чем это грозит',
    fix: 'Что сделать',
    entities: ({ names }: { names: string }) => `Касается: ${names}`,
    openShot: ({ shot }: { shot: string }) => `Открыть ${shot}`,
    openShotHint: ({ shot }: { shot: string }) => `Выбрать ${shot} в списке планов и прокрутить к нему`,
    showAll: ({ count }: { count: number }) => `Показать все (${count})`,
    collapse: 'Свернуть',
    finished: ({ count }: { count: number }) =>
      count ? `Проверка сценария готова: ${countLabel(count, 'проблема', 'проблемы', 'проблем')}.` : 'Проверка сценария готова: проблем не найдено.',
    finishedFailed: 'Проверка сценария не удалась. Подробности — на странице «Сценарий».',
    fixButton: 'Исправить',
    fixHint: 'Показать правки и задетые принятые планы перед записью',
    fixSelected: ({ count }: { count: number }) => `Исправить выбранные (${count})`,
    fixSelectedReason: 'Отметьте проблемы с правками, которые приложение может внести само.',
    select: ({ title }: { title: string }) => `Выбрать для исправления: ${title}`,
    fixed: 'Исправлено',
    fixedHint: 'Правки этой проблемы уже внесены в сценарий.',
    resolve: 'Решено вручную',
    resolveHint: 'Закрыть проблему без правок приложения: вы исправили её сами или решили не исправлять',
    resolved: 'Решено вручную',
    resolvedHint: 'Вы отметили проблему решённой: исправили её сами или решили не исправлять.',
    unresolve: 'Вернуть в работу',
    unresolveHint: 'Снять отметку «Решено вручную»: проблема снова считается нерешённой',
    openCount: ({ count }: { count: number }) => `Нерешённых: ${count}`,
    resolveAll: 'Все проблемы разобраны',
    resolveAllHint: 'Отметить все нерешённые проблемы «Решено вручную» и свернуть отчёт до одной строки',
    resolveAllTitle: 'Отметить все проблемы разобранными?',
    resolveAllDescription: ({ count }: { count: number }) =>
      `Отметка «Решено вручную» встанет у ${countLabel(count, 'нерешённой проблемы', 'нерешённых проблем', 'нерешённых проблем')}: вы исправили их сами или решили не исправлять. Сценарий не изменится. Отметку можно снять у каждой проблемы кнопкой «Вернуть в работу».`,
    resolveAllConfirm: 'Отметить разобранными',
    statusReviewed: 'Отчёт разобран',
    reviewed: ({ date }: { date: string | null }) => (date ? `Отчёт разобран — проверка от ${date}` : 'Отчёт разобран'),
    reviewedHint: 'Все проблемы исправлены или отмечены «Решено вручную». Новая проверка покажет свой отчёт.',
    showReport: 'Показать отчёт',
    hideReport: 'Скрыть отчёт',
    revise: 'Доработать с агентом',
    reviseHint: 'Открыть доработку планов проблемы с её описанием в замечании',
    reviseNoShots: 'Проблема не привязана к планам: исправьте части или кастинг вручную.',
    reviseNote: ({ title, problem, fix }: { title: string; problem: string; fix: string }) => `${title}\n\n${problem}\n\nЧто сделать: ${fix}`,
    applied: ({ count }: { count: number }) => `Правки внесены: ${countLabel(count, 'проблема', 'проблемы', 'проблем')}.`,
    shotNotice: ({ shot }: { shot: string }) => `Проверка сценария нашла проблемы у ${shot}`,
    toReport: 'К отчёту',
    toReportHint: 'Прокрутить к проблеме в отчёте проверки сценария',
    dialog: {
      title: 'Исправить сценарий',
      loading: 'Собираю правки и задетые планы.',
      stale: 'Отчёт устарел: значения в сценарии могли измениться после проверки. Сверьте «Сейчас» и «Станет» перед записью.',
      changes: 'Что изменится',
      shot: 'План',
      phase: 'Кадр',
      entity: 'Кто',
      property: 'Свойство',
      current: 'Сейчас',
      value: 'Станет',
      phases: { before: 'Первый кадр', after: 'Итог плана' },
      noValue: 'не задано',
      removed: 'убрать',
      inherit: 'Следующие планы наследуют новое значение по «Наследованию состояния», как при ручной правке блока «Состояние героев и мира».',
      acceptedTitle: 'Принятые планы, которые изменятся',
      acceptedHint: 'Правка меняет их постановку — напрямую или через наследование состояния. Решите по каждому.',
      direct: 'правка в самом плане',
      inherited: 'через наследование',
      reshoot: 'Переснять',
      reshootHint: 'План получит отметку «Постановка изменена». Принятое видео остаётся в монтаже, пока план не снят заново.',
      keep: 'Видео подходит — оставить принятым',
      keepHint: 'Видео уже соответствует исправленным записям: принятие и отметки производства переносятся на новую постановку.',
      stalePlans: ({ shots }: { shots: string[] }) => `Начатое производство этих планов получит отметку «Постановка изменена»: ${shots.join(', ')}.`,
      apply: 'Внести правки'
    }
  },
  list: {
    search: 'Поиск плана',
    searchPlaceholder: 'Код, строка песни или действие',
    foundShots: ({ shown, total }: { shown: number; total: number }) => `Найдено планов: ${shown} из ${total}`,
    shots: ({ count }: { count: number }) => `Планов: ${count}`,
    nothingFound: 'Ничего не найдено. Попробуйте код плана или часть строки песни.',
    speech: 'речь'
  },
  registry: {
    moreProblems: ({ count }: { count: number }) => `… и ещё ${count}`,
    selectShot: 'Выберите план.'
  },
  /** Блок «Точка съёмки» редактора плана: сторона и крупность по схеме локации, место камеры на мини-схеме. */
  viewpoint: {
    title: 'Точка съёмки',
    badgeUnset: 'не задана',
    badge: ({ side, size, placed }: { side: string; size: string; placed: boolean }) => `${side} · ${size}${placed ? ' · на схеме' : ''}`,
    sides: { north: 'С севера', east: 'С востока', south: 'С юга', west: 'С запада', top: 'Сверху' },
    sizes: { wide: 'Общий', medium: 'Средний', close: 'Крупный', detail: 'Деталь' },
    intro:
      'Откуда снимает камера и где стоят герои по схеме локации. «С юга» — камера стоит на юге и смотрит на север. По точке съёмки агенты получат фон, стороны кадра и расстояния. Движение и угол камеры словами остаются в поле «Камера».',
    create: 'Задать точку съёмки',
    noLocations: 'В кастинге нет локаций. Добавьте сущность типа «Локация» на странице «Кастинг».',
    location: 'Локация',
    side: 'Сторона',
    sideFromPoints: ({ side }: { side: string }) => `${side}: сторона считается по камере и героям.`,
    size: 'Крупность',
    fov: 'Угол обзора, °',
    fovDefault: ({ fov }: { fov: number }) => `по крупности — ${fov}°`,
    fovOwn: ({ fov }: { fov: number }) => `свой угол; по крупности — ${fov}°`,
    fovReset: 'Угол по крупности',
    target: 'Щелчок ставит',
    camera: 'Камера',
    phase: 'Кадр',
    phases: { start: 'Первый кадр', end: 'Последний кадр' },
    pickHint:
      'Выберите, кого ставить, и щёлкните по схеме; пока выбрана камера, под курсором виден её будущий сектор. На последнем кадре щелчок задаёт, куда камера или герой переместятся за план. Поставленные камеру и героев можно перетаскивать, схема при этом не меняется. Камера целится так, чтобы в кадр вошли все герои, без них — смотрит по стороне; герой в фокусе — главный в кадре. Край сектора тянется мышью и меняет угол обзора, ромб посередине дуги поворачивает камеру на выбранном кадре — когда в кадре не только герои. Ползунок справа меняет масштаб, перетаскивание пустого места сдвигает схему: вокруг локации есть место для дальней камеры.',
    pickTopHint: 'Камера сверху смотрит вниз: её точка — место, над которым она висит.',
    noTop: 'У этой локации нет схемы вида сверху. Нарисуйте её на странице «Схемы», чтобы поставить камеру и героев.',
    schemesError: ({ error }: { error: string }) => `Схемы локаций не прочитаны: ${error}`,
    notPlaced: 'не на схеме',
    still: 'стоит',
    movesBy: ({ metres }: { metres: string }) => `движется на ${metres} м`,
    fromCamera: ({ metres }: { metres: string }) => `${metres} м от камеры`,
    focus: 'в фокусе',
    headingOwn: 'своё направление',
    headingAuto: 'Прицел на героев',
    outOfFrame: ({ end }: { end: boolean }) => (end ? 'вне последнего кадра' : 'вне кадра'),
    outOfFrameHint: 'Не входит в угол обзора: расширьте угол, отодвиньте камеру или передвиньте героя.',
    makeFocus: 'В фокус',
    removeEnd: 'Убрать движение',
    removeTarget: 'Убрать со схемы',
    subjectLabel: ({ name, metres }: { name: string; metres: string | null }) => (metres === null ? name : `${name} · ${metres} м`),
    cameraView: 'Вид из камеры',
    cameraViewHint: ({ eye, figure }: { eye: string; figure: string }) =>
      `Кадр 16:9 из точки камеры с её углом обзора. Камера на высоте ${eye} м, герои — условные фигуры высотой ${figure} м, герой в фокусе — оранжевый. Объём предметов задаётся на странице «Схемы».`,
    cameraViewNoCamera: 'Поставьте камеру на схему: здесь появится вид из неё.',
    cameraViewTop: 'Камера сверху смотрит вниз: её кадр — сама схема.',
    cameraFrame: ({ phase }: { phase: string }) => `Вид из камеры, ${phase.toLowerCase()}`,
    remove: 'Убрать точку съёмки',
    preview: ({ title }: { title: string }) => `Мини-схема «${title}»`,
    fullscreenTitle: ({ shot }: { shot: string }) => `Точка съёмки ${shot}`,
    lockedHint: 'План принят: точка съёмки закрыта для правки, как и вся постановка.',
    unlock: 'Изменить точку съёмки',
    unlockTitle: ({ shot }: { shot: string }) => `Изменить точку съёмки принятого плана ${shot}?`,
    unlockText:
      'Видео плана уже снято. Точка съёмки должна описывать, откуда оно снято: по ней агенты напишут описание и промпт, если план придётся переснимать. Если точка не совпадёт с видео, новый кадр снимут с другой стороны и с другим фоном. Тогда он разойдётся и с принятым видео, и с соседними планами. При сохранении приложение спросит: переснять план или оставить видео принятым. Если точка описывает уже снятое видео, выбирайте «Видео подходит — оставить принятым».',
    unlockConfirm: 'Изменить'
  },
  shot: {
    timing: ({ start, end, seconds, frames }: { start: string; end: string; seconds: string; frames: number }) =>
      `${start}–${end} · ${seconds} с · ${countLabel(frames, 'кадр', 'кадра', 'кадров')}`,
    nextBoundary: 'Граница со следующим, с',
    boundaryHint: 'начало следующего плана двигается вместе',
    original: 'Строки песни / оригинал',
    cameraPlaceholder: 'Средний план, статика; медленный наезд',
    actionPlaceholder: 'Что происходит в кадре за время плана',
    continuity: 'Непрерывность (стыки с соседями)',
    derivedHint:
      'Стоп-кадр, повтор или замедление материала другого плана: описание, опоры и генерация для этого плана не нужны. Как именно используется материал, опишите в «Действии».',
    ownGeneration: 'Нет — собственная генерация',
    sourceOption: ({ id, title, derived }: { id: string; title: string | undefined; derived: string | null }) =>
      `${id}${title ? ` · ${title}` : ''}${derived === null ? '' : ` (сам из ${derived})`}`,
    references: 'В кадре (референсы)',
    primaryReference: 'Референс карточки',
    split: 'Разделить план',
    splitTitle: ({ shot }: { shot: string }) => `Разделить ${shot}?`,
    splitByLine: ({ shot, at, id, first, second }: { shot: string; at: string; id: string; first: string; second: string }) =>
      `${shot} разделится в ${at}, по началу строки песни. ${shot} останется со строками «${first}», новый план ${id} получит «${second}».`,
    splitMiddle: ({ shot, at, id }: { shot: string; at: string; id: string }) =>
      `Внутри ${shot} нет границы строк песни, поэтому план разделится посередине, в ${at}. Новый план получит код ${id}, строки песни останутся у обеих половин.`,
    splitRest: ({ shot, id }: { shot: string; id: string }) =>
      `Камера и референсы останутся у обеих половин, действие и непрерывность — с пометкой ЗАПОЛНИТЬ: разделите их между половинами вручную или доработкой с агентом. Изменения состояния останутся у ${shot}, ${id} продолжит его итог. Коды остальных планов не меняются. Изменение применяется к черновику.`,
    splitConfirm: 'Разделить',
    fillMarker: 'Замените пометку ЗАПОЛНИТЬ итоговым текстом: до этого план считается незаполненным.',
    unfilled: 'доделать',
    mergeNext: 'Объединить со следующими',
    mergeTitle: ({ shot }: { shot: string }) => `Объединить ${shot} со следующими планами?`,
    mergeUntil: 'Объединить по план',
    mergeOption: ({ id, seconds }: { id: string; seconds: string }) => `${id} включительно · вместе ${seconds} с`,
    mergeAcceptedStop: ({ shot }: { shot: string }) => `${shot} принят: объединение заканчивается перед ним.`,
    mergeSummary: ({ shot, removed, start, end, seconds }: { shot: string; removed: string; start: string; end: string; seconds: string }) =>
      `${shot} займёт ${start}–${end} (${seconds} с). Коды ${removed} исчезнут, ссылки на них перейдут к ${shot}; коды остальных планов не меняются.`,
    mergeTexts:
      'Строки песни и заметки склеятся через « / », референсы объединятся, изменения состояния сольются по порядку. Разные камера, действие и непрерывность склеятся с пометкой ЗАПОЛНИТЬ: план останется незаполненным, пока вы не сведёте их в одну постановку вручную или доработкой с агентом. Изменение применяется к черновику.',
    mergeTooLong: ({ seconds, max }: { seconds: string; max: number }) =>
      `Вместе ${seconds} с — длиннее ${max} с, предела одного запроса видео у провайдера проекта. Такой план не сгенерировать одним запросом.`,
    mergeParts: ({ parts }: { parts: string }) => `Планы из разных частей песни (${parts}). Объединённый план останется в части первого плана.`,
    mergeLastReason: 'Это последний план: объединять не с чем.',
    mergeConfirm: 'Объединить'
  },
  state: {
    title: commonTexts.shot.stateTitle,
    inherit: 'Наследовать состояние',
    start: 'начало сюжета (начальное состояние кастинга)',
    after: ({ shot }: { shot: string }) => 'после ' + shot,
    before: ({ shot }: { shot: string }) => 'перед ' + shot,
    repeat: ({ shot }: { shot: string }) => 'повтор ' + shot,
    beforeBlock: 'Первый кадр (before)',
    afterBlock: 'Итог плана (after)'
  },
  timeline: {
    range: ({ start, end }: { start: string; end: string }) => `${start}–${end}`,
    statusCount: ({ label, count }: { label: string; count: number | undefined }) => `${label}: ${count}`,
    shotHint: ({ id, start, end, status }: { id: string; start: string; end: string; status: string | null }) =>
      `${id} · ${start}–${end}${status === null ? '' : ` · ${status}`}`,
    color: 'Цвет планов:',
    colorAccessibleName: 'Цвет планов на шкале',
    byPart: 'По частям',
    byStatus: 'По статусу'
  },
  save: {
    wait: 'Дождитесь завершения сохранения.',
    animaticNote: 'Аниматик после сохранения потребует пересборки — это локальная операция без оплаты.',
    productionTitle: 'Сохранить изменения постановки?',
    productionDescription: () =>
      `Сохранение меняет постановку планов ниже. Принятые из них получат статус «постановка изменена» и потребуют нового производства, а их пакеты — нового согласования. Если правка не меняет сюжет, например исправляет опечатку, выберите «Сохранить без производства». ${scenarioTexts.save.animaticNote}`,
    keepTitle: 'Сохранить без нового производства?',
    keepDescription: () =>
      `Подходит для опечаток и правок, не меняющих сюжет. Принятые комплекты и пакеты перечисленных планов останутся в силе, хотя их постановка в сценарии изменится. ${scenarioTexts.save.animaticNote}`,
    affectedShots: ({ count }: { count: number }) => `Затронутые планы: ${count}`,
    affectedShotsRegion: 'Последствия сохранения для планов',
    keepNothingReason: 'Изменения не затрагивают принятые планы и пакеты: используйте «Сохранить».',
    choiceHint: 'Для каждого принятого плана решите, снимать ли его заново.',
    keepHint: 'Видео уже соответствует новой постановке: принятие и отметки производства переносятся на неё.'
  },
  treatment: {
    emptyHint:
      'Сценарий начинается с частей песни: что происходит в каждой и кто участвует. Начните с частей из разметки трека или поручите первый проход агенту кнопкой «Создать части» выше.',
    createManually: 'Создать вручную',
    loglineHint: 'Одна фраза: о чём клип и в чём его комизм или драма',
    addPart: 'Добавить часть',
    deletePart: ({ title, id }: { title: string; id: string }) => `Удалить часть «${title || id || 'без названия'}»`,
    deleteDescription: 'Часть будет удалена вместе с её описанием, участниками и временными границами.',
    partShots: ({ count }: { count: number }) => `${countLabel(count, 'план', 'плана', 'планов')} в части`,
    partHasShots: 'В части есть планы: они ссылаются на её код. Чтобы изменить состав частей, создайте сценарий заново кнопкой «Создать сценарий».',
    title: ({ count }: { count: number }) => `Общие правила и части · ${count}`,
    blockHint: 'Логлайн, общие визуальные правила и части песни. Правка части задевает её планы: при сохранении приложение спросит, что делать с принятыми.',
    direction: 'Что происходит и зачем',
    singing: 'Поют в кадре (липсинк)',
    problemsTitle: 'Части ещё не готовы к построению планов',
    problemsHint:
      'Части должны идти встык — конец одной части совпадает с началом следующей, первая начинается с 0, последняя заканчивается в конце трека. Черновик можно сохранять и с этими проблемами.'
  },
  leave: {
    scenesDirty: 'Сохраните сценарий: при уходе со страницы несохранённые правки пропадут.'
  },
  notice: {
    treatmentSavedDraft: 'Сценарий сохранён как черновик: исправьте проблемы частей, перечисленные над ними.',
    boundsRecalculated: ({ count }: { count: number }) =>
      `Границы пересчитаны: ${count ? `сдвинуто ${countLabel(count, 'план', 'плана', 'планов')}` : 'изменилась длина трека'}. Проверьте шкалу и сохраните сценарий.`,
    boundsUnchanged: 'Границы планов уже совпадают с разметкой песни.',
    boundsCountChanged: ({ part, was, now, cause, fix }: { part: string; was: number; now: number; cause?: string; fix: string }) =>
      `В части «${part}» по разметке получается ${countLabel(now, 'план', 'плана', 'планов')} вместо ${was}${cause ? `: ${cause}` : ''}. Пересчитать только границы нельзя. В «Общих правилах и частях» ${fix}, сохраните сценарий и пересчитайте границы снова. Или создайте сценарий заново кнопкой «Создать сценарий»: агент заполнит постановку планов.`,
    boundsLineMoved: ({
      line,
      text,
      start,
      end,
      to,
      from,
      fix
    }: {
      line: number;
      text: string;
      start: string;
      end: string;
      to: string;
      from: string;
      fix: string;
    }) =>
      `Строка ${line} «${text}» (${start}–${end} с) по разметке попадает в часть «${to}», а в сценарии она в части «${from}»: при пересчёте строка ушла бы в чужой план. Пересчитать только границы нельзя. В «Общих правилах и частях» ${fix}, сохраните сценарий и пересчитайте границы снова.`,
    boundsCause: {
      leadPause: ({ seconds, line }: { seconds: string; line: number }) => `пауза ${seconds} с перед первой строкой (строка ${line}) стала отдельным планом`,
      trailPause: ({ seconds, line }: { seconds: string; line: number }) => `пауза ${seconds} с после последней строки (строка ${line}) стала отдельным планом`,
      noLines: ({ length, max }: { length: string; max: string }) => `в части нет строк песни, и её ${length} с делятся на планы не длиннее ${max} с`,
      lines: ({ count, first, last }: { count: number; first: number; last: number }) =>
        `в часть попадает ${countLabel(count, 'строка', 'строки', 'строк')} песни (${first === last ? `строка ${first}` : `строки ${first}–${last}`}), каждая начинает свой план`
    },
    boundsFix: {
      moveStart: ({ at }: { at: string }) => `сдвиньте начало части к ${at} с`,
      moveEnd: ({ at }: { at: string }) => `сдвиньте конец части к ${at} с`,
      movePartStart: ({ part, at }: { part: string; at: string }) => `сдвиньте начало части «${part}» к ${at} с`,
      movePartEnd: ({ part, at }: { part: string; at: string }) => `сдвиньте конец части «${part}» к ${at} с`,
      maxShot: `поправьте «${maxShotLabel}» части`,
      maxShotValue: ({ value, count }: { value: string; count: number }) =>
        `поставьте части «${maxShotLabel}» ${value}, чтобы планов в ней было ${count}, как в сценарии`,
      keepCount: ({ part, value, count }: { part: string; value: string; count: number }) =>
        `, а части «${part}» поставьте «${maxShotLabel}» ${value}, чтобы планов в ней было ${count}, как в сценарии`,
      lines: 'сверьте границы части с её строками на странице «Тайминги»'
    },
    boundsPartsChanged:
      'Планы ссылаются не на те части, что есть в сценарии: пересчитать только границы нельзя. Верните части или создайте сценарий заново кнопкой «Создать сценарий».',
    scenesSavedKeep: 'Сценарий сохранён без нового производства',
    scenesSaved: 'Сценарий сохранён',
    proposalApplied: commonTexts.proposal.applied,
    proposalDiscarded: 'Предложение отклонено',
    shotTooShort: 'План слишком короткий для деления.',
    proposalReady: 'Предложение агента готово: просмотрите сравнение и примените результат.',
    agentInterrupted: 'Задание агента прервано.',
    agentCancelled: 'Подготовка остановлена.',
    agentFailed: 'Агент не подготовил предложение.'
  }
} as const;
