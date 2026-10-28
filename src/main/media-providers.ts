/** Адаптеры медиа: discovery и локальная подготовка не разрешают платную отправку. Согласования принадлежат Production. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentCheckResult, AgentJob } from '@shared/agents';
import type { MediaArgument, MediaCapabilities, MediaExecutionRef, MediaKind, MediaModel, MediaModelSelection } from '@shared/media-providers';
import type { ProductionImagesInput } from '@shared/production-workflow';
import type { DurationRule } from '@shared/types';
import type { PythonLauncher } from './python-launcher';
import { readKlingCapabilities } from './kling-capabilities';
import { imageDimensions, imageExtensionMatches, type KeyframeImages } from './keyframe-images';

export interface MediaProviderOptions {
  launcher: () => Pick<PythonLauncher, 'run'>;
  cliArgs: () => string[];
  images: KeyframeImages;
  checkCodex: () => Promise<AgentCheckResult>;
  listCodexModels?: () => Promise<MediaModel[]>;
  validateImage?: (path: string) => boolean;
  validateVideo?: (path: string) => boolean;
}
export interface MediaArtifact {
  path: string;
  index: number;
  kind: MediaKind;
  sha256: string;
  frameId?: string;
  width?: number;
  height?: number;
}
export interface PreparedMediaRequest {
  provider: 'kling';
  kind: MediaKind;
  project: string;
  requestDir: string;
  requestSha: string;
  frameId?: string;
}
export interface PrepareKlingInput {
  project: string;
  workDir: string;
  shot: string;
  kind: MediaKind;
  command: string;
  model: string;
  preferredModel?: string | null;
  modelSelection?: MediaModelSelection;
  durationConstraint?: { windowSeconds: number; rule: DurationRule };
  /** Настройки проекта проверяются для объявленных параметров; неподдерживаемые поля не дописываются в запрос. */
  requiredParameters?: Record<string, unknown>;
  projectOptions?: Record<string, unknown>;
  prompt: string;
  parameters: Record<string, unknown>;
  inputs: { flag: string; slot?: string; path: string; role?: string }[];
  outputs: number;
  frameId?: string;
}
export interface PreparedCodexRequest {
  provider: 'codex';
  kind: 'image';
  requestSha: string;
  input: ProductionImagesInput;
  references: { path: string; sha256: string }[];
}
/** Callback предоставляется владельцем cost gate и Jobs; адаптер не создаёт второй журнал отправки. */
export type MediaExecutor = (action: 'submit' | 'resume', request: PreparedMediaRequest) => Promise<void>;
/** Контракт локального Codex: подготовка и отправка отделены от восстановления существующего задания. */
export interface CodexImageProviderContract {
  readonly provider: 'codex';
  readonly kind: 'image';
  capabilities(project: string): Promise<MediaCapabilities>;
  prepare(input: ProductionImagesInput): PreparedCodexRequest;
  submit(prepared: PreparedCodexRequest, permit: { requestSha: string }): MediaExecutionRef;
  collect(reference: Extract<MediaExecutionRef, { provider: 'codex' }>, job: AgentJob): MediaArtifact[];
  collectJob(job: AgentJob): MediaArtifact[];
}

/** Платный lifecycle делегирует submit/resume владельцу согласования и использует прежний frozen request. */
export interface KlingProviderContract {
  readonly provider: 'kling';
  readonly kind: MediaKind;
  capabilities(project: string): Promise<MediaCapabilities>;
  prepare(input: PrepareKlingInput, capabilities: MediaCapabilities): Promise<PreparedMediaRequest>;
  submit(reference: PreparedMediaRequest, execute: MediaExecutor): Promise<MediaExecutionRef>;
  resume(reference: PreparedMediaRequest, execute: MediaExecutor): Promise<MediaExecutionRef>;
  collect(reference: PreparedMediaRequest): MediaArtifact[];
}
export type ImageProvider = CodexImageProviderContract | (KlingProviderContract & { readonly kind: 'image' });
export type VideoProvider = KlingProviderContract & { readonly kind: 'video' };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const fileHash = (path: string): string => hash(readFileSync(path));
const read = (path: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!record(value)) throw new Error('Ожидается JSON-объект медиа.');
  return value;
};
const commands: Record<MediaKind, string[]> = {
  image: ['text_to_image', 'image_to_image'],
  video: ['text_to_video', 'image_to_video', 'omni_ref_video', 'motion_control']
};

function localFile(directory: string, path: string): string {
  const file = resolve(directory, path);
  const inside = relative(realpathSync(directory), realpathSync(file));
  if (
    isAbsolute(inside) ||
    inside === '..' ||
    inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    lstatSync(file).isSymbolicLink() ||
    !lstatSync(file).isFile()
  )
    throw new Error('Нужен локальный файл внутри рабочей папки.');
  return file;
}

function argumentMap(value: unknown): Record<string, MediaArgument> {
  if (
    !record(value) ||
    Object.values(value).some(
      (entry) =>
        !record(entry) ||
        ('required' in entry && typeof entry.required !== 'boolean') ||
        ('allowed' in entry && (!Array.isArray(entry.allowed) || entry.allowed.some((item) => typeof item !== 'string'))) ||
        ('max_items' in entry && (!Number.isInteger(entry.max_items) || Number(entry.max_items) < 1))
    )
  )
    throw new Error('Kling вернул неверное объявление параметров.');
  return value as Record<string, MediaArgument>;
}

/** CLI принимает объявленное MCP-имя и его camelCase; в snapshot оставляем точное имя объявления. */
function argumentName(argumentsMap: Record<string, MediaArgument>, supplied: string): string | undefined {
  const camel = (name: string): string => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return supplied in argumentsMap ? supplied : Object.keys(argumentsMap).find((name) => camel(name) === camel(supplied));
}

/** Эквивалентные имена раскрываем по конкретной модели, не меняя значение требования. */
function parameterName(input: PrepareKlingInput, model: MediaModel, supplied: string): string | undefined {
  return (
    argumentName(model.arguments, supplied) ??
    (input.kind === 'image' && ['resolution', 'img_resolution', 'imgResolution'].includes(supplied)
      ? (argumentName(model.arguments, 'resolution') ?? argumentName(model.arguments, 'img_resolution'))
      : undefined)
  );
}

/** Явные options проекта обязательны; draft может только повторить их, но не заменить другим значением. */
function withProjectOptions(input: PrepareKlingInput, model: MediaModel, parameters: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...parameters };
  for (const [supplied, expected] of Object.entries(input.projectOptions ?? {})) {
    const name = parameterName(input, model, supplied) ?? supplied;
    const matches = Object.keys(merged).filter((key) => (parameterName(input, model, key) ?? key) === name);
    for (const key of matches) {
      if (!isDeepStrictEqual(merged[key], expected))
        throw new Error(`Параметр ${name}=${JSON.stringify(merged[key])} конфликтует с явной настройкой проекта ${JSON.stringify(expected)}.`);
    }
    if (!matches.length) merged[supplied] = expected;
  }
  return merged;
}

/** Старые флаги CLI раскрываем в объявленные слоты до фиксации SHA и показа запроса человеку. */
function normalizeInputs(input: PrepareKlingInput, model: MediaModel): PrepareKlingInput['inputs'] {
  const named = input.inputs.some((item) => item.flag === 'input');
  if (named && input.inputs.some((item) => item.flag !== 'input')) throw new Error('Не смешивайте именованные входы с legacy image/tailImage/audio/video.');
  if (named) return input.inputs.map((item) => ({ ...item }));
  const used = new Set<string>();
  return input.inputs.map((item) => {
    if (item.slot) throw new Error('slot допустим только для именованного входа input.');
    const patterns: Record<string, RegExp> = {
      image: /^(?:first_image|image(?:_\d+)?|keyframe_\d+)$/,
      tailImage: /^tail_image(?:_\d+)?$/,
      audio: /^audio(?:_\d+)?$/,
      video: /^video(?:_\d+)?$/
    };
    const pattern = patterns[item.flag];
    if (!pattern) throw new Error(`Неизвестный флаг входа ${item.flag}.`);
    const candidates = Object.keys(model.slots).filter((slot) => pattern.test(slot));
    const slot = candidates.find((name) => !used.has(name));
    if (slot) {
      used.add(slot);
      return { ...item, flag: 'input', slot };
    }
    if (candidates.length || !argumentName(model.arguments, item.flag))
      throw new Error(`Нет однозначного объявленного слота для ${item.flag}; укажите именованные input slots.`);
    return { ...item };
  });
}

/** Значения ограничений берутся только из переданного snapshot; названия моделей не подменяются алиасами. */
function validateKling(input: PrepareKlingInput, caps: MediaCapabilities): { parameters: Record<string, unknown>; inputs: PrepareKlingInput['inputs'] } {
  if (caps.provider !== 'kling' || caps.kind !== input.kind || !caps.available) throw new Error('Нет подтверждённых возможностей выбранного медиа Kling.');
  const model = caps.models.find((item) => item.command === input.command && item.id === input.model);
  if (!model) throw new Error('Модель не объявлена для выбранной команды.');
  const inputs = normalizeInputs(input, model);
  if (!commands[input.kind].includes(input.command) || !input.prompt.trim() || !Number.isInteger(input.outputs) || input.outputs < 1 || input.outputs > 9)
    throw new Error('Неверная команда, промпт или число результатов.');
  const parameters: Record<string, unknown> = {};
  for (const [supplied, value] of Object.entries(input.parameters)) {
    // Для изображений resolution и img_resolution обозначают одно требование; значение не меняем.
    const name = parameterName(input, model, supplied);
    if (!name || ['prompt', 'model'].includes(name))
      throw new Error(`Параметр ${supplied}=${JSON.stringify(value)} не объявлен для модели или передаётся отдельно.`);
    if (name in parameters) throw new Error(`Параметр ${name} указан дважды.`);
    parameters[name] = value;
  }
  // Проект использует оригиналы без логотипа; старые options не должны разрешить новый запрос с водяным знаком.
  if (parameters.watermark === true || parameters.watermark === 'true') throw new Error('Снимите устаревшую настройку watermark=true.');
  if (model.arguments.watermark) parameters.watermark = false;
  const countParameter = ['image_count', 'imageCount'].find((name) => name in model.arguments);
  if (!countParameter && input.outputs !== 1) throw new Error(`Модель не объявляет выбор числа результатов outputs=${input.outputs}.`);
  if (countParameter && !(countParameter in parameters)) parameters[countParameter] = input.outputs;
  const values: Record<string, unknown> = { ...parameters, prompt: input.prompt, model: input.model };
  for (const [name, value] of Object.entries(parameters)) {
    if (['imageCount', 'image_count'].includes(name) && String(value) !== String(input.outputs))
      throw new Error('Число outputs отличается от параметра количества изображений.');
  }
  for (const [supplied, expected] of Object.entries(input.requiredParameters ?? {})) {
    const name = argumentName(model.arguments, supplied);
    if (name && parameters[name] !== expected)
      throw new Error(`Параметр ${name}=${JSON.stringify(parameters[name])} должен совпадать с настройкой проекта ${JSON.stringify(expected)}.`);
  }
  const assigned = new Map<string, number>();
  for (const item of inputs) {
    const name = item.flag === 'input' ? item.slot : argumentName(model.arguments, item.flag);
    if (!name || (item.flag !== 'input' && item.slot)) throw new Error('Неверный именованный вход.');
    const declaration = item.flag === 'input' ? model.slots[name] : model.arguments[name];
    if (!declaration) throw new Error(`Вход ${name} не объявлен для выбранной команды.`);
    assigned.set(name, (assigned.get(name) ?? 0) + 1);
    if (assigned.get(name)! > (declaration.max_items ?? 1)) throw new Error(`Превышено число входов ${name}.`);
    if (/^https?:/i.test(item.path)) throw new Error('Подготовка принимает только локальные входы.');
    const path = resolve(input.project, item.path);
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Вход недоступен: ${item.path}`);
  }
  for (const [name, declaration] of Object.entries(model.slots)) {
    if (declaration.required && !assigned.has(name)) throw new Error(`Не заполнен обязательный слот ${name}.`);
  }
  for (const [name, declaration] of Object.entries(model.arguments)) {
    const value = values[name];
    if (declaration.required && value === undefined && !assigned.has(name) && declaration.default === undefined)
      throw new Error(`Не заполнен обязательный параметр ${name}.`);
    if (value === undefined) continue;
    const items = Array.isArray(value) ? value : [value];
    if (declaration.allowed && items.some((entry) => !declaration.allowed!.includes(String(entry))))
      throw new Error(`Параметр ${name} имеет неподдерживаемое значение ${JSON.stringify(value)}; допустимо: ${declaration.allowed.join(', ')}.`);
    if (declaration.max_items !== undefined && items.length > declaration.max_items) throw new Error(`Превышено число элементов ${name}.`);
  }
  const constraint = input.durationConstraint;
  if (constraint) {
    const duration = model.arguments.duration;
    const supported = duration?.allowed
      ?.map(Number)
      .filter(
        (seconds) =>
          Number.isInteger(seconds) &&
          (constraint.rule === 'exact_window'
            ? seconds === constraint.windowSeconds
            : constraint.rule === 'min_supported_not_less_than_window'
              ? seconds >= constraint.windowSeconds
              : seconds > constraint.windowSeconds)
      );
    // Согласованную длительность не уменьшаем ради модели; правило проверяем для каждого кандидата.
    if (!supported?.length || Number(parameters.duration) !== Math.min(...supported))
      throw new Error(
        `Длительность duration=${JSON.stringify(parameters.duration)} должна быть ближайшей поддерживаемой по правилу ${constraint.rule} для окна ${constraint.windowSeconds} с${supported?.length ? `: ${Math.min(...supported)} с` : '; подходящие длительности не объявлены'}.`
      );
  }
  const limit = model.limits.combined_item_cap;
  if (limit !== undefined && (!record(limit) || !Number.isInteger(limit.maxItems) || Number(limit.maxItems) < 1))
    throw new Error('Общий лимит модели объявлен в неизвестном формате.');
  if (record(limit) && typeof limit.maxItems === 'number') {
    const names = Array.isArray(limit.arguments) ? limit.arguments : [];
    const argumentNames = new Set(names.filter((name): name is string => typeof name === 'string'));
    const prefixes = Array.isArray(limit.inputPrefixes) ? limit.inputPrefixes : [];
    const count =
      names.reduce<number>((total, name) => {
        const value = values[String(name)];
        return total + (value === undefined ? 0 : Array.isArray(value) ? value.length : 1);
      }, 0) +
      // Один файловый вход учитывается один раз, даже если подходит и по argument, и по prefix.
      [...assigned].reduce(
        (total, [name, count]) =>
          total + (argumentNames.has(name) || prefixes.some((prefix) => typeof prefix === 'string' && name.startsWith(prefix)) ? count : 0),
        0
      );
    if (count > limit.maxItems) throw new Error('Превышен общий лимит входных материалов модели.');
  }
  return { parameters, inputs };
}

/** Проверяем весь запрос для каждой модели до записи попытки; предпочтение не ограничивает совместимый выбор. */
export function selectKlingRequest(
  input: PrepareKlingInput,
  caps: MediaCapabilities,
  candidateParameters: (model: MediaModel) => Record<string, unknown> = () => input.parameters
): PrepareKlingInput & { modelSelection: MediaModelSelection } {
  if (caps.provider !== 'kling' || caps.kind !== input.kind || !caps.available) throw new Error('Нет подтверждённых возможностей выбранного медиа Kling.');
  const preferredModel = (input.preferredModel === undefined ? input.model : input.preferredModel)?.trim() || null;
  const models = caps.models.filter((model) => model.command === input.command);
  const ids = [...new Set([preferredModel, input.model.trim(), ...models.map((model) => model.id)].filter((id): id is string => !!id))];
  const failures = new Map<string, string>();
  for (const id of ids) {
    const model = models.find((model) => model.id === id);
    try {
      if (!model) throw new Error(`Модель ${id} не объявлена для команды ${input.command}.`);
      const candidate = { ...input, model: id, parameters: withProjectOptions(input, model, candidateParameters(model)) };
      const normalized = validateKling(candidate, caps);
      const previous = input.modelSelection;
      const reason =
        previous?.selectedModel === id && previous.preferredModel === preferredModel
          ? previous.reason
          : preferredModel === id
            ? `Предпочтительная модель ${id} поддерживает все параметры запроса.`
            : preferredModel
              ? `Предпочтительная модель ${preferredModel} не подходит: ${failures.get(preferredModel)} Выбрана совместимая модель ${id}.`
              : `Предпочтительная модель не задана. Выбрана совместимая модель ${id}${id === input.model ? ', указанная в запросе' : ''}.`;
      return { ...candidate, ...normalized, preferredModel, modelSelection: { preferredModel, selectedModel: id, reason } };
    } catch (error) {
      failures.set(id, error instanceof Error ? error.message : String(error));
    }
  }
  const details = [...failures].map(([id, reason]) => `${id}: ${reason}`).join(' ');
  throw new Error(`Нет совместимой модели Kling для команды ${input.command}. ${details || 'Аккаунт не объявляет модели этой команды.'}`);
}

class KlingMediaProvider implements KlingProviderContract {
  readonly provider = 'kling';
  constructor(
    readonly kind: MediaKind,
    protected readonly options: MediaProviderOptions
  ) {}

  async capabilities(project: string): Promise<MediaCapabilities> {
    let models: MediaModel[] = [];
    const problems: string[] = [];
    try {
      const batch = await readKlingCapabilities(this.options.launcher(), project, this.options.cliArgs(), commands[this.kind]);
      const reports = new Map(batch.reports.map((entry) => [entry.command, entry]));
      const failures = new Map(batch.problems.map((entry) => [entry.command, entry.message]));
      for (const command of commands[this.kind]) {
        if (failures.has(command)) {
          problems.push(`${command}: ${failures.get(command)}`);
          continue;
        }
        try {
          const report = reports.get(command)!;
          if (!record(report.models)) throw new Error('Kling вернул неверное объявление моделей.');
          const commandModels: MediaModel[] = Object.entries(report.models).map(([id, value]) => {
            if (!record(value) || !record(value.limits)) throw new Error('Kling вернул неверное объявление модели.');
            return { id, command, arguments: argumentMap(value.arguments), slots: argumentMap(value.slots), limits: value.limits };
          });
          models.push(...commandModels);
          if (!commandModels.length) problems.push(`${command}: модели аккаунта не объявлены.`);
        } catch (error) {
          problems.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      // Общий сбой discovery не выдаём за отдельные отказы каждой команды.
      models = [];
      problems.splice(0, problems.length, error instanceof Error ? error.message : String(error));
    }
    return {
      provider: 'kling',
      kind: this.kind,
      available: models.length > 0,
      checkedAt: new Date().toISOString(),
      models,
      problems,
      generationVerified: false
    };
  }

  async prepare(input: PrepareKlingInput, capabilities: MediaCapabilities): Promise<PreparedMediaRequest> {
    if (input.kind !== this.kind) throw new Error('Исполнитель не соответствует виду медиа.');
    input = selectKlingRequest(input, capabilities);
    const { parameters, inputs } = input;
    const directory = mkdtempSync(join(tmpdir(), 'songframe-media-prepare-'));
    try {
      writeFileSync(join(directory, 'prompt.txt'), input.prompt, 'utf8');
      const spec = {
        schema_version: 1,
        provider: this.provider,
        shot: input.shot,
        kind: input.kind,
        command: input.command,
        model: input.model,
        model_selection: input.modelSelection,
        parameters,
        outputs: input.outputs,
        inputs: inputs.map((item) => ({ ...item, path: resolve(input.project, item.path) })),
        prompt_file: 'prompt.txt'
      };
      const specPath = join(directory, 'spec.json');
      writeFileSync(specPath, JSON.stringify(spec), 'utf8');
      const requestDir = resolve(input.project, input.workDir);
      const result = await this.options.launcher().run(input.project, 'kling_request', ['prepare', '--request', specPath, '--work-dir', requestDir]);
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'Не удалось подготовить запрос Kling.');
      const prepared: unknown = JSON.parse(result.stdout);
      if (!record(prepared) || typeof prepared.request_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(prepared.request_sha256))
        throw new Error('Подготовка не вернула SHA запроса.');
      const reference: PreparedMediaRequest = {
        provider: 'kling',
        kind: this.kind,
        project: realpathSync(input.project),
        requestDir,
        requestSha: prepared.request_sha256,
        ...(input.frameId ? { frameId: input.frameId } : {})
      };
      this.verify(reference);
      return reference;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  protected verify(reference: PreparedMediaRequest): { request: Record<string, unknown>; attempt: Record<string, unknown> } {
    if (reference.provider !== 'kling' || reference.kind !== this.kind) throw new Error('Исполнитель не соответствует подготовленному запросу.');
    const request = read(join(reference.requestDir, 'request.json'));
    const attempt = read(join(reference.requestDir, 'attempt.json'));
    if (
      request.kind !== this.kind ||
      attempt.request_sha256 !== reference.requestSha ||
      fileHash(join(reference.requestDir, 'request.json')) !== reference.requestSha
    )
      throw new Error('Подготовленный запрос изменён или относится к другому медиа.');
    if (!record(request.prompt) || !Array.isArray(request.inputs)) throw new Error('Повреждены входы подготовленного запроса.');
    for (const item of [request.prompt, ...request.inputs]) {
      if (
        !record(item) ||
        typeof item.path !== 'string' ||
        typeof item.sha256 !== 'string' ||
        fileHash(localFile(reference.requestDir, item.path)) !== item.sha256
      )
        throw new Error('Промпт или вход изменён: требуется новая подготовка.');
    }
    return { request, attempt };
  }

  async submit(reference: PreparedMediaRequest, execute: MediaExecutor): Promise<MediaExecutionRef> {
    const { attempt } = this.verify(reference);
    if (attempt.status !== 'prepared' || attempt.generation_id) throw new Error('Эта попытка уже отправлялась; продолжите её через resume.');
    await execute('submit', reference);
    return { provider: 'kling', kind: this.kind, requestDir: reference.requestDir, requestSha: reference.requestSha };
  }

  async resume(reference: PreparedMediaRequest, execute: MediaExecutor): Promise<MediaExecutionRef> {
    this.verify(reference);
    await execute('resume', reference);
    return { provider: 'kling', kind: this.kind, requestDir: reference.requestDir, requestSha: reference.requestSha };
  }

  collect(reference: PreparedMediaRequest): MediaArtifact[] {
    const { request, attempt } = this.verify(reference);
    if (attempt.status !== 'downloaded' || !Array.isArray(attempt.downloads) || attempt.downloads.length !== request.outputs)
      throw new Error('Оригиналы ещё не сохранены полностью.');
    const indices = new Set<number>();
    return attempt.downloads
      .map((value) => {
        if (
          !record(value) ||
          typeof value.path !== 'string' ||
          !Number.isInteger(value.number) ||
          Number(value.number) < 1 ||
          Number(value.number) > Number(request.outputs) ||
          indices.has(Number(value.number))
        )
          throw new Error('Повреждён список оригиналов.');
        indices.add(Number(value.number));
        const path = localFile(reference.requestDir, value.path);
        if (lstatSync(path).size !== value.bytes) throw new Error('Сохранённый оригинал изменён.');
        const sha256 = fileHash(path);
        if (typeof value.sha256 === 'string' && value.sha256 !== sha256) throw new Error('Хеш оригинала отличается от сохранённого.');
        const dimensions = this.kind === 'image' ? imageDimensions(path) : null;
        if (this.kind === 'image' && (!dimensions || (this.options.validateImage && !this.options.validateImage(path))))
          throw new Error('Результат не является изображением с корректными размерами.');
        if (this.kind === 'image' && !imageExtensionMatches(path))
          throw new Error('Расширение оригинала не соответствует фактическому формату изображения. Исходный файл сохранён.');
        if (this.kind === 'video') {
          const header = readFileSync(path).subarray(0, 16);
          if (header.length < 12 || header.toString('ascii', 4, 8) !== 'ftyp' || (this.options.validateVideo && !this.options.validateVideo(path)))
            throw new Error('Результат не является корректным видео MP4.');
        }
        return {
          path,
          index: Number(value.number),
          kind: this.kind,
          sha256,
          ...(dimensions ?? {}),
          ...(reference.frameId ? { frameId: reference.frameId } : {})
        };
      })
      .sort((a, b) => a.index - b.index);
  }
}

export class KlingImageProvider extends KlingMediaProvider implements KlingProviderContract {
  declare readonly kind: 'image';
  constructor(options: MediaProviderOptions) {
    super('image', options);
  }
}
export class KlingVideoProvider extends KlingMediaProvider implements KlingProviderContract {
  declare readonly kind: 'video';
  constructor(options: MediaProviderOptions) {
    super('video', options);
  }
}

export class CodexImageProvider implements CodexImageProviderContract {
  readonly provider = 'codex';
  readonly kind = 'image';
  private readonly submittedRequests = new WeakSet<PreparedCodexRequest>();
  private readonly consumedPermits = new WeakSet<{ requestSha: string }>();

  constructor(private readonly options: MediaProviderOptions) {}

  async capabilities(_project: string): Promise<MediaCapabilities> {
    let available = false;
    let models: MediaModel[] = [];
    const problems: string[] = [];
    try {
      const diagnostic = await this.options.checkCodex();
      available = diagnostic.availability === 'available' && diagnostic.authorization !== 'unauthenticated';
      if (!available || diagnostic.authorization === 'unknown') problems.push(diagnostic.message);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    if (available && this.options.listCodexModels) {
      try {
        models = await this.options.listCodexModels();
        if (!models.length) problems.push('Codex не вернул доступные модели агента.');
      } catch {
        problems.push('Каталог моделей агента Codex сейчас недоступен. Повторите проверку возможностей.');
      }
    }
    // Непроверенная генерация отражена generationVerified; это справка, а не ошибка успешной диагностики CLI.
    return { provider: 'codex', kind: 'image', available, checkedAt: new Date().toISOString(), models, problems, generationVerified: false };
  }

  prepare(input: ProductionImagesInput): PreparedCodexRequest {
    const frozen = structuredClone(input);
    frozen.project = realpathSync(input.project);
    if (!frozen.frames.length || frozen.frames.some((frame) => !/^K\d{2}$/.test(frame.id) || !frame.prompt.trim()))
      throw new Error('Сначала подготовьте описания опор.');
    const references = [...new Set(frozen.frames.flatMap((frame) => frame.referencePaths))].map((path) => {
      const file = localFile(frozen.project, path);
      if (!imageDimensions(file)) throw new Error('Референс не является изображением.');
      return { path: file, sha256: fileHash(file) };
    });
    const requestSha = hash(JSON.stringify({ input: frozen, references }));
    return { provider: 'codex', kind: 'image', requestSha, input: frozen, references };
  }

  submit(prepared: PreparedCodexRequest, permit: { requestSha: string }): MediaExecutionRef {
    if (this.submittedRequests.has(prepared) || this.consumedPermits.has(permit))
      throw new Error('Эта подготовка или подтверждение уже использованы. Для нового запуска подготовьте и подтвердите новый запрос.');
    if (
      prepared.provider !== 'codex' ||
      prepared.kind !== 'image' ||
      permit.requestSha !== prepared.requestSha ||
      this.prepare(prepared.input).requestSha !== prepared.requestSha
    )
      throw new Error('Запрос или референсы изменились после согласования.');
    // Подтверждение расходуется до запуска: исключение start не разрешает неявный повтор.
    // Новые prepared/permit допускают отдельно согласованную генерацию тех же входов и SHA.
    this.submittedRequests.add(prepared);
    this.consumedPermits.add(permit);
    const job = this.options.images.start(prepared.input, prepared.requestSha);
    return { provider: 'codex', kind: 'image', requestSha: prepared.requestSha, agentJobId: job.id };
  }

  collect(reference: Extract<MediaExecutionRef, { provider: 'codex' }>, job: AgentJob): MediaArtifact[] {
    if (job.id !== reference.agentJobId) throw new Error('Неверное задание для согласованного запроса.');
    return this.options.images.collect(job, reference.requestSha).map((candidate, index) => ({
      path: candidate.path,
      index: index + 1,
      frameId: candidate.id,
      kind: 'image',
      sha256: fileHash(candidate.path),
      ...imageDimensions(candidate.path)!
    }));
  }

  /** Старые задания собираются без заявления о frozen SHA; новые восстанавливают ref из image-jobs/job.json. */
  collectJob(job: AgentJob): MediaArtifact[] {
    const requestSha = this.options.images.getRequestSha(job);
    if (requestSha !== null) return this.collect({ provider: 'codex', kind: 'image', requestSha, agentJobId: job.id }, job);
    return this.options.images.collect(job).map((candidate, index) => ({
      path: candidate.path,
      index: index + 1,
      frameId: candidate.id,
      kind: 'image',
      sha256: fileHash(candidate.path),
      ...imageDimensions(candidate.path)!
    }));
  }
}
