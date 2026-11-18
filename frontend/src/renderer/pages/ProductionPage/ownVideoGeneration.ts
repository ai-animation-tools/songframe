/**
 * Черновик входов генерации своего видео: порядок изображений, их роли и промпт, по которым видео сделано вне приложения.
 * Роли по умолчанию следуют за порядком (первый вход — первый кадр, последний — последний кадр, остальные — промежуточные),
 * пока пользователь не выбрал роль сам. Проверка здесь только объясняет недоступность загрузки; окончательно входы
 * проверяет Go (формат файла, роли, предел числа входов).
 */
import { productionTexts } from '@shared/texts/production';
import type { OwnVideoGeneration, OwnVideoInputRole } from '@shared/types';

const texts = productionTexts.ownVideo.generation;

/** Предел числа входов генерации; тот же предел проверяет Go. */
export const OWN_VIDEO_INPUT_LIMIT = 20;

/** Вход черновика: id строки списка (файл может повторяться — например, один кадр первым и последним), путь и роль. */
export interface OwnVideoDraftInput {
  id: string;
  file: string;
  role: OwnVideoInputRole;
  /** Роль выбрана пользователем и при перестановке не пересчитывается. */
  chosen: boolean;
}

/** Роль по умолчанию для позиции index из count входов. */
export function defaultRole(index: number, count: number): OwnVideoInputRole {
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}

/** Пересчитать роли входов, которые пользователь не выбирал сам, по их текущим позициям. */
export function withDefaultRoles(inputs: OwnVideoDraftInput[]): OwnVideoDraftInput[] {
  return inputs.map((input, index) => (input.chosen ? input : { ...input, role: defaultRole(index, inputs.length) }));
}

/** Переставить вход на offset позиций (−1 — выше, 1 — ниже); за пределы списка не выходит. */
export function moveInput(inputs: OwnVideoDraftInput[], index: number, offset: number): OwnVideoDraftInput[] {
  const target = index + offset;
  if (index < 0 || index >= inputs.length || target < 0 || target >= inputs.length) return inputs;
  const next = [...inputs];
  [next[index], next[target]] = [next[target], next[index]];
  return withDefaultRoles(next);
}

/** Почему черновик нельзя загрузить: роль не на своём месте или слишком много входов; null — можно. */
export function generationProblem(inputs: OwnVideoDraftInput[]): string | null {
  if (inputs.length > OWN_VIDEO_INPUT_LIMIT) return texts.limit({ limit: OWN_VIDEO_INPUT_LIMIT });
  for (const [index, input] of inputs.entries()) {
    const problem = roleProblem(input.role, index, inputs.length);
    if (problem) return problem;
  }
  return null;
}

/** Ошибка роли входа на позиции index из count; null — роль допустима. */
export function roleProblem(role: OwnVideoInputRole, index: number, count: number): string | null {
  if (role === 'first' && index !== 0) return texts.firstNotFirst;
  if (role === 'last' && index !== count - 1) return texts.lastNotLast;
  return null;
}

/** Сведения для Go: пустой раздел — пустой список и пустой промпт, как у видео без генерации. */
export function generationOf(inputs: OwnVideoDraftInput[], prompt: string): OwnVideoGeneration {
  return { inputs: inputs.map(({ file, role }) => ({ file, role })), prompt: prompt.trim() };
}
