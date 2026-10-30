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
import type { ScenarioWorkflowView } from '@shared/scenario-workflow';
import { FPS } from '@shared/video';
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
/** Действие, которое модель считает незаполненным: проверка реестра требует описания каждого плана. */
export const scenarioPageActionProblem = (shot: string): string => `${shot}: опишите действие плана.`;

/**
 * regular — шесть планов и утверждённая трактовка; long — сорок планов с длинными текстами; produced — у M01 и M02 есть
 * принятые материалы; proposal — готовое предложение прохода сценария; noRegistry — трактовка без реестра;
 * loading и loadError — отложенное и ошибочное первое чтение.
 */
export type ScenarioPageVariant = 'regular' | 'long' | 'produced' | 'proposal' | 'noRegistry' | 'loading' | 'loadError';

export interface ScenarioPageOptions {
  variant?: ScenarioPageVariant;
  /** Начальный маршрут демонстрационного роутера, например с ?shot=M03. */
  route?: string;
  /** Планы, для которых под страницей есть демонстрационные ссылки ?shot= (переход на уже открытой странице). */
  links?: string[];
}

const SHOT_SECONDS = 4;
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
    start_frame: index * SHOT_SECONDS * FPS,
    end_frame_exclusive: (index + 1) * SHOT_SECONDS * FPS,
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
    start_frame: index * LONG_SHOT_SECONDS * FPS,
    end_frame_exclusive: (index + 1) * LONG_SHOT_SECONDS * FPS,
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
  return {
    ...base,
    audio: { path: 'source/track.wav', end_seconds: (shots.at(-1)!.end_frame_exclusive / FPS).toFixed(3) },
    sequences: (long ? PARTS : PARTS.slice(0, 3)).map((part) => ({ ...part })),
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
    start: shot.start_frame / FPS,
    end: shot.end_frame_exclusive / FPS - 0.2,
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

function pageView(variant: ScenarioPageVariant): ScenarioView {
  const long = variant === 'long';
  const scenes = pageScenes(long);
  const treatment = pageTreatment(long);
  const duration = scenes.scenes.at(-1)!.end_frame_exclusive / FPS;
  return {
    scenes: variant === 'noRegistry' ? null : scenes,
    treatment,
    cast: pageCast(long),
    timing: pageTiming(duration, variant === 'noRegistry' ? null : scenes, treatment),
    lyrics: scenes.scenes.map((shot, index) => ({ number: index + 1, text: shot.original, header: false })),
    duration,
    trackPath: STORY_TRACK_PATH,
    problems: []
  };
}

/** Каркас по сохранённой трактовке: по одному незаполненному плану на каждые четыре секунды части. */
function scaffoldScenes(treatment: TreatmentFile): ScenesFile {
  const shots: SceneShot[] = [];
  for (const part of treatment.sequences)
    for (let start = part.start; start < part.end - 0.01; start += SHOT_SECONDS) {
      const index = shots.length;
      shots.push({
        id: id(index),
        title: '',
        original: '',
        sequence: part.id,
        start_frame: Math.round(start * FPS),
        end_frame_exclusive: Math.round(Math.min(part.end, start + SHOT_SECONDS) * FPS),
        camera: 'ЗАПОЛНИТЬ: камера',
        action: 'ЗАПОЛНИТЬ: действие',
        continuity: '',
        references: ['hero'],
        lipsync: !!part.lipsync,
        card: { primary_reference: 'hero' },
        state_from: index === 0 ? null : id(index - 1),
        state_changes: {}
      });
    }
  return { ...pageScenes(false), sequences: treatment.sequences.map(({ id: part, title, direction }) => ({ id: part, title, direction })), scenes: shots };
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

/** Упрощённое наследование для витрины: начальное состояние кастинга и изменения по цепочке state_from; полный расчёт остаётся в main. */
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
  const labels: BriefResult['labels'] = {};
  const lines: string[] = [];
  for (const [entity, values] of Object.entries(result.state)) {
    const info = cast?.entities.find((item) => item.id === entity);
    const properties = info ? (cast?.properties[info.kind] ?? []) : [];
    labels[entity] = Object.fromEntries(Object.keys(values).map((key) => [key, properties.find((item) => item.key === key)?.label ?? key]));
    const described = Object.entries(values).map(([key, value]) => `${labels[entity][key].toLowerCase()} — ${value}`);
    if (described.length) lines.push(`${info?.short_name ?? entity}: ${described.join(', ')}.`);
  }
  const paragraph = lines.join(' ');
  return { shot, phase, state: result.state, sources: result.sources, labels, inherited, paragraph, checklist: lines, text: paragraph };
}

interface PageModel {
  saved: ScenarioView;
  workflow: ScenarioWorkflowView;
  links: string[];
  reads: number;
  treatmentSaves: number;
  scenesSaves: ScenesSaveMode[];
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
export function scenarioPageOptions({ variant = 'regular', route = '/project/scenario', links = ['M02', 'M05'] }: ScenarioPageOptions = {}): StoryOptions {
  const state: AppState = {
    packaged: false,
    problems: [],
    toolsRoot: '/mock/songframe',
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
      const produced = new Set(variant === 'produced' ? ['M01', 'M02'] : []);
      const saved = pageView(variant);
      const approved = variant !== 'noRegistry';
      const workflow: ScenarioWorkflowView = {
        project: SCENARIO_PAGE_PROJECT,
        busy: false,
        canStartTreatment: true,
        canStartScenes: approved,
        canRevise: approved && !!saved.scenes,
        canApproveCurrent: !approved,
        canApproveScenes: false,
        treatmentApproved: approved,
        scenesNeedReview: false,
        problems: [],
        proposal: null,
        job: null
      };
      if (variant === 'proposal') {
        workflow.proposal = scenarioProposal('scenes', { before: { cast: saved.cast, treatment: saved.treatment, scenes: saved.scenes } });
        workflow.job = scenarioJob('completed');
      }
      const model: PageModel = {
        saved,
        workflow,
        links,
        reads: 0,
        treatmentSaves: 0,
        scenesSaves: [],
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
      const validate = (project: string): void => {
        if (project !== SCENARIO_PAGE_PROJECT) throw new Error('Неизвестный демонстрационный проект.');
      };
      const snapshot = (): ScenarioWorkflowView => structuredClone(model.workflow);
      const capabilities = (): void => {
        const view = model.workflow;
        Object.assign(view, {
          canStartTreatment: !view.busy,
          canStartScenes: !view.busy && view.treatmentApproved,
          canRevise: !view.busy && view.treatmentApproved && !!model.saved.scenes
        });
      };
      // Как в main: предложение хранит хеши сохранённых документов, любая запись делает неприменённое предложение устаревшим,
      // а утверждение пары включает трактовку и снимается её записью.
      const documentsWritten = (treatment: boolean): void => {
        const view = model.workflow;
        if (view.proposal && view.proposal.status !== 'applied') view.proposal.stale = true;
        if (treatment && view.treatmentApproved) {
          Object.assign(view, { treatmentApproved: false, canApproveCurrent: true, canApproveScenes: false, scenesNeedReview: !!model.saved.scenes });
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
          validateScenes: async (project, scenes) => {
            validate(project);
            return scenes.scenes.filter((shot) => !shot.action.trim()).map((shot) => scenarioPageActionProblem(shot.id));
          },
          saveImpact: async (project, scenes) => {
            validate(project);
            const before = new Map((model.saved.scenes?.scenes ?? []).map((shot) => [shot.id, JSON.stringify(shot)]));
            return {
              shots: scenes.scenes
                .filter((shot) => before.get(shot.id) !== JSON.stringify(shot))
                .map((shot) => ({
                  id: shot.id,
                  reason: 'Изменена собственная постановка плана: действие, камера или состояние героев.',
                  state: produced.has(shot.id) ? 'completed' : 'planned',
                  produced: produced.has(shot.id)
                }))
            };
          },
          saveScenes: async (project, scenes, mode) => {
            validate(project);
            model.scenesSaves.push(mode);
            model.saved.scenes = structuredClone(scenes);
            documentsWritten(false);
            model.publish();
            return structuredClone(scenes);
          },
          saveTreatment: async (project, treatment) => {
            validate(project);
            model.treatmentSaves++;
            model.saved.treatment = structuredClone(treatment);
            documentsWritten(true);
            model.publish();
            return structuredClone(treatment);
          },
          brief: async (project, scenes, shot, phase) => {
            validate(project);
            return pageBrief(scenes, model.saved.cast, shot, phase);
          }
        },
        tools: {
          run: async (project, tool, args = []) => {
            validate(project);
            if (tool !== 'scene_scaffold' || !model.saved.treatment) throw new Error(`Инструмент ${tool} не моделируется на этой странице.`);
            model.scaffolds.push(args);
            model.saved.scenes = scaffoldScenes(model.saved.treatment);
            documentsWritten(false);
            model.publish();
            return { code: 0, stdout: JSON.stringify({ shots: model.saved.scenes.scenes.length }), stderr: '', command: `scene_scaffold ${args.join(' ')}` };
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
              tools: { python: true, providers: {} }
            };
          }
        },
        scenarioWorkflow: {
          view: async (project) => {
            validate(project);
            return snapshot();
          },
          start: async ({ project, pass, note, selectedIds }) => {
            validate(project);
            const view = model.workflow;
            if (view.busy || !(pass === 'treatment' ? view.canStartTreatment : pass === 'scenes' ? view.canStartScenes : view.canRevise))
              throw new Error('Сначала согласуйте входы сценария.');
            model.starts++;
            view.proposal = scenarioProposal(pass, {
              id: `scenario-proposal-${model.starts + 1}`,
              status: 'running',
              selectedIds: selectedIds ?? [],
              before: { cast: model.saved.cast, treatment: model.saved.treatment, scenes: model.saved.scenes },
              after: { cast: null, treatment: null, scenes: null },
              warnings: [],
              message: note ? `Агент дорабатывает план: ${note}` : 'Агент готовит предложение по сохранённым документам.'
            });
            view.job = scenarioJob('running');
            view.busy = true;
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
            // Как в main: трактовка владеет кастингом и трактовкой, сценарий и доработка — только реестром.
            if (proposal.pass === 'treatment') {
              model.saved.cast = structuredClone(proposal.after.cast);
              model.saved.treatment = structuredClone(proposal.after.treatment);
            } else model.saved.scenes = structuredClone(proposal.after.scenes);
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
            Object.assign(model.workflow, { canApproveScenes: false, scenesNeedReview: false });
            model.publish();
            return snapshot();
          }
        },
        agents: {
          cancel: async (jobId) => {
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
          Сохранений трактовки: {model.treatmentSaves}. Сохранений реестра: {model.scenesSaves.length}
          {model.scenesSaves.length ? ` (${model.scenesSaves.join(', ')})` : ''}.
        </Typography>
        <Typography variant="body2" data-testid="page-model-agent">
          Запусков агента: {model.starts}. Применений: {model.applies}. Остановок: {model.cancels}.
        </Typography>
        <Typography variant="body2" data-testid="page-model-scaffold">
          Построений каркаса: {model.scaffolds.length}
          {model.scaffolds.length ? ` (${model.scaffolds.map((args) => args.join(' ')).join('; ')})` : ''}.
        </Typography>
        <Typography variant="body2" data-testid="page-model-logline" sx={{ overflowWrap: 'anywhere' }}>
          Сохранённый логлайн: {model.saved.treatment?.logline}
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
