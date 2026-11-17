/** Целая страница «Сценарий» на локальной модели: сохранённые документы, проверка, врезка и проход агента живут только в памяти. */
import { useSyncExternalStore, type ReactElement } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Link, Paper, Stack, Typography } from '@mui/material';
import type { Api } from '@shared/api';
import type {
  AppState,
  BriefResult,
  CastFile,
  EntityState,
  SceneShot,
  ScenarioView,
  ScenesFile,
  ScenesSaveMode,
  StateDelta,
  StateSource,
  TimingFile,
  TreatmentFile
} from '@shared/types';
import type { ScenarioCheckFixPreview, ScenarioCheckReport, ScenarioCheckView, ScenarioWorkflowView } from '@shared/scenario-workflow';
import { DEFAULT_FPS } from '@shared/video';
import { scenarioTexts } from '@shared/texts/scenario';
import { ScenarioPage } from '../pages/ScenarioPage/ScenarioPage';
import { shotPageRoute } from '../components/shotRoutes';
import { createStoryApi, STORY_IMAGE_PATH, STORY_TRACK_PATH, type StoryOptions } from './storybook';
import { storyAccess } from './commonStories';
import { scenarioDocuments, scenarioJob, scenarioProposal, SCENARIO_STORY_PROJECT } from './scenarioWorkflowStories';
import { productionShot } from './productionQueueStories';

export const SCENARIO_PAGE_PROJECT = SCENARIO_STORY_PROJECT;
export const SCENARIO_PAGE_READ_ERROR = 'Не удалось прочитать plan/scenes.json: файл занят другой программой. Закройте её и повторите чтение.';
export const SCENARIO_PAGE_LOAD_DELAY = 1200;
/** Действие, которое модель считает незаполненным: проверка сценария требует описания каждого плана. */
export const scenarioPageActionProblem = (shot: string): string => `${shot}: опишите действие плана.`;

/**
 * regular — шесть планов и утверждённые части; long — сорок планов с длинными текстами; produced — у M01 и M02 есть
 * принятые материалы; proposal — готовое предложение прохода сценария; noShots — сценарий из одних частей;
 * noScenario — сценария ещё нет; loading и loadError — отложенное и ошибочное первое чтение.
 */
export type ScenarioPageVariant = 'regular' | 'long' | 'produced' | 'proposal' | 'noShots' | 'noScenario' | 'loading' | 'loadError';

export interface ScenarioPageOptions {
  variant?: ScenarioPageVariant;
  failScenesSaveOnce?: boolean;
  /** Начальный маршрут демонстрационного роутера, например с ?shot=M03. */
  route?: string;
  /** Планы, для которых под страницей есть демонстрационные ссылки ?shot= (переход на уже открытой странице). */
  links?: string[];
  /**
   * Музыкальная карта с промежутками и перекрытием секций, как у автоматической разметки; сохранённые части
   * скопировали эти границы как есть и поэтому не стыкуются (проблемы видны сразу после открытия).
   */
  gappedTiming?: boolean;
  /** Кастинг получил референс после сохранения сценария: карта references устарела, обновит её только запись сценария. */
  referencesStale?: boolean;
  /**
   * Новая разметка сдвинула первую строку второй части (строка 3) с 8 на 10.6 с, а граница части осталась 8: пауза
   * 2.6 с стала в каркасе отдельным планом, и «Пересчитать границы» отказывает с причиной.
   */
  leadPause?: boolean;
  /**
   * Новая разметка сдвинула строку 3 «Скрипит знакомая калитка» на 7–8.8 с: её середина раньше границы частей (8 с),
   * поэтому каркас отдаёт строку плану M02 первой части, а M03 становится инструменталом. Число планов то же, но
   * «Пересчитать границы» отказывает: строка ушла бы в чужой план.
   */
  lineMoved?: boolean;
  /** Планы с принятым в производстве видео: их постановка на странице закрыта для правки. */
  accepted?: string[];
  /** Последняя проверка сценария агентом: не было, отчёт с проблемами или без них. */
  check?: 'none' | 'report' | 'clean';
}

/** Демонстрационный отчёт проверки: по одной проблеме каждой важности, самая важная записана последней. */
export const STORY_CHECK_REPORT: ScenarioCheckReport = {
  summary: 'Сценарий в целом согласован. Сначала исправьте состояние героя в M02: иначе опора покажет его сухим под дождём.',
  issues: [
    {
      group: 'joins',
      severity: 'low',
      shots: ['M05', 'M06'],
      entities: [],
      title: 'Камера меняет сторону на стыке M05 и M06',
      problem: 'В M05 «Камера» снимает ворота слева, а в M06 — справа, хотя «Непрерывность (стыки с соседями)» обещает тот же ракурс.',
      why: 'На склейке ворота перескочат с одной стороны кадра на другую.',
      fix: 'У M06 в «Камера» укажите съёмку слева, как в M05, или опишите смену стороны в «Непрерывность (стыки с соседями)».',
      changes: [],
      fixed: false,
      resolved: false
    },
    {
      group: 'story',
      severity: 'medium',
      shots: ['M04'],
      entities: ['neighbor'],
      title: 'Сосед появляется раньше куплета',
      problem: 'Направление части «Куплет у калитки» вводит соседа Пашу, а в M04 «Действие» уже показывает его разговор с героем в части «Возвращение».',
      why: 'Разговор начнётся до строки песни о калитке, и сюжет части сдвинется.',
      fix: 'Перенесите разговор в первый план части «Куплет у калитки» или уберите соседа из «В кадре (референсы)» у M04.',
      changes: [],
      fixed: false,
      resolved: false
    },
    {
      group: 'state',
      severity: 'high',
      shots: ['M02', 'M03'],
      entities: ['hero'],
      title: 'Герой в сухой куртке под дождём',
      problem:
        'У M02 в «Состояние героев и мира» → «Первый кадр (before)» у героя «Куртка» — «сухая» из начального состояния кастинга, а «Действие» идёт под дождём с M01.',
      why: 'Опоры M02 и M03 покажут сухую куртку, хотя герой уже несколько планов мокнет.',
      fix: 'У M02 в «Первый кадр (before)» задайте герою «Куртка» — «мокрая, тёмная от дождя».',
      changes: [{ shot: 'M02', phase: 'before', entity: 'hero', property: 'coat', value: 'мокрая, тёмная от дождя' }],
      fixed: false,
      resolved: false
    }
  ]
};

/** Секции карты для gappedTiming: промежутки короче порога разметки и перекрытие последних двух частей. */
const GAPPED_SECTIONS: ReadonlyArray<{ start: number; end: number }> = [
  { start: 0.4, end: 7.3 },
  { start: 8.1, end: 16.4 },
  { start: 16.1, end: 22.8 }
];
/** Код части латиницей, как в проверке частей Go. */
const PART_CODE = /^[a-z0-9][a-z0-9_]*$/;

/** Части сценария отдельным документом — как scenario.TreatmentOf в Go: по ним проверяются части и утверждение пары. */
function partsOf(scenes: ScenesFile | null): TreatmentFile | null {
  return scenes && { schema_version: 1, logline: scenes.logline, sequences: scenes.sequences };
}

/**
 * Упрощённая проверка частей для витрины (полная — ValidateTreatment в Go): пустой список, код, повтор, название,
 * стык с допуском 0.06 с, конец раньше начала и конец по длительности трека; тексты — из словаря сценария.
 */
function storyTreatmentProblems(treatment: TreatmentFile, duration: number | null): string[] {
  const texts = scenarioTexts.main;
  if (!treatment.sequences.length) return [texts.treatmentRequiresParts];
  const problems: string[] = [];
  const ids = new Set<string>();
  let cursor = 0;
  for (const part of [...treatment.sequences].sort((a, b) => a.start - b.start)) {
    if (!PART_CODE.test(part.id)) problems.push(texts.partCodeLatin({ title: part.title || part.id }));
    if (ids.has(part.id)) problems.push(texts.duplicatePartCode({ id: part.id }));
    ids.add(part.id);
    if (!part.title.trim()) problems.push(texts.partTitleMissing({ id: part.id }));
    if (Math.abs(part.start - cursor) > 0.06) problems.push(texts.partStartMismatch({ id: part.id, start: part.start, previousEnd: cursor.toFixed(2) }));
    if (part.end <= part.start) problems.push(texts.partEndsBeforeStart({ id: part.id }));
    cursor = part.end;
  }
  if (duration && Math.abs(cursor - duration) > 0.06) problems.push(texts.treatmentDurationMismatch({ end: cursor.toFixed(2), duration: duration.toFixed(2) }));
  return problems;
}

const SHOT_SECONDS = 4;
/** Начало строки 3 в разметке истории с паузой перед первой строкой второй части (leadPause). */
const LEAD_PAUSE_LINE_START = 10.6;
const LONG_SHOT_SECONDS = 3;
const LONG_COUNT = 40;

const id = (index: number): string => `M${String(index + 1).padStart(2, '0')}`;

function pageCast(long: boolean): CastFile {
  const base = scenarioDocuments().cast!;
  const hero = base.entities[0];
  return {
    schema_version: 1,
    properties: {
      character: [
        { key: 'coat', label: 'Куртка' },
        { key: 'mood', label: 'Настроение' }
      ],
      location: [{ key: 'light', label: 'Свет' }]
    },
    entities: [
      {
        ...hero,
        name: long ? 'Герой у старых ворот садового товарищества «Рассвет над рекой» в дождливый вечер' : hero.name,
        initial_state: { coat: 'сухая', mood: 'спокоен' }
      },
      {
        id: 'neighbor',
        kind: 'character',
        name: 'Сосед Паша',
        short_name: 'Паша',
        role: 'Встречает героя у калитки',
        appearance: 'Седые усы, светлая рубашка.',
        images: ['heroes/story-image.png'],
        initial_state: { coat: 'нет', mood: 'дремлет' }
      },
      {
        id: 'gate',
        kind: 'location',
        name: 'Старые ворота',
        short_name: 'Ворота',
        role: 'Место возвращения',
        appearance: 'Деревянные ворота в тёплом вечернем свете.',
        images: [],
        initial_state: { light: 'тёплый, слева' }
      }
    ]
  };
}

const PARTS = [
  { id: 'intro', title: 'Возвращение', direction: 'Герой подходит к воротам под дождём.' },
  { id: 'verse', title: 'Куплет у калитки', direction: 'Сосед замечает героя, разговор через калитку.' },
  { id: 'chorus', title: 'Припев во дворе', direction: 'Герой поёт, свет в окне становится ярче.' },
  { id: 'final', title: 'Финал', direction: 'Ворота закрываются, камера отъезжает.' }
];

function regularShots(): SceneShot[] {
  const rows: Array<Pick<SceneShot, 'title' | 'original' | 'camera' | 'action' | 'references' | 'lipsync' | 'state_changes'>> = [
    {
      title: 'У ворот',
      original: 'Я снова у ворот',
      camera: 'Общий неподвижный план.',
      action: 'Герой подходит к воротам под дождём.',
      references: ['hero'],
      lipsync: false,
      state_changes: { after: { hero: { coat: 'мокрая' } } }
    },
    {
      title: 'Свет в окне',
      original: 'В окне горит огонь',
      camera: 'Крупный план.',
      action: 'Герой поворачивает голову к окну.',
      references: ['hero'],
      lipsync: false,
      state_changes: { after: { hero: { mood: 'встревожен' } } }
    },
    {
      title: 'Калитка',
      original: 'Скрипит знакомая калитка',
      camera: 'Средний план через забор.',
      action: 'Герой толкает калитку, из темноты выходит сосед.',
      references: ['hero', 'neighbor'],
      lipsync: false,
      state_changes: {}
    },
    {
      title: 'Сосед',
      original: 'Сосед глядит из-под руки',
      camera: 'Крупный план соседа.',
      action: 'Сосед узнаёт героя и улыбается.',
      references: ['neighbor'],
      lipsync: false,
      state_changes: { after: { neighbor: { mood: 'удивлён' } } }
    },
    {
      title: 'Припев у дома',
      original: 'Вот он, мой дом',
      camera: 'Медленный наезд.',
      action: 'Герой поёт, глядя на окно.',
      references: ['hero'],
      lipsync: true,
      state_changes: {}
    },
    {
      title: 'Финал',
      original: 'И дождь уже не страшен',
      camera: 'Отъезд камеры, общий план.',
      action: 'Ворота закрываются за героем.',
      references: ['hero'],
      lipsync: false,
      state_changes: {}
    }
  ];
  return rows.map((row, index) => ({
    ...row,
    id: id(index),
    sequence: PARTS[Math.min(Math.floor(index / 2), 2)].id,
    start_frame: index * SHOT_SECONDS * DEFAULT_FPS,
    end_frame_exclusive: (index + 1) * SHOT_SECONDS * DEFAULT_FPS,
    continuity: 'Свет слева, герой смотрит вправо.',
    card: { primary_reference: row.references[0] },
    state_from: index === 0 ? null : id(index - 1)
  }));
}

/** Длинные названия, строки песни и действия проверяют переносы, обрезку и отсутствие прокрутки документа. */
function longShots(): SceneShot[] {
  return Array.from({ length: LONG_COUNT }, (_, index) => ({
    id: id(index),
    title: `План ${index + 1}: возвращение к старым воротам садового товарищества под затяжным осенним дождём`,
    original: `Строка песни ${index + 1}: я снова у старых ворот, и дождь стучит по крыше соседского сарая без остановки`,
    sequence: PARTS[Math.floor((index * PARTS.length) / LONG_COUNT)].id,
    start_frame: index * LONG_SHOT_SECONDS * DEFAULT_FPS,
    end_frame_exclusive: (index + 1) * LONG_SHOT_SECONDS * DEFAULT_FPS,
    camera: index % 7 === 3 ? 'ЗАПОЛНИТЬ: камера' : 'Медленный наезд от общего плана к среднему, камера чуть ниже уровня глаз героя.',
    action:
      index % 7 === 3
        ? 'ЗАПОЛНИТЬ: действие'
        : 'Герой останавливается у ворот, стряхивает воду с рукава, оглядывается на окно соседа и медленно толкает тяжёлую мокрую калитку. '.repeat(2).trim(),
    continuity: 'Свет слева, герой смотрит вправо; куртка остаётся мокрой до конца части.',
    references: ['hero'],
    lipsync: index % 5 === 0,
    card: { primary_reference: 'hero' },
    state_from: index === 0 ? null : id(index - 1),
    state_changes: index === 0 ? { after: { hero: { coat: 'мокрая' } } } : {}
  }));
}

function pageScenes(long: boolean): ScenesFile {
  const shots = long ? longShots() : regularShots();
  const base = scenarioDocuments().scenes!;
  const parts = pageTreatment(long);
  return {
    ...base,
    audio: { path: 'source/track.wav', end_seconds: (shots.at(-1)!.end_frame_exclusive / DEFAULT_FPS).toFixed(3) },
    logline: parts.logline,
    sequences: parts.sequences,
    references: {
      hero: { name: 'Герой у ворот', path: 'source/heroes/story-image.png' },
      neighbor: { name: 'Сосед Паша', path: 'source/heroes/story-image.png' }
    },
    scenes: shots
  };
}

function pageTreatment(long: boolean): TreatmentFile {
  const parts = long ? PARTS : PARTS.slice(0, 3);
  const seconds = (long ? LONG_COUNT * LONG_SHOT_SECONDS : 6 * SHOT_SECONDS) / parts.length;
  return {
    schema_version: 1,
    logline: 'Герой возвращается к старым воротам.',
    sequences: parts.map((part, index) => ({
      id: part.id,
      title: part.title,
      direction: part.direction,
      start: index * seconds,
      end: (index + 1) * seconds,
      entities: index === 1 ? ['hero', 'neighbor'] : ['hero'],
      lipsync: part.id === 'chorus',
      max_shot_seconds: 5
    }))
  };
}

function pageTiming(duration: number, scenes: ScenesFile | null, treatment: TreatmentFile): TimingFile {
  const lines = (scenes?.scenes ?? []).map((shot, index) => ({
    id: index + 1,
    source_line: index + 1,
    start: shot.start_frame / DEFAULT_FPS,
    end: shot.end_frame_exclusive / DEFAULT_FPS - 0.2,
    verified: true
  }));
  return {
    version: 2,
    status: 'Утверждена',
    source: 'source/track.mp3',
    sha256: null,
    duration_decoded: duration,
    duration_container: duration,
    clock: 'decoded',
    lines: lines.length ? lines : [{ id: 1, source_line: 1, start: 0, end: duration - 0.2, verified: true }],
    sections: treatment.sequences.map((part) => ({ name: part.title, start: part.start, end: part.end }))
  };
}

function pageView(variant: ScenarioPageVariant, gapped: boolean): ScenarioView {
  const long = variant === 'long';
  const full = pageScenes(long);
  const plain = pageTreatment(long);
  const sequences = gapped ? plain.sequences.map((part, index) => ({ ...part, ...(GAPPED_SECTIONS[index] ?? {}) })) : plain.sequences;
  const scenes: ScenesFile = { ...full, sequences };
  // Сценарий из одних частей — как после первого прохода или ручного заполнения: без audio, references и планов.
  const partsOnly: ScenesFile = { schema_version: 1, fps: DEFAULT_FPS, logline: plain.logline, sequences, scenes: [] };
  const duration = full.scenes.at(-1)!.end_frame_exclusive / DEFAULT_FPS;
  return {
    scenes: variant === 'noScenario' ? null : variant === 'noShots' ? partsOnly : scenes,
    cast: pageCast(long),
    timing: pageTiming(duration, variant === 'noShots' || variant === 'noScenario' ? null : full, { schema_version: 1, logline: plain.logline, sequences }),
    lyrics: scenes.scenes.map((shot, index) => ({ number: index + 1, text: shot.original, header: false })),
    duration,
    trackPath: STORY_TRACK_PATH,
    problems: [],
    referencesStale: false
  };
}

interface ResolvedBrief {
  state: EntityState;
  sources: Record<string, Record<string, StateSource>>;
}

function applyDelta(base: ResolvedBrief, delta: StateDelta | undefined, source: StateSource): ResolvedBrief {
  const next: ResolvedBrief = structuredClone(base);
  for (const [entity, values] of Object.entries(delta ?? {}))
    for (const [key, value] of Object.entries(values)) {
      next.state[entity] ??= {};
      next.sources[entity] ??= {};
      if (value === null) {
        delete next.state[entity][key];
        delete next.sources[entity][key];
      } else {
        next.state[entity][key] = value;
        next.sources[entity][key] = source;
      }
    }
  return next;
}

/** Упрощённое наследование для витрины: начальное состояние кастинга и изменения по цепочке state_from; полный расчёт остаётся в Go. */
function resolveState(
  scenes: ScenesFile,
  cast: CastFile | null,
  shotId: string,
  phase: 'before' | 'after',
  depth = 0
): { result: ResolvedBrief; inherited: EntityState } {
  const initial: ResolvedBrief = { state: {}, sources: {} };
  for (const entity of cast?.entities ?? []) {
    initial.state[entity.id] = { ...entity.initial_state };
    initial.sources[entity.id] = Object.fromEntries(Object.keys(entity.initial_state).map((key) => [key, { kind: 'cast' } as StateSource]));
  }
  const shot = scenes.scenes.find((item) => item.id === shotId);
  if (!shot || depth > scenes.scenes.length) return { result: initial, inherited: initial.state };
  if (phase === 'after') {
    const before = resolveState(scenes, cast, shotId, 'before', depth + 1).result;
    return { result: applyDelta(before, shot.state_changes.after, { kind: 'plan', shot: shotId, phase: 'after' }), inherited: before.state };
  }
  const from = shot.state_from;
  const base =
    from === null
      ? initial
      : typeof from === 'string'
        ? resolveState(scenes, cast, from, 'after', depth + 1).result
        : resolveState(scenes, cast, from.scene, from.phase === 'after' ? 'after' : 'before', depth + 1).result;
  return { result: applyDelta(base, shot.state_changes.before, { kind: 'plan', shot: shotId, phase: 'before' }), inherited: base.state };
}

function pageBrief(scenes: ScenesFile, cast: CastFile | null, shot: string, phase: 'before' | 'after'): BriefResult {
  const { result, inherited } = resolveState(scenes, cast, shot, phase);
  // Сущности кадра плана, как у scenario.BuildBrief: мир, references плана и сущности state_changes той же фазы.
  const record = scenes.scenes.find((item) => item.id === shot);
  const inPlan = new Set(['world', ...(record?.references ?? []), ...Object.keys(record?.state_changes[phase] ?? {})]);
  const labels: BriefResult['labels'] = {};
  const lines: string[] = [];
  const scope: string[] = [];
  for (const [entity, values] of Object.entries(result.state)) {
    const info = cast?.entities.find((item) => item.id === entity);
    const properties = info ? (cast?.properties[info.kind] ?? []) : [];
    labels[entity] = Object.fromEntries(Object.keys(values).map((key) => [key, properties.find((item) => item.key === key)?.label ?? key]));
    if (!inPlan.has(entity)) continue;
    scope.push(entity);
    const described = Object.entries(values).map(([key, value]) => `${labels[entity][key].toLowerCase()} — ${value}`);
    if (described.length) lines.push(`${info?.short_name ?? entity}: ${described.join(', ')}.`);
  }
  const paragraph = lines.join(' ');
  return { shot, phase, state: result.state, sources: result.sources, labels, inherited, scope, paragraph, checklist: lines, text: paragraph };
}

interface PageModel {
  saved: ScenarioView;
  workflow: ScenarioWorkflowView;
  check: ScenarioCheckView;
  checkStarts: number;
  /** Внесённые правки проверки: номера проблем и планы, оставленные принятыми. */
  checkFixes: { issues: number[]; keep: string[] }[];
  /** Проблема отчёта, из которой запущена текущая доработка: применение отмечает её исправленной. */
  checkIssue: number | null;
  links: string[];
  reads: number;
  scenesSaves: ScenesSaveMode[];
  /** Принятые планы, оставленные принятыми при обычных сохранениях с выбором по плану. */
  kept: string[];
  /** Аргументы scene_scaffold при «Пересчитать границы». */
  scaffolds: string[][];
  starts: number;
  applies: number;
  cancels: number;
  subscribe(listener: () => void): () => void;
  revision(): number;
  publish(): void;
}
const models = new WeakMap<Api, PageModel>();

/** Параметры истории целой страницы: оболочка page, стабильные состояние приложения и демонстрационный исполнитель. */
export function scenarioPageOptions({
  variant = 'regular',
  route = '/project/scenario',
  links = ['M02', 'M05'],
  failScenesSaveOnce = false,
  gappedTiming = false,
  referencesStale = false,
  leadPause = false,
  lineMoved = false,
  accepted = [],
  check = 'none'
}: ScenarioPageOptions = {}): StoryOptions {
  const state: AppState = {
    packaged: false,
    problems: [],
    localDir: '/mock/songframe-state',
    current: SCENARIO_PAGE_PROJECT,
    history: [],
    platform: 'linux'
  };
  return {
    shell: 'page',
    route,
    app: { state, online: true, agentProvider: 'codex', aiAccess: storyAccess },
    createApi: () => {
      const listeners = new Set<() => void>();
      let version = 0;
      let failedReads = variant === 'loadError' ? 1 : 0;
      let checkReads = 0;
      const produced = new Set(variant === 'produced' ? ['M01', 'M02'] : []);
      const saved = pageView(variant, gappedTiming);
      if (referencesStale) Object.assign(saved, { referencesStale: true, problems: [scenarioTexts.main.referencesRefresh] });
      const pausedLine = leadPause ? saved.timing?.lines.find((line) => line.source_line === 3) : undefined;
      if (pausedLine) pausedLine.start = LEAD_PAUSE_LINE_START;
      const movedLine = lineMoved ? saved.timing?.lines.find((line) => line.source_line === 3) : undefined;
      if (movedLine) Object.assign(movedLine, { start: 7, end: 8.8 });
      const approved = variant !== 'noShots' && variant !== 'noScenario';
      const workflow: ScenarioWorkflowView = {
        project: SCENARIO_PAGE_PROJECT,
        busy: false,
        canStartTreatment: true,
        canStartScenes: approved,
        canRevise: approved && !!saved.scenes?.scenes.length,
        canApproveCurrent: !approved,
        canApproveScenes: false,
        treatmentApproved: approved,
        scenesNeedReview: false,
        changedInputs: [],
        acceptedShots: [...accepted],
        problems: [],
        proposal: null,
        job: null
      };
      if (variant === 'proposal') {
        workflow.proposal = scenarioProposal('scenes', { before: { cast: saved.cast, treatment: partsOf(saved.scenes), scenes: saved.scenes } });
        workflow.job = scenarioJob('completed');
      }
      const model: PageModel = {
        saved,
        workflow,
        check: {
          status: check === 'none' ? 'none' : 'ready',
          canStart: true,
          reason: null,
          stale: false,
          report: check === 'none' ? null : check === 'clean' ? { summary: 'Противоречий не найдено.', issues: [] } : structuredClone(STORY_CHECK_REPORT),
          message: null,
          job: null
        },
        checkStarts: 0,
        checkFixes: [],
        checkIssue: null,
        links,
        reads: 0,
        scenesSaves: [],
        kept: [],
        scaffolds: [],
        starts: 0,
        applies: 0,
        cancels: 0,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        revision: () => version,
        publish() {
          version++;
          listeners.forEach((listener) => listener());
        }
      };
      let failedSceneSave = false;
      // Запись сценария: части в нём — тоже входы утверждения пары, их изменение снимает утверждение.
      const write = (scenes: ScenesFile, mode: ScenesSaveMode, keep: string[]): ScenesFile => {
        if (failScenesSaveOnce && !failedSceneSave) {
          failedSceneSave = true;
          throw new Error('Не удалось сохранить сценарий. Изменения состояния остались в форме.');
        }
        const partsChanged = JSON.stringify(partsOf(model.saved.scenes)) !== JSON.stringify(partsOf(scenes));
        model.scenesSaves.push(mode);
        model.kept.push(...keep);
        model.saved.scenes = structuredClone(scenes);
        // Как saveScenes в Go: запись заменяет карту references картой кастинга.
        Object.assign(model.saved, { referencesStale: false, problems: [] });
        documentsWritten(partsChanged);
        model.publish();
        return structuredClone(scenes);
      };
      const fixPreview = (issues: number[]): ScenarioCheckFixPreview => {
        const report = model.check.report;
        if (!report) throw new Error('Нет готового отчёта проверки: запустите проверку сценария.');
        const changes: ScenarioCheckFixPreview['changes'] = [];
        for (const index of issues) {
          const issue = report.issues[index];
          if (!issue) throw new Error(`Проблемы ${index + 1} нет в отчёте проверки. Обновите страницу.`);
          if (issue.fixed) throw new Error(`«${issue.title}»: правки уже внесены.`);
          if (!issue.changes.length) throw new Error(`«${issue.title}»: приложение не может исправить это само.`);
          for (const change of issue.changes) changes.push({ ...change, issue: index, entityName: 'Герой у ворот', propertyLabel: 'Куртка', current: 'сухая' });
        }
        const touched = ['M02', 'M03'];
        return {
          changes,
          accepted: model.workflow.acceptedShots
            .filter((id) => touched.includes(id))
            .map((id) => ({ id, direct: changes.some((change) => change.shot === id) })),
          stale: []
        };
      };
      const validate = (project: string): void => {
        if (project !== SCENARIO_PAGE_PROJECT) throw new Error('Неизвестный демонстрационный проект.');
      };
      const snapshot = (): ScenarioWorkflowView => structuredClone(model.workflow);
      const capabilities = (): void => {
        const view = model.workflow;
        Object.assign(model.check, { canStart: !view.busy, reason: view.busy ? 'Дождитесь окончания задания агента в этом проекте.' : null });
        Object.assign(view, {
          canStartTreatment: !view.busy,
          canStartScenes: !view.busy && view.treatmentApproved,
          canRevise: !view.busy && view.treatmentApproved && !!model.saved.scenes?.scenes.length
        });
      };
      // Как в Go: предложение хранит хеши сохранённых документов, любая запись делает неприменённое предложение устаревшим,
      // а утверждение пары включает части сценария и снимается записью, которая их меняет.
      const documentsWritten = (treatment: boolean): void => {
        const view = model.workflow;
        if (view.proposal && view.proposal.status !== 'applied') view.proposal.stale = true;
        // Отчёт проверки хранит отпечатки сценария: любая запись делает его устаревшим.
        if (model.check.report) model.check.stale = true;
        if (treatment && view.treatmentApproved) {
          Object.assign(view, {
            treatmentApproved: false,
            canApproveCurrent: true,
            canApproveScenes: false,
            scenesNeedReview: !!model.saved.scenes?.scenes.length,
            changedInputs: ['treatment']
          });
          capabilities();
        }
      };
      // Отложенное первое чтение не переживает закрытие истории: таймер снимается вместе с сессией.
      const delay = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          session.onCleanup(() => clearTimeout(timer));
        });
      const session = createStoryApi({
        scenario: {
          view: async (project) => {
            validate(project);
            model.reads++;
            model.publish();
            if (variant === 'loading' && model.reads === 1) await delay(SCENARIO_PAGE_LOAD_DELAY);
            if (failedReads > 0) {
              failedReads--;
              throw new Error(SCENARIO_PAGE_READ_ERROR);
            }
            return structuredClone(model.saved);
          },
          // Как в Go: сначала части, затем планы; сценарий из одних частей проверяется только по частям.
          validateScenes: async (project, scenes) => {
            validate(project);
            return [
              ...storyTreatmentProblems(partsOf(scenes)!, model.saved.duration),
              ...scenes.scenes.filter((shot) => !shot.action.trim()).map((shot) => scenarioPageActionProblem(shot.id))
            ];
          },
          // Как в Go: план задевает своя постановка или направление его части.
          saveImpact: async (project, scenes) => {
            validate(project);
            const before = new Map((model.saved.scenes?.scenes ?? []).map((shot) => [shot.id, JSON.stringify(shot)]));
            const directions = new Map((model.saved.scenes?.sequences ?? []).map((part) => [part.id, part.direction]));
            const partChanged = (part: string): boolean =>
              directions.has(part) && directions.get(part) !== scenes.sequences.find((item) => item.id === part)?.direction;
            return {
              shots: scenes.scenes
                .filter((shot) => before.get(shot.id) !== JSON.stringify(shot) || partChanged(shot.sequence))
                .map((shot) => ({
                  id: shot.id,
                  reason:
                    before.get(shot.id) !== JSON.stringify(shot)
                      ? 'Изменена собственная постановка плана: действие, камера или состояние героев.'
                      : scenarioTexts.main.impactGlobalRules,
                  state: produced.has(shot.id) ? 'completed' : 'planned',
                  produced: produced.has(shot.id)
                }))
            };
          },
          saveScenes: async (project, scenes, mode) => {
            validate(project);
            return write(scenes, mode, []);
          },
          saveScenesKeeping: async (project, scenes, keep) => {
            validate(project);
            return write(scenes, 'production', keep);
          },
          brief: async (project, scenes, shot, phase) => {
            validate(project);
            return pageBrief(scenes, model.saved.cast, shot, phase);
          }
        },
        tools: {
          run: async (project, tool, args = []) => {
            validate(project);
            if (tool !== 'scene_scaffold' || !model.saved.scenes?.scenes.length || !args.includes('--json'))
              throw new Error(`Инструмент ${tool} не моделируется на этой странице.`);
            model.scaffolds.push(args);
            // Каркас без записи — как после правки разметки: стык M01 и M02 на полсекунды позже исходного, остальные окна прежние.
            const shifted = structuredClone(model.saved.scenes);
            shifted.scenes.forEach((shot) => Object.assign(shot, { camera: 'ЗАПОЛНИТЬ', action: 'ЗАПОЛНИТЬ' }));
            shifted.scenes[0].end_frame_exclusive = shifted.scenes[1].start_frame = SHOT_SECONDS * DEFAULT_FPS + DEFAULT_FPS / 2;
            if (lineMoved) {
              // Строка M03 по середине уже в первой части: её текст переходит в последний план первой части.
              shifted.scenes[1].original = `${shifted.scenes[1].original} / ${shifted.scenes[2].original}`;
              shifted.scenes[2].original = `Инструментал: ${shifted.sequences[1].title}`;
            }
            if (leadPause) {
              // Пауза перед сдвинутой строкой 3 — отдельный план в начале второй части; коды следующих планов сдвигаются.
              const split = Math.round(LEAD_PAUSE_LINE_START * DEFAULT_FPS);
              const third = shifted.scenes[2];
              shifted.scenes.splice(2, 1, { ...third, end_frame_exclusive: split }, { ...third, start_frame: split });
              shifted.scenes.forEach((shot, index) => Object.assign(shot, { id: id(index) }));
            }
            // Сохранённое не меняется: публикация только обновляет счётчик построений в панели модели.
            model.publish();
            return { code: 0, stdout: JSON.stringify(shifted), stderr: '', command: `scene_scaffold ${args.join(' ')}` };
          }
        },
        production: {
          // Раскраска шкалы по статусу читает производство; модель отдаёт только статусы планов.
          view: async (project) => {
            validate(project);
            return {
              shots: (model.saved.scenes?.scenes ?? []).map((shot) =>
                productionShot({ id: shot.id, title: shot.title ?? '', original: shot.original, state: produced.has(shot.id) ? 'completed' : 'planned' })
              ),
              broken: [],
              problems: [],
              tools: { providers: {} }
            };
          }
        },
        scenarioWorkflow: {
          view: async (project) => {
            validate(project);
            return snapshot();
          },
          start: async ({ project, pass, note, selectedIds, checkIssue }) => {
            validate(project);
            const view = model.workflow;
            if (view.busy || !(pass === 'treatment' ? view.canStartTreatment : pass === 'scenes' ? view.canStartScenes : view.canRevise))
              throw new Error('Сначала согласуйте входы сценария.');
            model.starts++;
            model.checkIssue = pass === 'revise' ? (checkIssue ?? null) : null;
            view.proposal = scenarioProposal(pass, {
              id: `scenario-proposal-${model.starts + 1}`,
              status: 'running',
              selectedIds: selectedIds ?? [],
              before: { cast: model.saved.cast, treatment: partsOf(model.saved.scenes), scenes: model.saved.scenes },
              after: { cast: null, treatment: null, scenes: null },
              warnings: [],
              message: note ? `Агент дорабатывает план: ${note}` : 'Агент готовит предложение по сохранённым документам.'
            });
            if (pass === 'revise' && model.saved.scenes) {
              // Доработка в модели отвечает сразу: действие выбранных планов дополняется заметкой, предложение готово к сравнению.
              const scenes = structuredClone(model.saved.scenes);
              for (const shot of scenes.scenes) if (selectedIds?.includes(shot.id)) shot.action = `${shot.action} Доработано агентом.`;
              Object.assign(view.proposal, { status: 'ready', after: { cast: null, treatment: null, scenes }, changedIds: [...(selectedIds ?? [])] });
              view.job = scenarioJob('completed');
            } else {
              view.job = scenarioJob('running');
              view.busy = true;
            }
            capabilities();
            model.publish();
            return snapshot();
          },
          apply: async (project, proposalId) => {
            validate(project);
            const proposal = model.workflow.proposal;
            if (model.workflow.busy || proposal?.id !== proposalId || proposal.status !== 'ready' || proposal.stale)
              throw new Error(scenarioTexts.main.proposalNotApplicable);
            if (proposal.pass !== 'treatment' && !model.workflow.treatmentApproved) throw new Error(scenarioTexts.main.pairApprovalStale);
            model.applies++;
            // Как в Go: первый проход владеет кастингом и частями сценария (планы остаются), сценарий и доработка — планами.
            if (proposal.pass === 'treatment') {
              const parts = proposal.after.treatment!;
              const base = model.saved.scenes ?? { schema_version: 1, fps: DEFAULT_FPS, logline: '', sequences: [], scenes: [] };
              model.saved.cast = structuredClone(proposal.after.cast);
              model.saved.scenes = { ...structuredClone(base), logline: parts.logline, sequences: structuredClone(parts.sequences) };
            } else model.saved.scenes = structuredClone(proposal.after.scenes);
            // Как в Go: доработка из проблемы отчёта отмечает её исправленной, если отчёт тот же.
            const linked = model.checkIssue === null ? undefined : model.check.report?.issues[model.checkIssue];
            if (proposal.pass === 'revise' && linked) linked.fixed = true;
            model.checkIssue = null;
            proposal.status = 'applied';
            proposal.message = 'Предложение применено.';
            capabilities();
            model.publish();
            return snapshot();
          },
          discard: async (project, proposalId) => {
            validate(project);
            if (model.workflow.busy || model.workflow.proposal?.id !== proposalId) throw new Error('Предложение уже изменилось.');
            model.workflow.proposal = null;
            model.publish();
            return snapshot();
          },
          approveCurrent: async (project) => {
            validate(project);
            Object.assign(model.workflow, { treatmentApproved: true, canApproveCurrent: false });
            capabilities();
            model.publish();
            return snapshot();
          },
          approveScenes: async (project) => {
            validate(project);
            Object.assign(model.workflow, { canApproveScenes: false, scenesNeedReview: false, changedInputs: [] });
            model.publish();
            return snapshot();
          },
          // Как в Go: проверка занимает проект на время задания; следующее чтение после запуска показывает готовый отчёт.
          checkView: async (project) => {
            validate(project);
            if (model.check.status === 'running' && model.check.job?.status === 'running' && checkReads++ > 0) {
              Object.assign(model.check, {
                status: 'ready',
                stale: false,
                report: structuredClone(STORY_CHECK_REPORT),
                job: { ...scenarioJob('completed'), id: 'scenario-check-job', task: 'ai-clip-scenario:check' }
              });
              model.workflow.busy = false;
              capabilities();
              model.publish();
            }
            return structuredClone(model.check);
          },
          // Как в Go: правки выбранных проблем, задетые принятые планы из acceptedShots (M02 правится сам, M03 наследует) и запись.
          checkFixPreview: async (project, issues) => {
            validate(project);
            return fixPreview(issues);
          },
          applyCheckFixes: async ({ project, issues, keep }) => {
            validate(project);
            const preview = fixPreview(issues);
            const wasStale = model.check.stale;
            const scenes = model.saved.scenes;
            for (const change of preview.changes) {
              const shot = scenes?.scenes.find((item) => item.id === change.shot);
              if (!shot) continue;
              const phase = (shot.state_changes ??= {})[change.phase] ?? {};
              shot.state_changes[change.phase] = { ...phase, [change.entity]: { ...phase[change.entity], [change.property]: change.value } };
            }
            // Планы из keep остаются принятыми, остальные задетые получают «Постановка изменена».
            const reshoot = preview.accepted.filter((shot) => !keep.includes(shot.id)).map((shot) => shot.id);
            model.workflow.acceptedShots = model.workflow.acceptedShots.filter((id) => !reshoot.includes(id));
            model.checkFixes.push({ issues: [...issues], keep: [...keep] });
            for (const index of issues) model.check.report!.issues[index].fixed = true;
            documentsWritten(false);
            model.check.stale = wasStale;
            model.publish();
            return structuredClone(model.check);
          },
          // Как в Go: отметка «Решено вручную» ставится и снимается без записи сценария; исправленную не трогает.
          resolveCheckIssue: async ({ project, issue, resolved }) => {
            validate(project);
            const target = model.check.report?.issues[issue];
            if (!target) throw new Error('Проблема отчёта не найдена.');
            if (target.fixed) throw new Error('Правки этой проблемы уже внесены.');
            target.resolved = resolved;
            model.publish();
            return structuredClone(model.check);
          },
          startCheck: async (project) => {
            validate(project);
            if (model.workflow.busy) throw new Error('Дождитесь окончания задания агента в этом проекте.');
            model.checkStarts++;
            checkReads = 0;
            Object.assign(model.check, {
              status: 'running',
              message: null,
              job: { ...scenarioJob('running'), id: 'scenario-check-job', task: 'ai-clip-scenario:check' }
            });
            model.workflow.busy = true;
            capabilities();
            model.publish();
            return structuredClone(model.check);
          }
        },
        agents: {
          cancel: async (jobId) => {
            if (model.check.job?.id === jobId && model.check.status === 'running') {
              model.cancels++;
              Object.assign(model.check, { status: 'cancelled', message: 'Проверка остановлена.', job: { ...model.check.job, status: 'cancelled' } });
              model.workflow.busy = false;
              capabilities();
              model.publish();
              return structuredClone(model.check.job!);
            }
            const view = model.workflow;
            if (view.job?.id !== jobId || !view.busy) throw new Error('Задание уже завершено.');
            model.cancels++;
            view.job = scenarioJob('cancelled');
            if (view.proposal) Object.assign(view.proposal, { status: 'cancelled', message: scenarioTexts.main.proposalCancelled });
            view.busy = false;
            capabilities();
            model.publish();
            return structuredClone(view.job);
          }
        },
        shell: {
          // Пути изображений кастинга внутри source ведут к опубликованному изображению витрины.
          fileUrl: () => STORY_IMAGE_PATH
        }
      });
      models.set(session.api, model);
      session.onCleanup(() => {
        listeners.clear();
        models.delete(session.api);
      });
      return session;
    }
  };
}

/** Снимок сохранённых документов позволяет проверить, что выбор пустого поля ничего не записал. */
export function scenarioStateInspection(): { saved: ScenarioView; saves: ScenesSaveMode[] } {
  const model = models.get(window.api);
  if (!model) throw new Error('Модель сценария не открыта.');
  return structuredClone({ saved: model.saved, saves: model.scenesSaves });
}

function useModel(): PageModel {
  const model = models.get(window.api);
  if (!model) throw new Error('Для страницы сценария нужна локальная API-сессия.');
  useSyncExternalStore(model.subscribe, model.revision);
  return model;
}

/** Видимый итог модели: play сверяет сохранённые документы, а не только счётчики вызовов. */
function ScenarioPageModelPanel(): ReactElement {
  const model = useModel();
  const scenes = model.saved.scenes?.scenes ?? [];
  return (
    <Paper variant="outlined" sx={{ p: 2, mt: 2, minWidth: 0 }}>
      <Stack spacing={0.5} sx={{ minWidth: 0 }}>
        <Typography variant="subtitle2">Демонстрационная модель проекта</Typography>
        <Typography variant="body2" data-testid="page-model-reads">
          Чтений сценария: {model.reads}.
        </Typography>
        <Typography variant="body2" data-testid="page-model-saves">
          Сохранений сценария: {model.scenesSaves.length}
          {model.scenesSaves.length ? ` (${model.scenesSaves.join(', ')})` : ''}. Оставлены принятыми: {model.kept.join(', ') || 'нет'}.
        </Typography>
        <Typography variant="body2" data-testid="page-model-agent">
          Запусков агента: {model.starts}. Применений: {model.applies}. Остановок: {model.cancels}. Проверок сценария: {model.checkStarts}. Правок проверки:{' '}
          {model.checkFixes.length ? model.checkFixes.map((fix) => `${fix.issues.join(',')} (оставлены: ${fix.keep.join(',') || 'нет'})`).join('; ') : 'нет'}.
        </Typography>
        <Typography variant="body2" data-testid="page-model-scaffold">
          Пересчётов границ: {model.scaffolds.length}
          {model.scaffolds.length ? ` (${model.scaffolds.map((args) => args.join(' ')).join('; ')})` : ''}.
        </Typography>
        <Typography variant="body2" data-testid="page-model-logline" sx={{ overflowWrap: 'anywhere' }}>
          Сохранённый логлайн: {model.saved.scenes?.logline}
        </Typography>
        <Typography variant="body2" data-testid="page-model-shots">
          Сохранённых планов: {scenes.length}.
        </Typography>
        {scenes.slice(0, 6).map((shot) => (
          <Typography key={shot.id} variant="body2" data-testid={`page-model-shot-${shot.id}`} sx={{ overflowWrap: 'anywhere' }}>
            {shot.id}: {shot.camera} {shot.action}
          </Typography>
        ))}
        <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap">
          {model.links.map((shot) => (
            <Link key={shot} component={RouterLink} to={shotPageRoute('scenario', shot)}>
              Ссылка на план {shot}
            </Link>
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
}

/** Рабочая страница целиком и под ней наблюдаемый итог модели с демонстрационными ссылками ?shot=. */
export function ScenarioPageStory(): ReactElement {
  return (
    <>
      <ScenarioPage />
      <ScenarioPageModelPanel />
    </>
  );
}
