/** Единый контракт project_inputs и сохранение настроек без изменений производных файлов. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readProjectSettings, writeProjectSettings } from './checks';
import { animaticProjectInputs, animaticProjectInputsMatch, cardsProjectInputs, cardsProjectInputsMatch } from './project-inputs';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('Python не нужен для сохранения настроек');
  }),
  spawnSync: vi.fn(() => {
    throw new Error('Python не нужен для сохранения настроек');
  })
}));

let project: string;
const initial = { name: 'Клип «Ёж»', animatic_video: 'clip.mp4', generation: null };
const cards = 'plan/animatic/cards/manifest.json';
const animatic = 'plan/animatic/latest/manifest.json';
function write(name: string, value: unknown): void {
  const path = join(project, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-project-inputs-'));
  write('plan/project.json', initial);
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

it('выбирает только действительные входы и сохраняет Unicode без нормализации', () => {
  expect(cardsProjectInputs(initial)).toEqual({ name: initial.name });
  expect(animaticProjectInputs(initial)).toEqual({ name: initial.name, animatic_video: 'clip.mp4' });
  expect(cardsProjectInputsMatch({ name: initial.name }, { ...initial, generation: { image: { provider: 'codex' } }, animatic_video: 'other.mp4' })).toBe(true);
  expect(animaticProjectInputsMatch({ name: initial.name, animatic_video: 'clip.mp4' }, { ...initial, generation: {} })).toBe(true);
  expect(cardsProjectInputsMatch({ name: initial.name }, { ...initial, name: `${initial.name} ` })).toBe(false);
});

it.each([undefined, null, [], {}, { name: 12 }, { name: initial.name, extra: true }])('отвергает неподдерживаемый snapshot карточек %j', (snapshot) => {
  expect(cardsProjectInputsMatch(snapshot, initial)).toBe(false);
});

it.each([undefined, null, [], { name: initial.name }, { ...initial }, { name: initial.name, animatic_video: null }])(
  'отвергает неподдерживаемый snapshot сборки %j',
  (snapshot) => {
    expect(animaticProjectInputsMatch(snapshot, initial)).toBe(false);
  }
);

it('сохраняет настройки без Python и не переписывает производные манифесты', () => {
  write(cards, { project_inputs: { name: initial.name }, custom: 'keep' });
  write(animatic, { project_inputs: { name: initial.name, animatic_video: initial.animatic_video } });
  const before = [cards, animatic].map((name) => readFileSync(join(project, name), 'utf8'));
  const saved = writeProjectSettings(project, { ...readProjectSettings(project), generation: { image: { provider: 'codex' }, video: null } });
  expect(saved.generation?.image?.provider).toBe('codex');
  expect([cards, animatic].map((name) => readFileSync(join(project, name), 'utf8'))).toEqual(before);
  writeProjectSettings(project, { ...readProjectSettings(project), name: 'Другой клип', animaticVideo: 'other.mp4' });
  expect([cards, animatic].map((name) => readFileSync(join(project, name), 'utf8'))).toEqual(before);
});

it('не угадывает входы неполного проекта', () => {
  expect(cardsProjectInputs({ name: 7 })).toBeNull();
  expect(animaticProjectInputs({ name: initial.name })).toBeNull();
  expect(animaticProjectInputsMatch({ name: initial.name, animatic_video: 'clip.mp4' }, { name: initial.name })).toBe(false);
});

it('битые и отсутствующие необязательные квитанции не мешают сохранению проекта', () => {
  write(cards, '{ broken');
  expect(() => writeProjectSettings(project, readProjectSettings(project))).not.toThrow();
  expect(readFileSync(join(project, cards), 'utf8')).toBe('{ broken');
});
