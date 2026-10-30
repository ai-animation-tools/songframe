import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedShotView } from '@shared/derived-shot';
import type { useDerivedShot } from '../useDerivedShot';
import { derivedActionReasons, recipeDraft } from '../derivedRecipeForm';
import { DerivedShotPanel } from './DerivedShotPanel';

const fixture = vi.hoisted(() => ({ form: null as ReturnType<typeof useDerivedShot> | null, confirmation: null as Record<string, unknown> | null }));
vi.mock('../useDerivedShot', () => ({ useDerivedShot: () => fixture.form }));
// Портал не попадает в SSR; проверяем переданные видимому подтверждению последствия и обычную локальную кнопку.
vi.mock('../../../components/ConfirmationDialog', () => ({
  ConfirmationDialog: (props: Record<string, unknown>) => {
    fixture.confirmation = props;
    return props.open ? createElement('section', null, props.title as ReactNode, props.description as ReactNode) : null;
  }
}));
function view(): DerivedShotView {
  const recipe = { mode: 'fit', start_frame: 0, end_frame_exclusive: 45 } as const;
  return {
    project: '/project',
    shot: 'M02',
    title: 'Цель',
    action: 'Олег <не телепортируется>',
    sourceShot: 'M01',
    sourceTitle: 'Источник',
    sourcePath: '/source.mp4',
    sourceFrames: 300,
    targetFrames: 90,
    recipe,
    job: null,
    problem: null,
    toolsProblem: null,
    hasAsset: false,
    preview: {
      id: 'preview',
      videoPath: '/preview.mp4',
      candidatePath: '/candidate',
      resultToken: 'token',
      recipe,
      frames: 90,
      fresh: true,
      accepted: false,
      problem: null
    }
  };
}
function form(next = view(), busy = false) {
  const draft = recipeDraft(next.recipe);
  fixture.form = {
    view: next,
    draft,
    busy,
    pending: false,
    error: null,
    reasons: derivedActionReasons(next, draft, busy),
    retry: vi.fn(),
    change: vi.fn(),
    reset: vi.fn(),
    save: vi.fn(),
    build: vi.fn(),
    requestAccept: vi.fn(),
    replacement: false,
    closeReplacement: vi.fn(),
    confirmReplacement: vi.fn()
  };
  return fixture.form;
}
function render(): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DerivedShotPanel, { project: '/project', shot: 'M02', onApplied: vi.fn() })));
}
function button(html: string, label: string) {
  const button = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(([markup]) => markup.includes(label));
  if (!button) throw new Error(`Нет кнопки ${label}`);
  return button[0];
}
beforeEach(() => {
  vi.stubGlobal('window', { api: { shell: { fileUrl: (path: string) => `songframe-file://${path}` } } });
  form();
});

afterEach(() => vi.unstubAllGlobals());

describe('панель производного плана', () => {
  it('показывает источник, точную длину, явное замедление и два самостоятельных действия', () => {
    const html = render();
    expect(html).toContain('Источник: M01 · Источник');
    expect(html).toContain('Цель: 90 кадров · 3.000 с · 30 FPS');
    expect(html).toContain('скорость 0.500×. Движение будет замедлено.');
    expect(html).toContain('Олег &lt;не телепортируется&gt;');
    expect(html).toContain('aria-label="Принятый клип источника"');
    expect(html).toContain('aria-label="Предпросмотр производного плана"');
    expect(html).toContain('src="songframe-file:///source.mp4"');
    expect(html).toContain('src="songframe-file:///preview.mp4"');
    expect(button(html, 'Собрать заново')).not.toContain('disabled=""');
    expect(button(html, 'Принять результат')).not.toContain('disabled=""');
    expect(html).not.toContain('Codex');
    expect(html).not.toContain('Claude');
    expect(fixture.form!.build).not.toHaveBeenCalled();
    expect(fixture.form!.requestAccept).not.toHaveBeenCalled();
  });

  it('показывает устаревший кандидат, причину блокировки и оставляет повтор сборки доступным', () => {
    form({ ...view(), preview: { ...view().preview!, fresh: false, problem: 'Клип источника изменился.' } });
    const html = render();
    expect(html).toContain('Клип источника изменился.');
    expect(html).toContain('src="songframe-file:///preview.mp4"');
    expect(button(html, 'Принять результат')).toContain('disabled=""');
    expect(button(html, 'Принять результат')).toContain('Клип источника изменился.');
    expect(button(html, 'Собрать заново')).not.toContain('disabled=""');
  });

  it('при выполнении задания оставляет просмотр, блокируя повторные операции с объяснением', () => {
    form(view(), true);
    const html = render();
    expect(html).toContain('src="songframe-file:///preview.mp4"');
    expect(button(html, 'Собрать заново')).toContain('disabled=""');
    expect(button(html, 'Принять результат')).toContain('disabled=""');
    expect(button(html, 'Сохранить')).toContain('Дождитесь завершения текущей операции.');
  });

  it('для замены передаёт общему подтверждению последствия и обычную локальную кнопку', () => {
    form({ ...view(), hasAsset: true }).replacement = true;
    const html = render();
    expect(html).toContain('Принятый комплект M02 будет заменён');
    expect(fixture.confirmation?.confirmColor).toBe('error');
    expect(fixture.confirmation?.confirmLabel).toBe('Заменить принятый комплект');
    expect(fixture.confirmation?.confirmAgent).toBeUndefined();
    expect(fixture.form!.confirmReplacement).not.toHaveBeenCalled();
  });
});
