/** Сценарный проход хранит предложение вне проекта и публикует его только после отдельного Apply. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentJob } from '@shared/agents';
import type { ScenarioDocuments, ScenarioProposal, ScenarioPublication, ScenarioWorkflowStart, ScenarioWorkflowView } from '@shared/scenario-workflow';
import type { ScenesFile, SourceManifest, TimingFile } from '@shared/types';
import type { AgentManager } from './agent-manager';
import { castFromSources, loadDefaults, normalizeCast } from './cast';
import { normalizeTreatment, validateScenes } from './scenario';
import { scenarioOutputPaths } from './scenario-apply';
import { changedSceneIds, checkReadyScenes, checkScenesShape, checkTreatmentCast, isRecord, proposalDocuments } from './scenario-proposal';
import { parseLyricsLines, validateTiming } from './timing';
import { sourceInputDigest, upgradeSourceInputSnapshot } from './source-input-hash';

type Hashes = Record<string, string | null>;
interface StoredProposal {
  proposal: ScenarioProposal;
  expectedHashes: Hashes;
  scaffold: ScenesFile | null;
  duration: number;
}
interface WorkflowState {
  schemaVersion: 1;
  approval?: Hashes;
  scenesApproval?: { hashes: Hashes; sceneHash?: string | null };
  needsScenesReview?: boolean;
  pending?: StoredProposal;
}
interface Options {
  localDir: string;
  agents: Pick<AgentManager, 'start' | 'get' | 'list'>;
  toolsRoot: () => string | null;
  scaffold: (project: string) => Promise<ScenesFile>;
  publish: (input: ScenarioPublication) => Promise<void>;
}
interface Inputs {
  project: string;
  documents: ScenarioDocuments;
  manifest: SourceManifest | null;
  timing: TimingFile | null;
  duration: number | null;
  hashes: Hashes;
  approvalHashes: Hashes;
  problems: string[];
  documentProblems: string[];
  pairValid: boolean;
  scenesValid: boolean;
  scenesReady: boolean;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const json = (project: string, path: string): unknown => (existsSync(join(project, path)) ? JSON.parse(readFileSync(join(project, path), 'utf8')) : null);
const matches = (left: Hashes, right: Hashes): boolean =>
  Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, hash]) => right[key] === hash);
const hash = (project: string, path: string): string | null =>
  path === 'source/manifest.json' ? sourceInputDigest(project) : existsSync(join(project, path)) ? digest(readFileSync(join(project, path))) : null;

/** Локальный JSON может быть повреждён независимо от проектных файлов; такой снимок не даёт approval. */
function checkStoredState(value: unknown): asserts value is WorkflowState {
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every((item) => typeof item === 'string');
  const hashes = (v: unknown): boolean =>
    isRecord(v) &&
    Object.entries(v).every(
      ([path, hash]) =>
        !!path && !isAbsolute(path) && !path.split('/').includes('..') && (hash === null || (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)))
    );
  const documents = (v: unknown): void => {
    if (!isRecord(v)) throw new Error('Неверный снимок документов.');
    if (v.cast !== null) normalizeCast(v.cast, null);
    if (v.treatment !== null) normalizeTreatment(v.treatment, null);
    if (v.scenes !== null) checkScenesShape(v.scenes);
  };
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    (value.approval !== undefined && !hashes(value.approval)) ||
    (value.scenesApproval !== undefined &&
      (!isRecord(value.scenesApproval) ||
        !hashes(value.scenesApproval.hashes) ||
        (value.scenesApproval.sceneHash !== undefined &&
          value.scenesApproval.sceneHash !== null &&
          (typeof value.scenesApproval.sceneHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.scenesApproval.sceneHash))))) ||
    (value.needsScenesReview !== undefined && typeof value.needsScenesReview !== 'boolean')
  )
    throw new Error('Неверная локальная запись сценария.');
  if (value.pending === undefined) return;
  const stored = value.pending;
  if (
    !isRecord(stored) ||
    !hashes(stored.expectedHashes) ||
    typeof stored.duration !== 'number' ||
    !Number.isFinite(stored.duration) ||
    stored.duration <= 0 ||
    !isRecord(stored.proposal)
  )
    throw new Error('Неверная запись предложения.');
  if (stored.scaffold !== null) checkScenesShape(stored.scaffold);
  const proposal = stored.proposal;
  if (
    typeof proposal.id !== 'string' ||
    !proposal.id ||
    typeof proposal.jobId !== 'string' ||
    !proposal.jobId ||
    typeof proposal.pass !== 'string' ||
    !['treatment', 'scenes', 'revise'].includes(proposal.pass) ||
    typeof proposal.status !== 'string' ||
    !['running', 'ready', 'invalid', 'failed', 'interrupted', 'applied'].includes(proposal.status) ||
    !strings(proposal.selectedIds) ||
    !strings(proposal.warnings) ||
    !strings(proposal.changedIds) ||
    typeof proposal.stale !== 'boolean' ||
    (proposal.message !== undefined && typeof proposal.message !== 'string')
  )
    throw new Error('Неверные метаданные предложения.');
  documents(proposal.before);
  documents(proposal.after);
}

export class ScenarioWorkflow {
  // Блокировка покрывает ещё и подготовку scaffold, когда задания AgentManager пока нет.
  private readonly preparing = new Set<string>();
  constructor(private readonly options: Options) {}

  private statePath(project: string): string {
    return join(this.options.localDir, 'scenario-workflow', `${digest(project)}.json`);
  }
  private read(project: string): WorkflowState {
    try {
      const value: unknown = JSON.parse(readFileSync(this.statePath(project), 'utf8'));
      checkStoredState(value);
      for (const hashes of [value.approval, value.scenesApproval?.hashes, value.pending?.expectedHashes]) {
        if (hashes) upgradeSourceInputSnapshot(hashes, project);
      }
      return value;
    } catch {
      /* Повреждённая локальная запись не служит подтверждением и не меняет проект. */
    }
    return { schemaVersion: 1 };
  }
  private write(project: string, state: WorkflowState): void {
    const path = this.statePath(project);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
  }

  /** До замены манифеста сохраняет актуальные старые утверждения без привязки к оформлению. */
  preserveSourceDecoration(project: string): void {
    const resolved = realpathSync(project);
    const path = this.statePath(resolved);
    if (!existsSync(path)) return;
    let previous: unknown;
    try {
      previous = JSON.parse(readFileSync(path, 'utf8'));
      checkStoredState(previous);
    } catch {
      return;
    }
    const next = this.read(resolved);
    if (JSON.stringify(previous) !== JSON.stringify(next)) this.write(resolved, next);
  }

  private inputs(path: string): Inputs {
    const project = realpathSync(path);
    const problems: string[] = [];
    const documentProblems: string[] = [];
    const documents: ScenarioDocuments = { cast: null, treatment: null, scenes: null };
    const paths = new Set([
      'plan/project.json',
      'plan/production-status.json',
      'source/manifest.json',
      'source/track.mp3',
      'source/text.md',
      'source/description.md',
      'plan/audio/timing.json',
      'plan/cast.json',
      'plan/treatment.json',
      'plan/scenes.json',
      ...scenarioOutputPaths(project)
    ]);
    const sourcePath = (path: unknown): string => {
      if (typeof path !== 'string' || !path || isAbsolute(path))
        throw new Error('Не удалось прочитать путь исходного файла. Загрузите его заново на странице «Исходники».');
      const full = resolve(project, 'source', path);
      const local = relative(join(project, 'source'), full);
      if (local.startsWith('..') || isAbsolute(local))
        throw new Error('Исходный файл находится вне папки исходников проекта. Загрузите его заново на странице «Исходники».');
      return `source/${local.split('\\').join('/')}`;
    };
    let manifest: SourceManifest | null = null;
    let timing: TimingFile | null = null;
    let duration: number | null = null;
    try {
      if (!existsSync(join(project, 'plan/project.json'))) throw new Error('Не удалось прочитать настройки проекта. Выберите папку проекта заново.');
      const raw = json(project, 'source/manifest.json');
      if (!isRecord(raw) || raw.schema_version !== 1 || !Array.isArray(raw.references))
        throw new Error('Сведения об исходниках отсутствуют или повреждены. Загрузите трек, текст песни и идею на странице «Исходники».');
      for (const key of ['track', 'lyrics', 'idea'] as const) {
        const source = raw[key];
        if (!isRecord(source) || typeof source.sha256 !== 'string')
          throw new Error('Для сценария нужны трек, текст песни и идея. Загрузите недостающие файлы на странице «Исходники».');
        const path = sourcePath(source.path);
        paths.add(path);
        if (hash(project, path) !== source.sha256) throw new Error(`${path}: файл отсутствует или изменён после загрузки исходников.`);
      }
      for (const reference of raw.references) {
        if (
          !isRecord(reference) ||
          !['id', 'kind', 'name', 'short_name', 'description'].every((key) => typeof reference[key] === 'string') ||
          !Array.isArray(reference.files)
        )
          throw new Error('Сведения об исходном референсе повреждены. Загрузите его заново на странице «Исходники».');
        for (const file of reference.files) {
          if (!isRecord(file) || typeof file.sha256 !== 'string')
            throw new Error('Сведения об исходном изображении повреждены. Загрузите его заново на странице «Исходники».');
          const path = sourcePath(file.path);
          paths.add(path);
          if (hash(project, path) !== file.sha256) throw new Error(`${path}: изображение отсутствует или изменено после загрузки.`);
        }
      }
      manifest = raw as unknown as SourceManifest;
      const rawTiming = json(project, 'plan/audio/timing.json');
      if (
        !isRecord(rawTiming) ||
        rawTiming.version !== 2 ||
        !Array.isArray(rawTiming.lines) ||
        !rawTiming.lines.length ||
        !Array.isArray(rawTiming.sections) ||
        typeof rawTiming.duration_decoded !== 'number' ||
        !Number.isFinite(rawTiming.duration_decoded) ||
        rawTiming.duration_decoded <= 0 ||
        !rawTiming.lines.every(
          (line) =>
            isRecord(line) &&
            Number.isInteger(line.id) &&
            Number.isInteger(line.source_line) &&
            typeof line.start === 'number' &&
            typeof line.end === 'number' &&
            typeof line.verified === 'boolean'
        ) ||
        !rawTiming.sections.every(
          (part) =>
            isRecord(part) &&
            typeof part.name === 'string' &&
            typeof part.start === 'number' &&
            Number.isFinite(part.start) &&
            typeof part.end === 'number' &&
            Number.isFinite(part.end)
        )
      )
        throw new Error('Для сценария нужна разметка строк и длительность трека. На странице «Тайминги» разметьте трек и сохраните результат.');
      timing = rawTiming as unknown as TimingFile;
      duration = timing.duration_decoded;
      const lyrics = parseLyricsLines(readFileSync(join(project, 'source/text.md'), 'utf8'));
      const timingProblems = validateTiming(timing, lyrics, duration);
      if (timing.sha256 !== manifest.track!.sha256) timingProblems.push('Разметка относится к другому треку.');
      if (timing.lines.some((line) => !line.verified)) timingProblems.push('Подтвердите на слух все строки разметки.');
      const covered = new Set(timing.lines.map((line) => line.source_line));
      if (lyrics.some((line) => !line.header && !!line.text.trim() && !covered.has(line.number)))
        timingProblems.push('Разметка должна покрывать все строки песни.');
      if (timingProblems.length) throw new Error(timingProblems.join(' '));
    } catch (error) {
      problems.push(message(error));
    }
    for (const key of ['cast', 'treatment', 'scenes'] as const) {
      try {
        const raw = json(project, `plan/${key}.json`);
        if (raw === null) continue;
        if (key === 'cast') documents.cast = normalizeCast(raw, this.options.toolsRoot());
        else if (key === 'treatment') documents.treatment = normalizeTreatment(raw, duration);
        else {
          checkScenesShape(raw);
          documents.scenes = raw;
        }
      } catch (error) {
        documentProblems.push(`${key}.json: ${message(error)}`);
      }
    }
    let castImagesValid = true;
    for (const entity of documents.cast?.entities ?? []) {
      for (const image of entity.images) {
        try {
          const path = sourcePath(image);
          paths.add(path);
          if (!existsSync(join(project, path))) throw new Error(`${entity.name}: отсутствует ${path}.`);
        } catch (error) {
          castImagesValid = false;
          documentProblems.push(message(error));
        }
      }
    }
    let pairValid = false;
    if (documents.cast && documents.treatment && castImagesValid) {
      try {
        checkTreatmentCast(documents.cast, documents.treatment);
        pairValid = true;
      } catch (error) {
        documentProblems.push(message(error));
      }
    }
    let scenesValid = false;
    let scenesReady = false;
    if (documents.scenes) {
      const sceneProblems = validateScenes(documents.scenes, documents.cast);
      documentProblems.push(...sceneProblems);
      scenesValid = !sceneProblems.length;
      if (scenesValid && documents.cast && duration !== null) {
        try {
          checkReadyScenes(documents.scenes, documents.cast, duration);
          scenesReady = true;
        } catch (error) {
          documentProblems.push(message(error));
        }
      }
    }
    const hashes = Object.fromEntries([...paths].map((path) => [path, hash(project, path)]));
    const approvalHashes = Object.fromEntries(
      Object.entries(hashes).filter(
        ([path]) => path.startsWith('source/') || ['plan/audio/timing.json', 'plan/cast.json', 'plan/treatment.json'].includes(path)
      )
    );
    return { project, documents, manifest, timing, duration, hashes, approvalHashes, problems, documentProblems, pairValid, scenesValid, scenesReady };
  }

  private refresh(inputs: Inputs, state: WorkflowState): AgentJob | null {
    const stored = state.pending;
    if (!stored) return null;
    const proposal = stored.proposal;
    const job = this.options.agents.get(proposal.jobId);
    proposal.stale = proposal.status !== 'applied' && !Object.entries(stored.expectedHashes).every(([path, value]) => hash(inputs.project, path) === value);
    if (proposal.status !== 'running') return job;
    if (!job || job.project !== inputs.project || job.status === 'interrupted') {
      proposal.status = 'interrupted';
      proposal.message = 'Задание прервано; подготовьте новое предложение.';
    } else if (job.status === 'running') return job;
    else if (job.status !== 'completed' || job.exitCode !== 0) {
      proposal.status = 'failed';
      proposal.message = job.message || 'Агент завершил задание без успешного результата.';
    } else {
      try {
        const after = proposalDocuments(
          job.result,
          proposal.pass,
          proposal.before,
          stored.scaffold,
          proposal.selectedIds,
          stored.duration,
          this.options.toolsRoot()
        );
        if (after.cast)
          for (const entity of after.cast.entities)
            for (const image of entity.images) {
              const full = resolve(inputs.project, 'source', image);
              const local = relative(join(inputs.project, 'source'), full);
              if (isAbsolute(image) || local.startsWith('..') || !existsSync(full)) throw new Error(`${entity.name}: отсутствует изображение source/${image}.`);
              // Новое изображение тоже становится входом Apply, даже если его не было в исходной паре.
              const path = `source/${local.split('\\').join('/')}`;
              if (!(path in stored.expectedHashes))
                throw new Error(`${entity.name}: изображение не входило в исходный контекст. Загрузите его в исходники и повторите запрос.`);
            }
        proposal.after = after;
        proposal.changedIds = proposal.pass === 'treatment' ? [] : changedSceneIds(proposal.before, after);
        proposal.warnings =
          after.cast?.entities
            .filter((entity) => entity.kind !== 'world' && !entity.images.length)
            .map((entity) => `${entity.name}: изображение ещё не подготовлено.`) ?? [];
        proposal.status = 'ready';
      } catch (error) {
        proposal.status = 'invalid';
        proposal.message = message(error);
      }
    }
    this.write(inputs.project, state);
    return job;
  }

  view(project: string): ScenarioWorkflowView {
    const input = this.inputs(project);
    const state = this.read(input.project);
    const job = this.refresh(input, state);
    const busy = this.preparing.has(input.project) || this.options.agents.list(input.project).some((job) => job.status === 'running');
    const treatmentApproved = input.pairValid && !input.problems.length && !!state.approval && matches(state.approval, input.approvalHashes);
    const scenesNeedReview =
      !!input.documents.scenes &&
      (!!state.needsScenesReview ||
        (!!state.approval && !treatmentApproved) ||
        (!!state.scenesApproval && !matches(state.scenesApproval.hashes, input.approvalHashes)));
    return {
      project: input.project,
      busy,
      canStartTreatment: !busy && !input.problems.length,
      canStartScenes: !busy && treatmentApproved,
      canRevise: !busy && treatmentApproved && input.scenesValid,
      canApproveScenes: !busy && treatmentApproved && input.scenesReady && scenesNeedReview,
      canApproveCurrent: !busy && !input.problems.length && input.pairValid && !treatmentApproved,
      treatmentApproved,
      scenesNeedReview,
      problems: [...input.problems, ...input.documentProblems],
      proposal: state.pending?.proposal ?? null,
      job
    };
  }

  async start(input: ScenarioWorkflowStart): Promise<ScenarioWorkflowView> {
    if (
      !input ||
      !['treatment', 'scenes', 'revise'].includes(input.pass) ||
      typeof input.project !== 'string' ||
      (input.note !== undefined && typeof input.note !== 'string') ||
      (input.selectedIds !== undefined && (!Array.isArray(input.selectedIds) || !input.selectedIds.every((id) => typeof id === 'string')))
    )
      throw new Error('Неверные параметры сценарного прохода.');
    const initial = this.inputs(input.project);
    const view = this.view(initial.project);
    if (!(input.pass === 'treatment' ? view.canStartTreatment : input.pass === 'scenes' ? view.canStartScenes : view.canRevise))
      throw new Error(view.problems.join(' ') || 'Сначала утвердите актуальные кастинг и трактовку; дождитесь завершения текущего задания.');
    const selectedIds = [...new Set(input.selectedIds ?? [])];
    if (
      input.pass === 'revise' &&
      (!input.note?.trim() || !selectedIds.length || selectedIds.some((id) => !initial.documents.scenes?.scenes.some((scene) => scene.id === id)))
    )
      throw new Error('Для доработки выберите существующий план и заполните замечание.');
    this.preparing.add(initial.project);
    try {
      const toolsRoot = this.options.toolsRoot();
      if (!toolsRoot) throw new Error('Комплекс не найден. Выберите его папку заново.');
      const skill = readFileSync(join(toolsRoot, 'skills/ai-clip-scenario/SKILL.md'), 'utf8');
      const scaffold = input.pass === 'scenes' ? await this.options.scaffold(initial.project) : null;
      if (scaffold) checkScenesShape(scaffold);
      const current = this.inputs(initial.project);
      if (!matches(initial.hashes, current.hashes)) throw new Error('Входные файлы изменились при подготовке задания. Повторите запуск.');
      const seedCast = initial.manifest ? castFromSources(initial.manifest, initial.documents.cast, loadDefaults(toolsRoot)) : null;
      // Обложка оформляет проект и не передаётся агенту как возможный референс сцены.
      // Явный состав сохраняет только исходники сценария и зарегистрированные референсы.
      const { schema_version, kinds, track, lyrics, idea, references } = initial.manifest!;
      const scenarioManifest = { schema_version, kinds, track, lyrics, idea, references };
      const context = JSON.stringify({
        mode: 'proposal',
        pass: input.pass,
        selectedIds,
        idea: readFileSync(join(initial.project, 'source', initial.manifest!.idea!.path), 'utf8'),
        lyrics: readFileSync(join(initial.project, 'source/text.md'), 'utf8'),
        manifest: scenarioManifest,
        timing: initial.timing,
        cast: input.pass === 'treatment' ? seedCast : initial.documents.cast,
        treatment: initial.documents.treatment,
        scenes: input.pass === 'revise' ? initial.documents.scenes : scaffold,
        note: input.note?.trim() || ''
      });
      const prompt =
        `${skill}\n\nРежим приложения: output=proposal, pass=${input.pass}. Верни ровно один JSON без Markdown, без записи файлов и вызовов инструментов производства. ` +
        `Оболочка: {"schemaVersion":1,"pass":"${input.pass}",${input.pass === 'treatment' ? '"cast":{...},"treatment":{...}' : input.pass === 'scenes' ? '"scenes":{...}' : '"patches":[{"id":"выбранный ID",...поля постановки}]'} }. ` +
        `Не меняй source, timing и assets. Конец песни равен timing.duration_decoded. Сохраняй ID, original, sequence и кадровые окна каркаса. ` +
        `Для revise разрешены только title, camera, action, continuity, notes, references, lipsync, card, state_from, state_changes выбранных ID. Не меняй глобальные поля и остальные сцены. Заполни постановку без ЗАПОЛНИТЬ; используй только объявленные изображения и свойства кастинга.`;
      const job = this.options.agents.start({ project: initial.project, task: `ai-clip-scenario:${input.pass}`, prompt, context });
      const proposal: ScenarioProposal = {
        id: randomUUID(),
        jobId: job.id,
        pass: input.pass,
        selectedIds,
        status: 'running',
        warnings: [],
        stale: false,
        before: initial.documents,
        after: initial.documents,
        changedIds: []
      };
      const state = this.read(initial.project);
      state.pending = { proposal, expectedHashes: initial.hashes, scaffold, duration: initial.duration! };
      this.write(initial.project, state);
    } finally {
      this.preparing.delete(initial.project);
    }
    return this.view(initial.project);
  }

  async apply(project: string, id: string): Promise<ScenarioWorkflowView> {
    const view = this.view(project);
    const state = this.read(view.project);
    const pending = state.pending;
    if (view.busy || !pending || pending.proposal.id !== id || pending.proposal.status !== 'ready' || view.proposal?.stale)
      throw new Error('Применимо только завершённое актуальное предложение. Подготовьте новый запрос.');
    const initial = this.inputs(view.project);
    if (pending.proposal.pass !== 'treatment' && !view.treatmentApproved) throw new Error('Утверждение кастинга и трактовки устарело.');
    if (initial.problems.length) throw new Error(initial.problems.join(' '));
    // Повторный разбор берёт успешный результат менеджера, а не доверяет сохранённому preview.
    const job = this.options.agents.get(pending.proposal.jobId);
    if (!job || job.status !== 'completed' || job.exitCode !== 0) throw new Error('Нет успешно завершённого результата агента.');
    const after = proposalDocuments(
      job.result,
      pending.proposal.pass,
      pending.proposal.before,
      pending.scaffold,
      pending.proposal.selectedIds,
      pending.duration,
      this.options.toolsRoot()
    );
    if (!Object.entries(pending.expectedHashes).every(([path, value]) => hash(view.project, path) === value))
      throw new Error('Предложение устарело: изменились файлы проекта.');
    this.preparing.add(view.project);
    try {
      await this.options.publish({
        project: view.project,
        pass: pending.proposal.pass,
        before: pending.proposal.before,
        after,
        expectedHashes: pending.expectedHashes
      });
      const published = this.inputs(view.project);
      if (pending.proposal.pass === 'treatment') {
        state.approval = published.approvalHashes;
        state.needsScenesReview = !!published.documents.scenes;
      } else {
        state.scenesApproval = { hashes: published.approvalHashes, sceneHash: published.hashes['plan/scenes.json'] };
        state.needsScenesReview = false;
      }
      pending.proposal.status = 'applied';
      pending.proposal.after = after;
      this.write(view.project, state);
    } finally {
      this.preparing.delete(view.project);
    }
    return this.view(view.project);
  }

  approveCurrent(project: string): ScenarioWorkflowView {
    const view = this.view(project);
    if (!view.canApproveCurrent) throw new Error(view.problems.join(' ') || 'Нет корректной неутверждённой пары кастинга и трактовки.');
    const input = this.inputs(view.project);
    const state = this.read(view.project);
    if (input.documents.scenes && state.approval && !matches(state.approval, input.approvalHashes)) state.needsScenesReview = true;
    state.approval = input.approvalHashes;
    this.write(view.project, state);
    return this.view(view.project);
  }

  /** Ручная постановка требует собственного явного утверждения после изменения трактовки. */
  approveScenes(project: string): ScenarioWorkflowView {
    const view = this.view(project);
    if (!view.canApproveScenes) throw new Error(view.problems.join(' ') || 'Сначала утвердите актуальную пару и заполните весь сценарий.');
    const input = this.inputs(view.project);
    const state = this.read(view.project);
    state.scenesApproval = { hashes: input.approvalHashes, sceneHash: input.hashes['plan/scenes.json'] };
    state.needsScenesReview = false;
    this.write(view.project, state);
    return this.view(view.project);
  }

  discard(project: string, id: string): ScenarioWorkflowView {
    const input = this.inputs(project);
    const state = this.read(input.project);
    if (!state.pending || state.pending.proposal.id !== id) throw new Error('Предложение больше не найдено.');
    delete state.pending;
    this.write(input.project, state);
    return this.view(input.project);
  }
}
