/** Подтверждение платного действия проверяется на fake API, без запуска CLI и списания кредитов. */
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '@shared/api';
import type { JobInfo, PackageView, ProductionView } from '@shared/types';
import {
  acceptShownResult,
  decisionNoteKey,
  isExternalPackage,
  isQueuedPackage,
  regeneratedPackage,
  relocatedPackage,
  reviewMontageRoute,
  reviewShots,
  sendConfirmedRequest
} from './decisions';

function fixture(overrides: Partial<PackageView> = {}): PackageView {
  return {
    dir: '/fixture/package',
    relative: 'plan/batches/S01-attempt-01',
    shot: 'S01',
    managed: true,
    decisionToken: 'shown-question-token',
    pendingDecision: { stage: 'request_choice', question: 'Отправить?', options: ['send'], executor: 'app' },
    request: { sha256: 'shown-sha', attemptStatus: 'prepared' },
    ...overrides
  } as PackageView;
}

function fakeApi() {
  const job: JobInfo = {
    id: 'fixture-job',
    kind: 'submit',
    title: 'Отправка запроса',
    status: 'running',
    startedAt: '2026-10-27T10:00:00Z',
    finishedAt: null,
    code: null,
    log: '',
    steps: []
  };
  const submit = vi.fn().mockResolvedValue(job);
  const decide = vi.fn().mockResolvedValue(undefined);
  return { api: { production: { submit, decide } } as unknown as Api, submit, decide, job };
}

describe('подтверждение запроса производства', () => {
  it('передаёт показанные SHA и token одной отправке управляемого пакета', async () => {
    const { api, submit, decide, job } = fakeApi();
    expect(await sendConfirmedRequest(api, '/fixture/project', fixture(), 'shown-quote-token')).toBe(job);
    expect(submit).toHaveBeenCalledExactlyOnceWith('/fixture/project', '/fixture/package', 'shown-sha', 'shown-question-token', 'shown-quote-token');
    expect(decide).not.toHaveBeenCalled();
  });

  it('сохраняет внешний маршрут агента, передавая показанный token', async () => {
    const { api, submit, decide } = fakeApi();
    await sendConfirmedRequest(api, '/fixture/project', fixture({ managed: false, executor: 'agent' }));
    expect(decide).toHaveBeenCalledExactlyOnceWith('/fixture/project', '/fixture/package', 'send', '', 'shown-question-token');
    expect(submit).not.toHaveBeenCalled();
  });

  it('передаёт согласие на неизвестную цену только для показанной оценки', async () => {
    const { api, submit, job } = fakeApi();
    expect(await sendConfirmedRequest(api, '/fixture/project', fixture(), 'shown-quote-token', 'shown-quote-token')).toBe(job);
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      '/fixture/project',
      '/fixture/package',
      'shown-sha',
      'shown-question-token',
      'shown-quote-token',
      'shown-quote-token'
    );
  });

  it('отклоняет согласие от предыдущей оценки до обращения к API', async () => {
    const { api, submit, decide } = fakeApi();
    await expect(sendConfirmedRequest(api, '/fixture/project', fixture(), 'new-quote-token', 'old-quote-token')).rejects.toThrow('другой проверке');
    expect(submit).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('сохраняет ошибку IPC отправки без автоматического повтора и повторного согласования', async () => {
    const { api, submit, decide } = fakeApi();
    const failure = new Error('Не удалось отправить запрос.');
    submit.mockRejectedValueOnce(failure);
    await expect(sendConfirmedRequest(api, '/fixture/project', fixture(), 'shown-quote-token')).rejects.toBe(failure);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();
  });

  it('отправляет через приложение пакет без ожидающего вопроса', async () => {
    const { api, submit, decide } = fakeApi();
    await sendConfirmedRequest(api, '/fixture/project', fixture({ pendingDecision: null }), 'shown-quote-token');
    expect(submit).toHaveBeenCalledExactlyOnceWith('/fixture/project', '/fixture/package', 'shown-sha', 'shown-question-token', 'shown-quote-token');
    expect(decide).not.toHaveBeenCalled();
  });

  it('отклоняет подтверждение без показанного хеша до вызова API', async () => {
    const { api, submit, decide } = fakeApi();
    await expect(sendConfirmedRequest(api, '/fixture/project', fixture({ request: null }))).rejects.toThrow('SHA256');
    expect(submit).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('запрещает отправку приложения без подтверждённой оценки', async () => {
    const { api, submit } = fakeApi();
    await expect(sendConfirmedRequest(api, '/fixture/project', fixture())).rejects.toThrow('стоимость');
    expect(submit).not.toHaveBeenCalled();
  });

  it('разделяет замечания по пакету и версии вопроса', () => {
    const first = fixture();
    expect(decisionNoteKey(first)).not.toBe(decisionNoteKey(fixture({ dir: '/fixture/other-package' })));
    expect(decisionNoteKey(first)).not.toBe(decisionNoteKey(fixture({ decisionToken: 'new-question-token' })));
    expect(decisionNoteKey(first)).toBe(decisionNoteKey(fixture()));
  });
});

describe('владелец пакета и показанный результат', () => {
  it('внешний owner остаётся внешним без pending и при конфликтующем managed', async () => {
    const pkg = fixture({ executor: 'agent', managed: true, pendingDecision: null });
    expect(isExternalPackage(pkg)).toBe(true);
    const { api, submit, decide } = fakeApi();
    await sendConfirmedRequest(api, '/fixture/project', pkg);
    expect(submit).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledExactlyOnceWith('/fixture/project', '/fixture/package', 'send', '', 'shown-question-token');
  });

  it('pending agent не переопределяется флагом managed или owner app', async () => {
    const pkg = fixture({
      executor: 'app',
      managed: true,
      pendingDecision: { stage: 'request_choice', question: 'Отправить?', options: ['send'], executor: 'agent' }
    });
    const { api, submit, decide } = fakeApi();
    await sendConfirmedRequest(api, '/fixture/project', pkg, 'quote');
    expect(submit).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('приёмка передаёт токен показанного результата поверх старого значения формы', async () => {
    const accept = vi.fn().mockResolvedValue({ id: 'fixture-job' });
    const api = { production: { accept } } as unknown as Api;
    await acceptShownResult(
      api,
      '/fixture/project',
      { shot: 'S01', dir: '/fixture/package', resultToken: 'shown-result-token' },
      { mode: 'full', expectedResultToken: 'old-form-token' }
    );
    expect(accept).toHaveBeenCalledExactlyOnceWith('/fixture/project', 'S01', '/fixture/package', { mode: 'full', expectedResultToken: 'shown-result-token' });
  });

  it('приёмка без токена показанных оригиналов не вызывает API', async () => {
    const accept = vi.fn();
    const api = { production: { accept } } as unknown as Api;
    await expect(acceptShownResult(api, '/fixture/project', { shot: 'S01', dir: '/fixture/package' }, { mode: 'full' })).rejects.toThrow('Обновите пакет');
    expect(accept).not.toHaveBeenCalled();
  });
});

describe('выбор пакета после сохранения в очередь', () => {
  it('находит сохранённый запрос после переименования папки попытки в ID плана', () => {
    const original = fixture({ dir: '/fixture/batches/attempt-01' });
    const parked = { ...original, dir: '/fixture/plan/awaiting/S01', relative: 'plan/awaiting/S01' };
    const latest = fixture({ dir: '/fixture/batches/attempt-02' });
    const view = { shots: [{ id: original.shot, packages: [latest, parked] }] } as ProductionView;
    expect(relocatedPackage(original, view)).toBe(parked);
  });
  it('не угадывает пакет при неоднозначном переносе или замене запроса', () => {
    const original = fixture({ dir: '/fixture/batches/attempt-01' });
    const first = { ...original, dir: '/fixture/awaiting/S01', relative: 'plan/awaiting/S01' };
    const second = { ...original, dir: '/fixture/awaiting/duplicate', relative: 'plan/awaiting/duplicate' };
    expect(relocatedPackage(original, { shots: [{ id: original.shot, packages: [first, second] }] } as ProductionView)).toBeNull();
    expect(
      relocatedPackage(original, {
        shots: [{ id: original.shot, packages: [{ ...first, request: { ...first.request!, sha256: 'different' } }] }]
      } as ProductionView)
    ).toBeNull();
  });
  it('не выбирает похожую рабочую попытку вместо очереди и не сопоставляет отсутствующий SHA', () => {
    const original = fixture();
    expect(relocatedPackage(original, { shots: [{ id: original.shot, packages: [original] }] } as ProductionView)).toBeNull();
    const missing = fixture({ request: { ...original.request!, sha256: null } });
    expect(relocatedPackage(missing, { shots: [{ id: original.shot, packages: [missing] }] } as ProductionView)).toBeNull();
  });
  it('показывает неотправленную очередь на обеих ОС и убирает уже отправленный запрос', () => {
    const queued = fixture({ relative: 'plan/awaiting/S01' });
    expect(isQueuedPackage(queued)).toBe(true);
    expect(isQueuedPackage({ ...queued, relative: 'plan\\awaiting\\S01' })).toBe(true);
    expect(isQueuedPackage({ ...queued, request: { ...queued.request!, attemptStatus: 'submitted' } })).toBe(false);
    expect(isQueuedPackage(fixture())).toBe(false);
  });
});

describe('замена принятого комплекта и папка новой попытки', () => {
  it('приёмка сцены с комплектом требует явного согласия и передаёт его в главный процесс', async () => {
    const accept = vi.fn().mockResolvedValue({ id: 'job' } as JobInfo);
    const api = { production: { accept } } as unknown as Api;
    const target = { shot: 'M45', dir: '/p/plan/batches/M45-attempt-02', resultToken: 'token', hasAsset: true };
    await expect(acceptShownResult(api, '/p', target, { mode: 'full' })).rejects.toThrow(/уже есть принятый комплект/);
    expect(accept).not.toHaveBeenCalled();
    await acceptShownResult(api, '/p', target, { mode: 'full', replaceExisting: true });
    expect(accept).toHaveBeenCalledWith('/p', 'M45', target.dir, { mode: 'full', replaceExisting: true, expectedResultToken: 'token' });
  });

  it('берёт папку новой попытки из последнего JSON журнала повтора', () => {
    const log = [
      '$ новая попытка без отправки M45 --json --executor app',
      '{"shot": "M45", "package": "/p/plan/batches/M45-attempt-01", "retry_of": null}',
      'Предупреждение: промпт длинный',
      '{"shot": "M45", "package": "/p/plan/batches/M45-attempt-02", "retry_of": "plan/batches/M45-attempt-01"}'
    ].join('\n');
    expect(regeneratedPackage(log)).toBe('/p/plan/batches/M45-attempt-02');
    expect(regeneratedPackage('Шаг завершился с кодом 3')).toBeNull();
    expect(regeneratedPackage('{"package": 7}')).toBeNull();
  });
});

describe('проба стыков', () => {
  it('берёт соседей по шкале, а на краях только одного соседа', () => {
    const view = {
      shots: ['M01', 'M02', 'M03', 'M04'].map((id) => ({ id })),
      broken: [],
      problems: [],
      tools: { python: true, kling: true }
    } as unknown as ProductionView;
    expect(reviewShots(view, 'M02')).toEqual(['M01', 'M02', 'M03']);
    expect(reviewShots(view, 'M01')).toEqual(['M01', 'M02']);
    expect(reviewShots(view, 'M04')).toEqual(['M03', 'M04']);
    expect(reviewShots(view, 'M99')).toEqual(['M99']);
  });

  it('маршрут пробы ставит на дорожку результат показанной попытки относительным путём проекта', () => {
    const view = {
      shots: ['M44', 'M45', 'M46'].map((id) => ({ id })),
      broken: [],
      problems: [],
      tools: { python: true, kling: true }
    } as unknown as ProductionView;
    const pkg = { shot: 'M45', request: { downloads: ['/p/clip/plan/batches/M45-attempt-01/request/original.mp4'] } } as unknown as PackageView;
    expect(reviewMontageRoute(view, pkg, '/p/clip')).toBe(
      `/project/montage?shots=M44,M45,M46&source=${encodeURIComponent('M45:plan/batches/M45-attempt-01/request/original.mp4')}`
    );
    expect(reviewMontageRoute(view, { shot: 'M45', request: { downloads: [] } } as unknown as PackageView, '/p/clip')).toBe(
      '/project/montage?shots=M44,M45,M46'
    );
  });
});
