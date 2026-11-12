/**
 * Черновик своего описания плана: текст, длительность запроса и план опор. Роли и ID опор выводятся из их порядка (K01 — начало,
 * последняя — конец запроса), поэтому пользователь задаёт только время промежуточных опор, промпты и референсы. Промпт
 * опоры необязателен: опору без промпта нельзя создать, её загружают своим файлом. Окончательную
 * проверку выполняет Go теми же правилами, что ответ агента; здесь — только то, что объясняет недоступность «Сохранить и принять».
 */
import type { ProductionFramePrompt, ProductionOwnText } from '@shared/production-workflow';
import { productionTexts } from '@shared/texts/production';

const texts = productionTexts.ownDescriptionDialog;

export interface OwnFrameDraft {
  /** Время промежуточной опоры строкой поля; у первой и последней оно задано границами запроса. */
  time: string;
  prompt: string;
  referencePaths: string[];
}
export interface OwnDescriptionDraft {
  description: string;
  requestSeconds: string;
  frames: OwnFrameDraft[];
}

/** ID опоры по позиции: K01, K02… */
export function frameId(index: number): string {
  return `K${String(index + 1).padStart(2, '0')}`;
}

/** Роль опоры по позиции: одна опора — только начало плана. */
export function frameRole(index: number, count: number): ProductionFramePrompt['role'] {
  return index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle';
}

/** Длительность запроса по умолчанию: наименьшее целое число секунд строго больше окна. */
export function defaultRequestSeconds(window: number): number {
  return Math.floor(window) + 1;
}

/**
 * Начальный черновик: текущее описание попытки и её план опор либо пустое описание с двумя опорами (начало и конец).
 * Речевой план ручной генерации получает одну опору.
 */
export function initialDraft(input: {
  description: string | null | undefined;
  requestSeconds: number | null | undefined;
  framePrompts: ProductionFramePrompt[];
  window: number;
  manual: boolean;
}): OwnDescriptionDraft {
  const seconds = input.requestSeconds ?? defaultRequestSeconds(input.window);
  const frames = input.framePrompts.length
    ? input.framePrompts.map((frame) => ({ time: String(frame.timeSeconds), prompt: frame.prompt, referencePaths: [...frame.referencePaths] }))
    : Array.from({ length: input.manual ? 1 : 2 }, () => ({ time: '', prompt: '', referencePaths: [] }));
  return { description: input.description ?? '', requestSeconds: String(seconds), frames: input.manual ? frames.slice(0, 1) : frames };
}

/** Новая промежуточная опора встаёт перед последней, посередине между соседями; к единственной опоре добавляется конец. */
export function addFrame(draft: OwnDescriptionDraft): OwnDescriptionDraft {
  const frames = [...draft.frames];
  const seconds = Number(draft.requestSeconds);
  if (frames.length < 2) return { ...draft, frames: [...frames, { time: '', prompt: '', referencePaths: [] }] };
  const before = frames.length > 2 ? Number(frames[frames.length - 2].time) : 0;
  const middle = Number.isFinite(seconds) && Number.isFinite(before) ? Math.round(((before + seconds) / 2) * 10) / 10 : '';
  frames.splice(frames.length - 1, 0, { time: String(middle), prompt: '', referencePaths: [] });
  return { ...draft, frames };
}

/** Время опоры по позиции: начало — 0, конец — длительность запроса, промежуточная — значение поля. */
function frameTime(draft: OwnDescriptionDraft, index: number): number {
  const role = frameRole(index, draft.frames.length);
  return role === 'first' ? 0 : role === 'last' ? Number(draft.requestSeconds) : Number(draft.frames[index].time.replace(',', '.'));
}

/** Первая причина, по которой черновик ещё нельзя сохранить; null — можно отдавать на проверку Go. */
export function draftProblem(draft: OwnDescriptionDraft, limit: number): string | null {
  if (!draft.description.trim()) return texts.descriptionRequired;
  const seconds = Number(draft.requestSeconds);
  if (!Number.isInteger(seconds) || seconds <= 0) return texts.secondsInvalid;
  if (draft.frames.length < 1 || draft.frames.length > limit) return texts.limit({ limit });
  for (let index = 0; index < draft.frames.length; index++) {
    const id = frameId(index);
    if (frameRole(index, draft.frames.length) === 'middle') {
      const time = frameTime(draft, index);
      if (!Number.isFinite(time) || time <= frameTime(draft, index - 1) || time >= seconds) return texts.frameTimeInvalid({ id });
    }
  }
  return null;
}

/** Свой текст для Go: ID и роли по порядку, время начала и конца — границы запроса. */
export function ownText(draft: OwnDescriptionDraft): Extract<ProductionOwnText, { stage: 'description' }> {
  return {
    stage: 'description',
    description: draft.description.trim(),
    requestSeconds: Number(draft.requestSeconds),
    keyframes: draft.frames.map((frame, index) => ({
      id: frameId(index),
      role: frameRole(index, draft.frames.length),
      timeSeconds: frameTime(draft, index),
      prompt: frame.prompt.trim(),
      referencePaths: frame.referencePaths
    }))
  };
}
