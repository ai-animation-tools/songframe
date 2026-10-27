/** Строгая форма ответа агента: пути и технические поля проверяются до изменения пакета. */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ProductionFrameCandidate, ProductionFramePrompt, ProductionPass, ProductionStageProposal } from '@shared/production-workflow';
import type { DurationRule } from '@shared/types';
import type { MediaCapabilities, MediaModel } from '@shared/media-providers';
import { selectKlingRequest } from './media-providers';

export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !value.includes('\0');
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Ответ содержит неизвестные поля.');
}
export function productionPath(root: string, value: string): string {
  if (!text(value)) throw new Error('Нужен путь файла.');
  const full = resolve(root, value);
  const local = relative(root, full);
  if (local === '..' || local.startsWith('../') || isAbsolute(local)) throw new Error(`Путь выходит из проекта: ${value}`);
  // Проверяется и существующий родитель нового файла: ссылка не должна перенаправить запись из проекта.
  let parent = full;
  while (!existsSync(parent)) {
    const next = resolve(parent, '..');
    if (next === parent) throw new Error('Не найден родитель пути.');
    parent = next;
  }
  const actual = relative(realpathSync(root), realpathSync(parent));
  if (actual === '..' || actual.startsWith('../') || isAbsolute(actual)) throw new Error(`Ссылка ведёт за пределы проекта: ${value}`);
  return full;
}
export interface ProposalRules {
  project: string;
  stage: ProductionPass;
  windowSeconds: number;
  durationRule: DurationRule;
  requestSeconds: number | null;
  allowedPaths: string[];
  framePrompts: ProductionFramePrompt[];
}
export function checkDuration(seconds: number, window: number, rule: DurationRule): void {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error('Длительность запроса должна быть положительным целым числом секунд.');
  const valid = rule === 'exact_window' ? seconds === window : rule === 'min_supported_not_less_than_window' ? seconds >= window : seconds > window;
  if (!valid) throw new Error(`Длительность ${seconds} с нарушает правило ${rule} для окна ${window} с.`);
}
export function checkFrameCandidates(value: unknown, prompts: ProductionFramePrompt[]): ProductionFrameCandidate[] {
  if (!Array.isArray(value) || value.length !== prompts.length) throw new Error('Нужно одно изображение для каждой опоры.');
  return value.map((item, index) => {
    if (!record(item)) throw new Error('Неверный кандидат опоры.');
    keys(item, ['id', 'path']);
    if (item.id !== prompts[index].id || !text(item.path) || !isAbsolute(item.path))
      throw new Error('ID и порядок кандидатов должны совпадать с планом опор; нужен абсолютный путь изображения.');
    const path = realpathSync(item.path);
    if (!lstatSync(path).isFile()) throw new Error(`${item.id}: нужен обычный файл изображения.`);
    const bytes = readFileSync(path);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!png && !jpeg && !webp) throw new Error(`${item.id}: требуется PNG, JPEG или WebP.`);
    return { id: item.id as string, path };
  });
}
export function parseProductionProposal(raw: string, rules: ProposalRules): ProductionStageProposal {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.schemaVersion !== 1 || value.stage !== rules.stage) throw new Error('Неверная версия или этап предложения.');
  if (value.stage === 'description') {
    keys(value, ['schemaVersion', 'stage', 'description', 'requestSeconds', 'keyframes']);
    if (
      !text(value.description) ||
      typeof value.requestSeconds !== 'number' ||
      !Array.isArray(value.keyframes) ||
      value.keyframes.length < 2 ||
      value.keyframes.length > 20
    )
      throw new Error('Описание требует текст, длительность и минимум две опоры.');
    checkDuration(value.requestSeconds, rules.windowSeconds, rules.durationRule);
    let previous = -1;
    for (const [index, frame] of value.keyframes.entries()) {
      if (!record(frame)) throw new Error('Неверная структура опоры.');
      keys(frame, ['id', 'role', 'timeSeconds', 'prompt', 'referencePaths']);
      const role = index === 0 ? 'first' : index === value.keyframes.length - 1 ? 'last' : 'middle';
      if (
        frame.id !== `K${String(index + 1).padStart(2, '0')}` ||
        frame.role !== role ||
        typeof frame.timeSeconds !== 'number' ||
        !Number.isFinite(frame.timeSeconds) ||
        frame.timeSeconds <= previous ||
        !text(frame.prompt) ||
        !Array.isArray(frame.referencePaths) ||
        !frame.referencePaths.every((path) => text(path) && /\.(png|jpe?g|webp)$/i.test(path) && rules.allowedPaths.includes(path))
      )
        throw new Error('Неверные ID, роли, порядок, промпт или референсы опор.');
      if (
        (role === 'first' && frame.timeSeconds !== 0) ||
        (role === 'last' && frame.timeSeconds !== value.requestSeconds) ||
        frame.timeSeconds > value.requestSeconds
      )
        throw new Error('Первая опора должна быть на 0, последняя — на границе запроса.');
      previous = frame.timeSeconds;
    }
  } else if (value.stage === 'frames') {
    keys(value, ['schemaVersion', 'stage', 'images']);
    value.images = checkFrameCandidates(value.images, rules.framePrompts);
  } else if (value.stage === 'prompt') {
    keys(value, ['schemaVersion', 'stage', 'prompt']);
    if (!text(value.prompt)) throw new Error('Нужен непустой видеопромпт.');
  } else {
    keys(value, ['schemaVersion', 'stage', 'request']);
    const request = value.request;
    if (!record(request)) throw new Error('Нужна спецификация запроса.');
    keys(request, ['model', 'command', 'parameters', 'inputs', 'outputs']);
    if (
      !text(request.model) ||
      !['text_to_video', 'image_to_video', 'omni_ref_video', 'motion_control'].includes(String(request.command)) ||
      !record(request.parameters) ||
      !Array.isArray(request.inputs) ||
      !Number.isInteger(request.outputs) ||
      Number(request.outputs) < 1 ||
      Number(request.outputs) > 9
    )
      throw new Error('Неверная модель, команда, параметры, входы или число результатов.');
    const reserved = new Set([
      'model',
      'prompt',
      'poll',
      'quiet',
      'q',
      'help',
      'version',
      'base-url',
      'credentials',
      'token',
      'input',
      'image',
      'tailImage',
      'audio',
      'video'
    ]);
    if (
      Object.keys(request.parameters).some(
        (name) => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || reserved.has(name) || /token|credential|password|base_url/i.test(name)
      )
    )
      throw new Error('Недопустимое техническое поле параметров; файлы задаются только через inputs, промпт — сохранённым файлом.');
    if (request.parameters.duration !== rules.requestSeconds) throw new Error('Длительность запроса отличается от согласованного плана опор.');
    if (rules.requestSeconds !== null) checkDuration(rules.requestSeconds, rules.windowSeconds, rules.durationRule);
    for (const input of request.inputs) {
      if (!record(input)) throw new Error('Неверный вход запроса.');
      keys(input, ['flag', 'slot', 'path', 'role']);
      if (
        !['input', 'image', 'tailImage', 'audio', 'video'].includes(String(input.flag)) ||
        !text(input.path) ||
        !rules.allowedPaths.includes(input.path) ||
        (input.slot !== undefined && !text(input.slot)) ||
        (input.role !== undefined && !text(input.role))
      )
        throw new Error('Вход запроса должен ссылаться на объявленный исходник или утверждённую опору.');
      productionPath(rules.project, input.path);
    }
  }
  return value as unknown as ProductionStageProposal;
}

/** Ограничения берутся из свежего объявления аккаунта, без встроенного каталога моделей и длительностей. */
export function checkProductionCapabilities(
  proposal: ProductionStageProposal,
  rules: ProposalRules,
  capabilities: unknown,
  settings: Record<string, unknown>
): void {
  if (proposal.stage !== 'request') return;
  const reports = Array.isArray(capabilities) ? capabilities : [capabilities];
  // Подбираем совместимую модель до проверки предложения, иначе ошибочный выбор агента блокировал бы штатную замену.
  const models: MediaModel[] = reports.flatMap((report) =>
    record(report) && typeof report.command === 'string' && record(report.models)
      ? Object.entries(report.models).flatMap(([id, model]) =>
          record(model) && record(model.arguments)
            ? [
                {
                  id,
                  command: report.command as string,
                  arguments: model.arguments as MediaModel['arguments'],
                  slots: (model.slots ?? {}) as MediaModel['slots'],
                  limits: (model.limits ?? {}) as MediaModel['limits']
                }
              ]
            : []
        )
      : []
  );
  const caps: MediaCapabilities = {
    provider: 'kling',
    kind: 'video',
    available: models.length > 0,
    checkedAt: '',
    models,
    problems: [],
    generationVerified: false
  };
  const selected = selectKlingRequest(
    {
      project: rules.project,
      workDir: rules.project,
      shot: '',
      kind: 'video',
      prompt: 'Проверка совместимости запроса.',
      ...proposal.request,
      preferredModel: typeof settings.model === 'string' ? settings.model : null,
      projectOptions: record(settings.options) ? settings.options : undefined,
      durationConstraint: { windowSeconds: rules.windowSeconds, rule: rules.durationRule },
      requiredParameters: Object.fromEntries(
        ['resolution', 'aspect_ratio'].filter((name) => typeof settings[name] === 'string').map((name) => [name, settings[name]])
      )
    },
    caps
  );
  // Показываем выбранную модель уже в предложении; исходные роли файлов сохраняются до нормализации адаптером.
  proposal.request.model = selected.model;
  proposal.request.parameters = selected.parameters;
}
