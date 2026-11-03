/** Общие JSON fixtures проверяются Go-маршалингом и рабочими адаптерами TS на одной границе. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '@shared/types';
import type { ProjectSnapshot } from '@shared/workspace';
import { installApi } from './api';
import { parseSnapshot, workspaceBridge } from './workspace';

/** Форма тестового контейнера не заменяет runtime-проверку DTO в настоящих native adapters. */
interface ContractFixtures {
  appStates: { id: string; expected: AppState }[];
  snapshots: { id: string; files: Record<string, string>; expected: ProjectSnapshot }[];
}
const fixtures: ContractFixtures = JSON.parse(readFileSync(new URL('../../../testdata/contracts/api.json', import.meta.url), 'utf8'));
const bindings = vi.hoisted(() => ({ State: vi.fn(), Open: vi.fn() }));
vi.mock('../../bindings/songframe-go/internal/app/shellservice', () => ({ State: bindings.State }));
vi.mock('../../bindings/songframe-go/internal/app/projectservice', () => ({ Open: bindings.Open }));

/** Подменяется только generated binding: createApi/parseSnapshot и перевод ошибок остаются настоящими. */
describe('Общие контракты Go ↔ TS', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    bindings.State.mockReset();
    bindings.Open.mockReset();
    installApi();
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(fixtures.appStates)('AppState $id проходит native boundary без изменения null/массивов/UTF-8', async ({ expected }) => {
    const raw = structuredClone(expected);
    bindings.State.mockResolvedValue(raw);
    await expect(window.api.app.state()).resolves.toStrictEqual(expected);
    expect(raw).toStrictEqual(expected);
    expect(bindings.State).toHaveBeenCalledOnce();
  });

  it.each(fixtures.snapshots)('Snapshot $id проходит parser и native boundary без нормализации данных', async ({ expected }) => {
    const raw = structuredClone(expected);
    expect(parseSnapshot(raw)).toStrictEqual(expected);
    bindings.Open.mockResolvedValue(raw);
    await expect(workspaceBridge.openProject(expected.path)).resolves.toStrictEqual(expected);
    expect(bindings.Open).toHaveBeenCalledExactlyOnceWith(expected.path);
    expect(raw).toStrictEqual(expected);
  });

  it('сохраняет ручные секунды, отсутствие optional-полей и неизвестные поля исходного документа', async () => {
    const fixture = fixtures.snapshots.find(({ id }) => id === 'manual-unicode-unknown')!;
    bindings.Open.mockResolvedValue(structuredClone(fixture.expected));
    const snapshot = await workspaceBridge.openProject(fixture.expected.path);
    const originalTiming = JSON.parse(fixture.files['plan/audio/timing.json']);
    expect(snapshot.timing).toStrictEqual(originalTiming);
    expect(snapshot.timing!.lines[0]).toMatchObject({ start: 0.123456789, end: 1.987654321, verified: true });
    expect(snapshot.timing!.lines[1]).not.toHaveProperty('verified');
    expect(snapshot.timing!.lines[1]).not.toHaveProperty('note');
  });

  it('не подставляет пустые значения вместо отсутствующих обязательных nullable-полей', async () => {
    const raw = { ...fixtures.appStates[0].expected } as Partial<AppState>;
    delete raw.current;
    bindings.State.mockResolvedValue(raw);
    await expect(window.api.app.state()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const snapshot = { ...fixtures.snapshots[0].expected } as Partial<ProjectSnapshot>;
    delete snapshot.duration;
    bindings.Open.mockResolvedValue(snapshot);
    await expect(workspaceBridge.openProject('<PROJECT>')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each(['problems', 'history'])('отклоняет null вместо массива AppState.%s', async (field) => {
    bindings.State.mockResolvedValue({ ...fixtures.appStates[0].expected, [field]: null });
    await expect(window.api.app.state()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('не позволяет blocked-снимку выдать частично опубликованный текст', async () => {
    const fixture = fixtures.snapshots.find(({ id }) => id === 'blocked-publishing')!;
    bindings.Open.mockResolvedValue({ ...fixture.expected, lyricsText: 'Частично опубликованный текст' });
    await expect(workspaceBridge.openProject(fixture.expected.path)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
