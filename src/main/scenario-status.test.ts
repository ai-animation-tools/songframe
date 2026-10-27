/** Готовность реестра проверяется отдельно от музыки, пакетов, Python и видеоматериалов. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readScenarioRegistry } from './scenario-status';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let project: string;
let path: string;
const scene = { id: 'M01', start_frame: 0, end_frame_exclusive: 30 };

function registry(scenes: unknown[] = [scene]): Record<string, unknown> {
  return { schema_version: 1, fps: 30, scenes };
}

beforeEach(() => {
  project = fs.mkdtempSync(join(tmpdir(), 'songframe-scenario-status-'));
  fs.mkdirSync(join(project, 'plan'));
  path = join(project, 'plan', 'scenes.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('готовность сценария', () => {
  it('отличает отсутствующий файл от недоступного для чтения', () => {
    expect(readScenarioRegistry(project)).toEqual({ status: 'missing', registry: null, sha256: '' });
    fs.mkdirSync(path);
    expect(readScenarioRegistry(project)).toEqual({ status: 'invalid', registry: null, sha256: '' });
  });

  it('принимает минимальный контракт сцен и хеширует те же байты единственного чтения', () => {
    const value = registry([{ ...scene, id: 'M01.2' }]);
    const raw = JSON.stringify(value, null, 2) + '\n';
    fs.writeFileSync(path, raw);
    const read = vi.mocked(fs.readFileSync).mockClear();
    expect(readScenarioRegistry(project)).toEqual({
      status: 'ready',
      registry: value,
      sha256: createHash('sha256').update(raw).digest('hex')
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(path);
  });

  it('различает пустой корректный реестр и повреждённый сценарий', () => {
    const value = registry([]);
    fs.writeFileSync(path, JSON.stringify(value));
    expect(readScenarioRegistry(project)).toMatchObject({ status: 'empty', registry: value });
  });

  it.each([
    ['неверный JSON', '{ сценарий'],
    ['null', 'null'],
    ['массив', '[]'],
    ['строку', '"сценарий"'],
    ['число', '1'],
    ['другую версию', JSON.stringify({ ...registry(), schema_version: 2 })],
    ['отсутствующую версию', JSON.stringify({ fps: 30, scenes: [] })],
    ['другую сетку', JSON.stringify({ ...registry(), fps: 24 })],
    ['отсутствующую сетку', JSON.stringify({ schema_version: 1, scenes: [] })],
    ['отсутствующие сцены', JSON.stringify({ schema_version: 1, fps: 30 })],
    ['объект вместо сцен', JSON.stringify({ ...registry(), scenes: {} })]
  ])('отклоняет %s', (_label, raw) => {
    fs.writeFileSync(path, raw);
    expect(readScenarioRegistry(project)).toEqual({ status: 'invalid', registry: null, sha256: '' });
  });

  it.each([
    ['повтор кода', scene],
    ['неверный код', { ...scene, id: 'сцена' }],
    ['отсутствие кода', { start_frame: 30, end_frame_exclusive: 60 }],
    ['пустой промежуток', { ...scene, id: 'M02', end_frame_exclusive: 0 }],
    ['обратные границы', { ...scene, id: 'M02', start_frame: 60 }],
    ['отрицательный кадр', { ...scene, id: 'M02', start_frame: -1 }],
    ['дробный кадр', { ...scene, id: 'M02', start_frame: 0.5 }],
    ['строковый кадр', { ...scene, id: 'M02', start_frame: '0' }],
    ['неточную границу', { ...scene, id: 'M02', end_frame_exclusive: Number.MAX_SAFE_INTEGER + 1 }],
    ['отсутствующую границу', { id: 'M02', start_frame: 30 }],
    ['не объект', null]
  ])('отклоняет весь реестр, если следующая строка содержит %s', (_label, invalid) => {
    fs.writeFileSync(path, JSON.stringify(registry([scene, invalid])));
    expect(readScenarioRegistry(project)).toEqual({ status: 'invalid', registry: null, sha256: '' });
  });
});
