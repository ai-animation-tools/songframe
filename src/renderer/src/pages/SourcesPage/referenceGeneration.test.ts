import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourcesView } from '@shared/types';
import { useSourcesForm } from './useSourcesForm';

const fixture = vi.hoisted(() => ({
  project: '/project-a',
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
  notify: vi.fn(),
  refresh: vi.fn(),
  describeError: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useState: (initial: unknown) => {
    const index = fixture.stateIndex++;
    if (!(index in fixture.states)) fixture.states[index] = typeof initial === 'function' ? initial() : initial;
    return [
      fixture.states[index],
      (value: unknown) => {
        fixture.states[index] = typeof value === 'function' ? value(fixture.states[index]) : value;
      }
    ];
  },
  useRef: (initial: unknown) => fixture.refs[fixture.refIndex++] ?? (fixture.refs[fixture.refIndex - 1] = { current: initial }),
  useEffect: vi.fn(),
  useCallback: (value: unknown) => value,
  useMemo: (calculate: () => unknown) => calculate()
}));
vi.mock('../../state', () => ({
  useApp: () => ({ state: { current: fixture.project }, refresh: fixture.refresh, notify: fixture.notify, describeError: fixture.describeError })
}));

const sourceView: SourcesView = {
  manifest: {
    schema_version: 1,
    track: null,
    lyrics: null,
    idea: null,
    cover: null,
    updated_at: '2026-10-30',
    references: [{ id: 'hero', kind: 'character', name: 'Герой', short_name: '', description: 'Красная куртка', prompt: '', files: [] }]
  },
  lyricsText: '',
  ideaText: '',
  coverPath: null,
  referenceFilePaths: {},
  problems: []
};
const api = { view: vi.fn(), save: vi.fn(), close: vi.fn() };
function RenderHook() {
  fixture.stateIndex = fixture.refIndex = 0;
  return useSourcesForm();
}
async function loaded() {
  await RenderHook().retry();
  return RenderHook();
}
function openGeneration(form: ReturnType<typeof RenderHook>) {
  form.referencesProps.onGenerate(form.referencesProps.refs[0].key);
  const props = RenderHook().referenceGenerationProps;
  if (!props) throw new Error('Не открылся диалог референса');
  return props;
}

beforeEach(() => {
  fixture.project = '/project-a';
  fixture.states = [];
  fixture.refs = [];
  vi.clearAllMocks();
  api.view.mockResolvedValue(sourceView);
  api.save.mockResolvedValue(undefined);
  api.close.mockResolvedValue(undefined);
  vi.stubGlobal('window', { api: { sources: { view: api.view, save: api.save }, referenceImages: { close: api.close } } });
});

describe('принятие изображения в форме исходников', () => {
  it('добавляет несколько кандидатов с их промптами, сохраняет вместе с формой и закрывает все сессии после Save', async () => {
    let form = await loaded();
    openGeneration(form).onAccepted({ id: 'first', path: '/tmp/first.png', prompt: 'Красная куртка' });
    form = RenderHook();
    openGeneration(form).onAccepted({ id: 'second', path: '/tmp/second.png', prompt: 'Вид сбоку' });
    form = RenderHook();
    expect(api.save).not.toHaveBeenCalled();
    expect(api.close).not.toHaveBeenCalled();
    expect(form.referencesProps.refs[0].files.map(({ sourcePath, view, prompt }) => ({ sourcePath, view, prompt }))).toEqual([
      { sourcePath: '/tmp/first.png', view: 'full', prompt: 'Красная куртка' },
      { sourcePath: '/tmp/second.png', view: 'other', prompt: 'Вид сбоку' }
    ]);
    await form.save();
    expect(api.save.mock.calls[0][0]).toBe('/project-a');
    expect(api.save.mock.calls[0][1].references[0].files).toEqual([
      { sourcePath: '/tmp/first.png', existingPath: undefined, view: 'full', note: '', prompt: 'Красная куртка' },
      { sourcePath: '/tmp/second.png', existingPath: undefined, view: 'other', note: '', prompt: 'Вид сбоку' }
    ]);
    expect(api.close.mock.calls).toEqual([['first'], ['second']]);
  });

  it('не прикладывает принятый результат A к B и не возвращает старый диалог после A→B→A', async () => {
    const old = openGeneration(await loaded());
    fixture.project = '/project-b';
    expect(RenderHook().referenceGenerationProps).toBeNull();
    expect(() => old.onAccepted({ id: 'old', path: '/tmp/old.png', prompt: 'A' })).toThrow('Проект или референс изменился');
    fixture.project = '/project-a';
    RenderHook();
    expect(() => old.onAccepted({ id: 'old', path: '/tmp/old.png', prompt: 'A' })).toThrow('Проект или референс изменился');
    expect(RenderHook().referencesProps.refs[0].files).toEqual([]);
  });

  it('поздняя ошибка загрузки A не скрывает уже открытый проект B', async () => {
    let reject!: (reason: Error) => void;
    api.view.mockImplementationOnce(
      () =>
        new Promise<SourcesView>((_resolve, fail) => {
          reject = fail;
        })
    );
    const loadingA = RenderHook().retry();
    fixture.project = '/project-b';
    await RenderHook().retry();
    reject(new Error('Ошибка проекта A'));
    await loadingA;
    expect(RenderHook().loadError).toBeNull();
    expect(RenderHook().view).toEqual(sourceView);
  });

  it('сохранение A после переключения не закрывает сессии нового проекта B', async () => {
    let finish!: () => void;
    api.save.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    const savingA = (await loaded()).save();
    fixture.project = '/project-b';
    openGeneration(await loaded()).onAccepted({ id: 'session-b', path: '/tmp/b.png', prompt: 'B' });
    finish();
    await savingA;
    expect(api.close).not.toHaveBeenCalled();
    expect(RenderHook().referencesProps.refs[0].files[0].sourcePath).toBe('/tmp/b.png');
  });
});
