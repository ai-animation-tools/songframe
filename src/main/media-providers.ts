/** Общий платный адаптер медиа: discovery и локальная подготовка не разрешают отправку. Согласования принадлежат Production. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  mediaProviderTitle,
  type MediaArgument,
  type MediaCapabilities,
  type MediaKind,
  type MediaModel,
  type MediaModelSelection,
  type MediaProviderId,
  type PaidMediaExecutionRef
} from '@shared/media-providers';
import type { DurationRule } from '@shared/types';
import type { PythonLauncher } from './python-launcher';
import { readMediaCatalog } from './media-catalog';
import { imageDimensions, imageExtensionMatches } from './keyframe-images';
import type { PaidProviderAdapter, PaidRequestRules } from './providers/types';

export interface MediaProviderOptions {
  launcher: () => Pick<PythonLauncher, 'run'>;
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
  provider: MediaProviderId;
  kind: MediaKind;
  project: string;
  requestDir: string;
  requestSha: string;
  frameId?: string;
}
export interface PreparePaidInput {
  project: string;
  workDir: string;
  shot: string;
  kind: MediaKind;
  command: string;
  model: string;
  preferredModel?: string | null;
  modelSelection?: MediaModelSelection;
  /** minSeconds — нижняя граница сверх правила окна (речевой план: минимальная длина звукового входа). */
  durationConstraint?: { windowSeconds: number; rule: DurationRule; minSeconds?: number };
  /** Настройки проекта проверяются для объявленных параметров; неподдерживаемые поля не дописываются в запрос. */
  requiredParameters?: Record<string, unknown>;
  projectOptions?: Record<string, unknown>;
  prompt: string;
  parameters: Record<string, unknown>;
  inputs: { flag: string; slot?: string; path: string; role?: string }[];
  outputs: number;
  frameId?: string;
}
/** Callback предоставляется владельцем cost gate и Jobs; адаптер не создаёт второй журнал отправки. */
export type MediaExecutor = (action: 'submit' | 'resume', request: PreparedMediaRequest) => Promise<void>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const fileHash = (path: string): string => hash(readFileSync(path));
const read = (path: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!record(value)) throw new Error('Ожидается JSON-объект медиа.');
  return value;
};
/** Файл попытки или референс: только обычный файл внутри своей папки, без символических ссылок. */
export function localFile(directory: string, path: string): string {
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

function argumentMap(value: unknown, title: string): Record<string, MediaArgument> {
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
    throw new Error(`${title} вернул неверное объявление параметров.`);
  return value as Record<string, MediaArgument>;
}

/** Объявленное имя параметра и его camelCase-написание равнозначны; в snapshot оставляем точное имя объявления. */
export function argumentName(argumentsMap: Record<string, MediaArgument>, supplied: string): string | undefined {
  const camel = (name: string): string => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return supplied in argumentsMap ? supplied : Object.keys(argumentsMap).find((name) => camel(name) === camel(supplied));
}

/** Эквивалентные имена раскрываем по конкретной модели и синонимам провайдера, не меняя значение требования. */
function parameterName(rules: PaidRequestRules, kind: MediaKind, model: MediaModel, supplied: string): string | undefined {
  const direct = argumentName(model.arguments, supplied);
  if (direct) return direct;
  const synonyms = Object.values(rules.aliases[kind] ?? {}).find((names) => names.includes(supplied));
  return synonyms?.map((name) => argumentName(model.arguments, name)).find((name) => name !== undefined);
}

/** Явные options проекта обязательны; draft может только повторить их, но не заменить другим значением. */
function withProjectOptions(rules: PaidRequestRules, input: PreparePaidInput, model: MediaModel, parameters: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...parameters };
  for (const [supplied, expected] of Object.entries(input.projectOptions ?? {})) {
    const name = parameterName(rules, input.kind, model, supplied) ?? supplied;
    const matches = Object.keys(merged).filter((key) => (parameterName(rules, input.kind, model, key) ?? key) === name);
    for (const key of matches) {
      if (!isDeepStrictEqual(merged[key], expected))
        throw new Error(`Параметр ${name}=${JSON.stringify(merged[key])} конфликтует с явной настройкой проекта ${JSON.stringify(expected)}.`);
    }
    if (!matches.length) merged[supplied] = expected;
  }
  return merged;
}

/** Короткие флаги входов раскрываем в объявленные слоты до фиксации SHA и показа запроса человеку. */
function normalizeInputs(rules: PaidRequestRules, input: PreparePaidInput, model: MediaModel): PreparePaidInput['inputs'] {
  const named = input.inputs.some((item) => item.flag === 'input');
  if (named && input.inputs.some((item) => item.flag !== 'input'))
    throw new Error(`Не смешивайте именованные входы с короткими флагами ${Object.keys(rules.inputFlags).join('/')}.`);
  if (named) return input.inputs.map((item) => ({ ...item }));
  const used = new Set<string>();
  return input.inputs.map((item) => {
    if (item.slot) throw new Error('slot допустим только для именованного входа input.');
    const pattern = Object.hasOwn(rules.inputFlags, item.flag) ? rules.inputFlags[item.flag] : undefined;
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
function validatePaid(
  rules: PaidRequestRules,
  input: PreparePaidInput,
  caps: MediaCapabilities
): { parameters: Record<string, unknown>; inputs: PreparePaidInput['inputs'] } {
  const model = caps.models.find((item) => item.command === input.command && item.id === input.model);
  if (!model) throw new Error('Модель не объявлена для выбранной команды.');
  const inputs = normalizeInputs(rules, input, model);
  if (!input.prompt.trim() || !Number.isInteger(input.outputs) || input.outputs < 1 || input.outputs > 9)
    throw new Error('Неверная команда, промпт или число результатов.');
  const parameters: Record<string, unknown> = {};
  for (const [supplied, value] of Object.entries(input.parameters)) {
    // Синонимы провайдера (например, два написания разрешения) обозначают одно требование; значение не меняем.
    const name = parameterName(rules, input.kind, model, supplied);
    if (!name || ['prompt', 'model'].includes(name))
      throw new Error(`Параметр ${supplied}=${JSON.stringify(value)} не объявлен для модели или передаётся отдельно.`);
    if (name in parameters) throw new Error(`Параметр ${name} указан дважды.`);
    parameters[name] = value;
  }
  // Обязательные значения провайдера (например, оригинал без логотипа) не переопределяются старыми options.
  for (const [name, rule] of Object.entries(rules.enforced)) {
    if (rule.rejected.some((value) => isDeepStrictEqual(parameters[name], value))) throw new Error(rule.message);
    if (model.arguments[name]) parameters[name] = rule.value;
  }
  const countParameter = rules.outputCount.find((name) => name in model.arguments);
  if (!countParameter && input.outputs !== 1) throw new Error(`Модель не объявляет выбор числа результатов outputs=${input.outputs}.`);
  if (countParameter && !(countParameter in parameters)) parameters[countParameter] = input.outputs;
  const values: Record<string, unknown> = { ...parameters, prompt: input.prompt, model: input.model };
  for (const [name, value] of Object.entries(parameters)) {
    if (rules.outputCount.includes(name) && String(value) !== String(input.outputs))
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
          seconds >= (constraint.minSeconds ?? 0) &&
          (constraint.rule === 'exact_window'
            ? seconds === constraint.windowSeconds
            : constraint.rule === 'min_supported_not_less_than_window'
              ? seconds >= constraint.windowSeconds
              : seconds > constraint.windowSeconds)
      );
    // Согласованную длительность не уменьшаем ради модели; правило проверяем для каждого кандидата.
    if (!supported?.length || Number(parameters.duration) !== Math.min(...supported))
      throw new Error(
        `Длительность duration=${JSON.stringify(parameters.duration)} должна быть ближайшей поддерживаемой по правилу ${constraint.rule} для окна ${constraint.windowSeconds} с${constraint.minSeconds ? ` и не короче ${constraint.minSeconds} с` : ''}${supported?.length ? `: ${Math.min(...supported)} с` : '; подходящие длительности не объявлены'}.`
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
export function selectPaidRequest(
  adapter: Pick<PaidProviderAdapter, 'id' | 'rules'>,
  input: PreparePaidInput,
  caps: MediaCapabilities,
  candidateParameters: (model: MediaModel) => Record<string, unknown> = () => input.parameters
): PreparePaidInput & { modelSelection: MediaModelSelection } {
  const title = mediaProviderTitle(adapter.id, adapter.id);
  if (caps.provider !== adapter.id || caps.kind !== input.kind || !caps.available)
    throw new Error(`Нет подтверждённых возможностей выбранного медиа ${title}.`);
  const preferredModel = (input.preferredModel === undefined ? input.model : input.preferredModel)?.trim() || null;
  const models = caps.models.filter((model) => model.command === input.command);
  const ids = [...new Set([preferredModel, input.model.trim(), ...models.map((model) => model.id)].filter((id): id is string => !!id))];
  const failures = new Map<string, string>();
  for (const id of ids) {
    const model = models.find((model) => model.id === id);
    try {
      if (!model) throw new Error(`Модель ${id} не объявлена для команды ${input.command}.`);
      const candidate = { ...input, model: id, parameters: withProjectOptions(adapter.rules, input, model, candidateParameters(model)) };
      const normalized = validatePaid(adapter.rules, candidate, caps);
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
  throw new Error(`Нет совместимой модели ${title} для команды ${input.command}. ${details || 'Аккаунт не объявляет модели этой команды.'}`);
}

/** Общий платный адаптер: lifecycle делегирует submit/resume владельцу согласования и использует прежний frozen request. */
export class PaidMediaProvider {
  readonly provider: MediaProviderId;
  constructor(
    readonly adapter: Pick<PaidProviderAdapter, 'id' | 'rules'>,
    readonly kind: MediaKind,
    protected readonly options: MediaProviderOptions
  ) {
    this.provider = adapter.id;
  }

  private get title(): string {
    return mediaProviderTitle(this.provider, this.provider);
  }

  async capabilities(project: string): Promise<MediaCapabilities> {
    let models: MediaModel[] = [];
    const problems: string[] = [];
    try {
      const batch = await readMediaCatalog(this.options.launcher(), project, this.provider, this.kind);
      problems.push(...batch.problems.map((entry) => `${entry.command}: ${entry.message}`));
      for (const report of batch.reports) {
        const command = report.command;
        try {
          if (!record(report.models)) throw new Error(`${this.title} вернул неверное объявление моделей.`);
          const commandModels: MediaModel[] = Object.entries(report.models).map(([id, value]) => {
            if (!record(value) || !record(value.limits)) throw new Error(`${this.title} вернул неверное объявление модели.`);
            return { id, command, arguments: argumentMap(value.arguments, this.title), slots: argumentMap(value.slots, this.title), limits: value.limits };
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
      provider: this.provider,
      kind: this.kind,
      available: models.length > 0,
      checkedAt: new Date().toISOString(),
      models,
      problems,
      generationVerified: false
    };
  }

  async prepare(input: PreparePaidInput, capabilities: MediaCapabilities): Promise<PreparedMediaRequest> {
    if (input.kind !== this.kind) throw new Error('Исполнитель не соответствует виду медиа.');
    input = selectPaidRequest(this.adapter, input, capabilities);
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
      const result = await this.options.launcher().run(input.project, 'media_request', ['prepare', '--request', specPath, '--work-dir', requestDir]);
      if (result.code !== 0) throw new Error(result.stderr.trim() || `Не удалось подготовить запрос ${this.title}.`);
      const prepared: unknown = JSON.parse(result.stdout);
      if (!record(prepared) || typeof prepared.request_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(prepared.request_sha256))
        throw new Error('Подготовка не вернула SHA запроса.');
      const reference: PreparedMediaRequest = {
        provider: this.provider,
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
    if (reference.provider !== this.provider || reference.kind !== this.kind) throw new Error('Исполнитель не соответствует подготовленному запросу.');
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

  async submit(reference: PreparedMediaRequest, execute: MediaExecutor): Promise<PaidMediaExecutionRef> {
    const { attempt } = this.verify(reference);
    if (attempt.status !== 'prepared' || attempt.generation_id) throw new Error('Эта попытка уже отправлялась; продолжите её через resume.');
    await execute('submit', reference);
    return { provider: this.provider, kind: this.kind, requestDir: reference.requestDir, requestSha: reference.requestSha };
  }

  async resume(reference: PreparedMediaRequest, execute: MediaExecutor): Promise<PaidMediaExecutionRef> {
    this.verify(reference);
    await execute('resume', reference);
    return { provider: this.provider, kind: this.kind, requestDir: reference.requestDir, requestSha: reference.requestSha };
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
