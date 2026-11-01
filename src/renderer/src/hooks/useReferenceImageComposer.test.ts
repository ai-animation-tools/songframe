import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReferenceImageContext, ReferenceImageContextDrafts } from '@shared/reference-image-generation';
import { useReferenceImageComposer } from './useReferenceImageComposer';

const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
  effects: [] as { deps: readonly unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  describeError: (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))
}));
// Стенд исполняет эффекты и поздние ответы чтения, не создавая DOM или настоящий IPC.
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
  useEffect: (effect: () => (() => void) | void, deps: readonly unknown[]) => {
    const index = fixture.effectIndex++;
    const old = fixture.effects[index];
    if (!old || deps.some((value, n) => !Object.is(value, old.deps[n])))
      fixture.pending.push(() => {
        old?.cleanup?.();
        fixture.effects[index] = { deps, cleanup: effect() ?? undefined };
      });
  }
}));
vi.mock('../state', () => ({ useApp: () => ({ describeError: fixture.describeError }) }));
const context: ReferenceImageContext = {
  clipName: 'Название для исключения',
  idea: 'Длинная идея клипа',
  lyrics: '[Куплет 1]\nТекст песни',
  visualStyle: 'Объёмный 3D, мягкий свет'
};
const api = vi.fn();
function RenderHook(drafts?: ReferenceImageContextDrafts, enabled = true, supportNotes = '') {
  fixture.stateIndex = fixture.refIndex = fixture.effectIndex = 0;
  const value = useReferenceImageComposer({ enabled, project: '/project', basePrompt: 'Нарисуй героя.', description: 'Красная куртка', supportNotes, drafts });
  for (const effect of fixture.pending.splice(0)) effect();
  return value;
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return RenderHook();
}
beforeEach(() => {
  fixture.states = [];
  fixture.refs = [];
  fixture.effects = [];
  fixture.pending = [];
  vi.clearAllMocks();
  api.mockResolvedValue(context);
  vi.stubGlobal('window', { api: { referenceImages: { context: api } } });
});

describe('конструктор полного промпта референса', () => {
  it('по умолчанию включает только описание, а визуальные правила и остальные разделы требуют явного выбора', async () => {
    RenderHook();
    const value = await settle();
    expect(value.prompt).toBe('Нарисуй героя.\n\nОписание объекта:\nКрасная куртка');
    for (const hidden of [context.clipName, context.idea, context.lyrics, context.visualStyle]) expect(value.prompt).not.toContain(hidden);
    value.change('visualStyle', true);
    expect(RenderHook().prompt).toContain(`Общие визуальные правила:\n${context.visualStyle}`);
    RenderHook().change('visualStyle', false);
    RenderHook().change('idea', true);
    const changed = RenderHook();
    expect(changed.prompt).toContain(context.idea);
    expect(changed.prompt).not.toContain(context.visualStyle);
    expect(changed.prompt).not.toContain(context.lyrics);
  });

  it('поздний context не перезаписывает ручной текст; переключатели ждут явной пересборки', async () => {
    let finish!: (value: ReferenceImageContext) => void;
    api.mockReturnValueOnce(
      new Promise<ReferenceImageContext>((resolve) => {
        finish = resolve;
      })
    );
    RenderHook().edit('  Ровно мой текст\n');
    expect(RenderHook().ready).toBe(true);
    finish(context);
    await settle();
    expect(RenderHook().prompt).toBe('  Ровно мой текст\n');
    RenderHook().change('lyrics', true);
    expect(RenderHook().prompt).toBe('  Ровно мой текст\n');
    expect(RenderHook().sections.lyrics).toBe(false);
    RenderHook().rebuild();
    expect(RenderHook().manual).toBe(false);
    expect(RenderHook().prompt).toContain('Красная куртка');
    expect(RenderHook().prompt).not.toContain(context.visualStyle);
    expect(RenderHook().prompt).not.toContain('Ровно мой текст');
  });

  it('ошибка optional context оставляет ручной режим, а повтор чтения сохраняет ручные правки', async () => {
    api.mockRejectedValueOnce(new Error('Не прочитан файл песни'));
    RenderHook();
    await settle();
    expect(RenderHook().error).toBe('Не прочитан файл песни');
    expect(RenderHook().ready).toBe(false);
    RenderHook().withoutContext();
    RenderHook().edit('Точный самостоятельный промпт');
    expect(RenderHook().ready).toBe(true);
    RenderHook().retry();
    RenderHook();
    await settle();
    expect(api).toHaveBeenCalledTimes(2);
    expect(RenderHook().error).toBeNull();
    expect(RenderHook().prompt).toBe('Точный самостоятельный промпт');
  });

  it('читает текущие черновики отдельным API и не перечитывает их при каждом render', async () => {
    const drafts = { idea: 'Черновик идеи', lyrics: 'Черновик песни' };
    RenderHook(drafts);
    await new Promise((resolve) => setTimeout(resolve, 0));
    RenderHook({ ...drafts });
    RenderHook({ ...drafts });
    expect(api).toHaveBeenCalledExactlyOnceWith('/project', drafts);
  });

  it('режим обложки не читает контекст референса', () => {
    RenderHook(undefined, false);
    expect(api).not.toHaveBeenCalled();
  });
});

// Ручной итог остаётся окончательным даже после смены списка изображений или позднего чтения контекста.
it('включает примечания только явно и обновляет их при смене опор, сохраняя ручную редактуру', async () => {
  const note = 'Опора 1 (Спереди):\nСохранить лицо';
  RenderHook(undefined, true, note);
  await new Promise((resolve) => setTimeout(resolve, 0));
  let value = RenderHook(undefined, true, note);
  expect(value.sections.supportNotes).toBe(false);
  expect(value.prompt).not.toContain('Сохранить лицо');
  value.change('supportNotes', true);
  value = RenderHook(undefined, true, note);
  expect(value.prompt).toContain('Примечания к выбранным опорам:\n' + note);
  RenderHook(undefined, true, '');
  value = RenderHook(undefined, true, '');
  expect(value.prompt).not.toContain('Сохранить лицо');
  value.edit('  Мой окончательный текст\n');
  RenderHook(undefined, true, note);
  value = RenderHook(undefined, true, note);
  expect(value.prompt).toBe('  Мой окончательный текст\n');
  value.rebuild();
  expect(RenderHook(undefined, true, note).prompt).toContain(note);
  RenderHook(undefined, true, note).change('supportNotes', false);
  expect(RenderHook(undefined, true, note).prompt).not.toContain(note);
});
