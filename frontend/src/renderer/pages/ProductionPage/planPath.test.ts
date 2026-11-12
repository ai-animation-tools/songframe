/** Путь плана выводится из снимков: текущий шаг, итоги и фраза «Сейчас» для ключевых состояний. */
import { describe, expect, it } from 'vitest';
import type { ProductionWorkflowView } from '@shared/production-workflow';
import type { PackageView, ShotProduction } from '@shared/types';
import { attemptLabel, defaultAttempt, planPath } from './planPath';

const shot = (overrides: Partial<ShotProduction> = {}): ShotProduction =>
  ({ id: 'M07', lipsync: false, asset: null, packages: [], ...overrides }) as unknown as ShotProduction;
const pkg = (overrides: Partial<PackageView> = {}): PackageView =>
  ({
    dir: '/p/plan/batches/M07-attempt-02',
    relative: 'plan/batches/M07-attempt-02',
    stage: 'description_review',
    keyframes: [],
    prompt: null,
    request: null,
    speech: null,
    pendingDecision: null,
    decision: null,
    timing: null,
    ...overrides
  }) as PackageView;
const frame = (id: string, approved: boolean) => ({ id, role: 'first', time_seconds: 0, approved }) as PackageView['keyframes'][number];
const view = (overrides: Partial<ProductionWorkflowView> = {}): ProductionWorkflowView =>
  ({ proposal: null, nextFrame: null, ...overrides }) as ProductionWorkflowView;
const proposal = (stage: string, status: string) => ({ id: 'p', stage, status, stale: false, after: {} }) as unknown as ProductionWorkflowView['proposal'];

describe('путь плана', () => {
  it('новый план начинается с описания, будущие шаги ждут', () => {
    const path = planPath(shot(), null, view());
    expect(path.current).toBe('description');
    expect(path.tone).toBe('action');
    expect(path.steps.map((step) => step.status)).toEqual(['current', 'future', 'future', 'future', 'future', 'future']);
  });

  it('срез речи есть только у речевого плана и стоит перед запросом', () => {
    expect(planPath(shot({ lipsync: true }), null, view()).steps.map((step) => step.key)).toEqual([
      'description',
      'frames',
      'prompt',
      'speech',
      'request',
      'generation',
      'result'
    ]);
    const approved = pkg({ stage: 'prompt_review', keyframes: [frame('K01', true)], prompt: { path: 'p', approved: true, text: 'x' } });
    expect(planPath(shot({ lipsync: true }), approved, view()).current).toBe('speech');
    expect(planPath(shot(), approved, view()).current).toBe('request');
  });

  it('ручная генерация заменяет запрос и генерацию одним шагом', () => {
    const manual = view({ manual: true });
    const keys = planPath(shot({ lipsync: true }), null, manual).steps.map((step) => step.key);
    expect(keys).toEqual(['description', 'frames', 'prompt', 'speech', 'request', 'result']);
    const speech = { path: 's.wav', recipe: 'r.json', start: 0, end: 5, lines: [] };
    const approved = pkg({ stage: 'prompt_review', keyframes: [frame('K01', true)], prompt: { path: 'p', approved: true, text: 'x' }, speech });
    const before = planPath(shot({ lipsync: true }), approved, manual);
    expect(before.current).toBe('request');
    expect(before.steps[4].title).toBe('Ручная генерация');
    // Свёрнутый шаг среза называет его границы в песне и длину.
    expect(before.steps[3].summary).toBe('Срез готов: 0:00.00–0:05.00 (5,00 с)');
    expect(before.now).toContain('соберите пакет');
    const built = pkg({
      ...approved,
      stage: 'request_choice',
      request: { mode: 'manual', attemptStatus: 'manual_pending', inputs: [], downloads: [] } as unknown as PackageView['request']
    });
    expect(planPath(shot({ lipsync: true }), built, manual).now).toContain('загрузите');
    // Задание загрузки проходит этап «отправлено»: план остаётся на шаге ручной генерации.
    expect(planPath(shot({ lipsync: true }), pkg({ ...built, stage: 'submitted' }), manual, false, true)).toMatchObject({ current: 'request', tone: 'wait' });
  });

  it('идущий агент — ожидание, готовое предложение — ход пользователя', () => {
    expect(planPath(shot(), null, view({ proposal: proposal('description', 'running') }))).toMatchObject({ current: 'description', tone: 'wait' });
    expect(planPath(shot(), pkg(), view({ proposal: proposal('prompt', 'ready') }))).toMatchObject({ current: 'prompt', tone: 'action' });
  });

  it('принятое описание ведёт к опорам, хотя этап попытки ещё прежний', () => {
    const frames = [
      { id: 'K01', approved: false },
      { id: 'K02', approved: false }
    ] as PackageView['keyframes'];
    const accepted = pkg({ keyframes: frames, decision: { stage: 'description_review', verdict: 'approve' } as PackageView['decision'] });
    expect(planPath(shot(), accepted, null).current).toBe('frames');
    expect(planPath(shot(), pkg({ keyframes: frames }), null).current).toBe('description');
  });

  it('вопрос об опоре называет опору, опоры считаются в итоге', () => {
    const path = planPath(
      shot(),
      pkg({
        stage: 'keyframes_review',
        keyframes: [frame('K01', true), frame('K02', false)],
        pendingDecision: { stage: 'keyframes_review', question: '?', options: ['approve'], frame: 'K02' }
      }),
      view()
    );
    expect(path.current).toBe('frames');
    expect(path.now).toContain('K02');
    expect(path.steps[1].summary).toBe('Утверждено 1 из 2');
  });

  it('этапы платной опоры остаются внутри шага опор', () => {
    expect(planPath(shot(), pkg({ stage: 'image_submitted', keyframes: [frame('K01', false)] }), view()).current).toBe('frames');
  });

  it('отправленный запрос — ожидание сервиса, неизвестный исход — ход пользователя', () => {
    const request = (attemptStatus: string) => ({ kind: 'video', attemptStatus }) as PackageView['request'];
    const submitted = pkg({ stage: 'submitted', request: request('running') });
    expect(planPath(shot(), submitted, view(), false, true)).toMatchObject({ current: 'generation', tone: 'wait' });
    // После перезапуска приложения статус прежний, но ждать нечего: получение запускает пользователь.
    expect(planPath(shot(), submitted, view())).toMatchObject({ current: 'generation', tone: 'action', now: expect.stringContaining('получите результат') });
    expect(planPath(shot(), pkg({ stage: 'submitted', request: request('submission_unknown') }), view())).toMatchObject({
      current: 'generation',
      tone: 'action'
    });
  });

  it('возврат с замечанием остаётся на шаге возврата', () => {
    const returned = pkg({ stage: 'needs_revision', decision: { stage: 'prompt_review', verdict: 'revise' }, keyframes: [frame('K01', true)] });
    expect(planPath(shot(), returned, view()).current).toBe('prompt');
  });

  it('принятый план пройден целиком, в том числе без попытки', () => {
    const asset = {} as ShotProduction['asset'];
    expect(planPath(shot({ asset }), null, view())).toMatchObject({ current: 'result', finished: true, tone: 'done' });
    expect(planPath(shot(), pkg({ stage: 'accepted' }), view()).steps.every((step) => step.status === 'done')).toBe(true);
  });
});

describe('выбор попытки', () => {
  it('открывает попытку с вопросом, иначе последнюю', () => {
    const first = pkg({ dir: 'a', pendingDecision: { stage: 'prompt_review', question: '?', options: [] } });
    const last = pkg({ dir: 'b' });
    expect(defaultAttempt([first, last])?.dir).toBe('a');
    expect(defaultAttempt([pkg({ dir: 'a' }), last])?.dir).toBe('b');
    expect(defaultAttempt([])).toBeNull();
  });

  it('называет попытку по номеру папки, папку очереди — её путём', () => {
    expect(attemptLabel(pkg())).toBe('Попытка 2');
    expect(attemptLabel(pkg({ relative: 'plan/awaiting/M07' }))).toBe('plan/awaiting/M07');
  });
});
