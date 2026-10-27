/** Подтверждение платного действия проверяется на fake API, без запуска CLI и списания кредитов. */
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '@shared/api';
import type { PackageView, ProductionView } from '@shared/types';
import { acceptShownResult, decisionNoteKey, isExternalPackage, relocatedPackage, sendConfirmedRequest } from './decisions';

function fixture(overrides: Partial<PackageView> = {}): PackageView {
  return {
    dir: '/fixture/package',
    shot: 'S01',
    managed: true,
    decisionToken: 'shown-question-token',
    pendingDecision: { stage: 'request_choice', question: 'Отправить?', options: ['send'], executor: 'app' },
    request: { sha256: 'shown-sha' },
    ...overrides
  } as PackageView;
}

function fakeApi() {
  const submit = vi.fn().mockResolvedValue({ id: 'fixture-job' });
  const decide = vi.fn().mockResolvedValue(undefined);
  return { api: { production: { submit, decide } } as unknown as Api, submit, decide };
}

describe('подтверждение запроса производства', () => {
  it('передаёт показанные SHA и token одной отправке управляемого пакета', async () => {
    const { api, submit, decide } = fakeApi();
    await sendConfirmedRequest(api, '/fixture/project', fixture(), 'shown-quote-token');
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
    const { api, submit } = fakeApi();
    await sendConfirmedRequest(api, '/fixture/project', fixture(), 'shown-quote-token', 'shown-quote-token');
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
  it('сопоставляет перенесённый пакет по плану, имени и frozen SHA без выбора latest', () => {
    const original = fixture({ dir: '/fixture/batches/attempt-01' });
    const parked = { ...original, dir: '/fixture/awaiting/attempt-01' };
    const latest = fixture({ dir: '/fixture/batches/attempt-02' });
    const view = { shots: [{ id: original.shot, packages: [latest, parked] }] } as ProductionView;
    expect(relocatedPackage(original, view)).toBe(parked);
  });
  it('не угадывает пакет при неоднозначном переносе или замене запроса', () => {
    const original = fixture({ dir: '/fixture/batches/attempt-01' });
    const first = { ...original, dir: '/fixture/awaiting/attempt-01' };
    const second = { ...original, dir: '/fixture/other/attempt-01' };
    expect(relocatedPackage(original, { shots: [{ id: original.shot, packages: [first, second] }] } as ProductionView)).toBeNull();
    expect(
      relocatedPackage(original, {
        shots: [{ id: original.shot, packages: [{ ...first, request: { ...first.request!, sha256: 'different' } }] }]
      } as ProductionView)
    ).toBeNull();
  });
});
