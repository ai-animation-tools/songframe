import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CastFile, CastView } from '@shared/types';
import { CastPage } from './CastPage';
import { CastEntityCard } from './components/CastEntityCard';
import { ImageGenerateDialog } from '../../components/ImageGenerateDialog';

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
vi.mock('react-router-dom', () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()] }));
vi.mock('../../components/PageLoader', () => ({ usePageLoading: vi.fn() }));
vi.mock('../../state', () => ({
  useApp: () => ({ state: { current: fixture.project }, refresh: fixture.refresh, notify: fixture.notify, describeError: fixture.describeError })
}));

const cast: CastFile = {
  schema_version: 1,
  properties: {},
  entities: [
    { id: 'hero', kind: 'character', name: 'Герой', short_name: '', role: 'Водитель', appearance: 'Красная куртка', images: [], initial_state: {} },
    { id: 'world', kind: 'world', name: 'Мир сцены', short_name: '', role: '', appearance: 'Осень', images: [], initial_state: {} }
  ]
};
const view: CastView = { cast, manifest: null, imagePaths: {}, problems: [] };
const api = { view: vi.fn(), attach: vi.fn(), close: vi.fn() };
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function RenderPage() {
  fixture.stateIndex = fixture.refIndex = 0;
  return nodes(CastPage());
}
function cards() {
  return RenderPage().filter((node) => node.type === CastEntityCard);
}
function generation() {
  const dialog = RenderPage().find((node) => node.type === ImageGenerateDialog);
  if (!dialog) throw new Error('Нет диалога генерации сущности');
  return dialog.props;
}

beforeEach(() => {
  fixture.project = '/project-a';
  fixture.refs = [];
  fixture.states = [null, null, view, JSON.parse(JSON.stringify(cast)), false, null, null];
  vi.clearAllMocks();
  api.view.mockResolvedValue(view);
  api.attach.mockResolvedValue(undefined);
  api.close.mockResolvedValue(undefined);
  vi.stubGlobal('window', { api: { cast: { view: api.view }, referenceImages: { attach: api.attach, close: api.close } } });
});

describe('генерация для сохранённой сущности кастинга', () => {
  it('пустые изображения не мешают генерации сохранённой сущности, включая мир; правки требуют Save', () => {
    expect(cards().map((node) => node.props.generationDisabledReason)).toEqual([null, null]);
    const edited = JSON.parse(JSON.stringify(cast)) as CastFile;
    edited.entities[0].appearance = 'Синяя куртка';
    fixture.states[3] = edited;
    expect(cards().map((node) => node.props.generationDisabledReason)).toEqual([
      'Сначала сохраните правки кастинга, включая новую сущность.',
      'Сначала сохраните правки кастинга, включая новую сущность.'
    ]);
  });

  it('передаёт имя, роль и внешность в промпт и прикрепляет результат только выбранной сущности', async () => {
    (cards()[0].props.onGenerate as () => void)();
    const props = generation();
    expect(props.target).toBe('Герой');
    expect(props.initialPrompt).toBe('Создай изображение референса для музыкального клипа. Объект: Герой.\n\nВодитель\n\nКрасная куртка');
    await (props.onAccepted as (result: { id: string; path: string; prompt: string }) => Promise<void>)({
      id: 'accepted',
      path: '/tmp/full.png',
      prompt: 'Герой'
    });
    expect(api.attach).toHaveBeenCalledExactlyOnceWith('accepted', 'hero');
    expect(api.view).toHaveBeenCalledExactlyOnceWith('/project-a');
    expect(api.close).toHaveBeenCalledExactlyOnceWith('accepted');
    expect(fixture.notify).toHaveBeenCalledWith('Изображение добавлено к сущности и сохранено в исходниках', 'success');
  });

  it('ошибка привязки не закрывает диалог и позволяет повторить тот же accept callback', async () => {
    api.attach.mockRejectedValueOnce(new Error('Не удалось сохранить'));
    (cards()[0].props.onGenerate as () => void)();
    const props = generation();
    const accept = props.onAccepted as (result: { id: string; path: string; prompt: string }) => Promise<void>;
    const result = { id: 'accepted', path: '/tmp/full.png', prompt: 'Герой' };
    await expect(accept(result)).rejects.toThrow('Не удалось сохранить');
    expect(generation().target).toBe('Герой');
    expect(api.close).not.toHaveBeenCalled();
    await accept(result);
    expect(api.attach.mock.calls).toEqual([
      ['accepted', 'hero'],
      ['accepted', 'hero']
    ]);
  });

  it('скрывает диалог при смене проекта и отклоняет callback прежнего объекта', async () => {
    (cards()[0].props.onGenerate as () => void)();
    const props = generation();
    fixture.project = '/project-b';
    expect(RenderPage().some((node) => node.type === ImageGenerateDialog)).toBe(false);
    await expect((props.onAccepted as (result: { id: string; path: string }) => Promise<void>)({ id: 'accepted', path: '/tmp/full.png' })).rejects.toThrow(
      'Проект или референс изменился'
    );
    expect(api.attach).not.toHaveBeenCalled();
  });
});
