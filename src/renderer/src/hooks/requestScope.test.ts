/** Deferred fake API воспроизводит запоздалые ответы без подмены React hooks или доступа к настоящему IPC. */
import { describe, expect, it, vi } from 'vitest';
import { completeInScope, RequestScope } from './requestScope';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('контекст асинхронного запроса', () => {
  it('старый decide не открывает диалог после смены проекта, даже при возврате к прежнему проекту', async () => {
    const scope = new RequestScope();
    scope.update('project-A');
    const response = deferred<void>();
    const openDialog = vi.fn();
    const pending = completeInScope(response.promise, scope.capture(), openDialog);
    scope.update('project-B');
    scope.update('project-A');
    response.resolve();
    await pending;
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('старый submit не закрывает повторно открытый диалог того же пакета', async () => {
    const scope = new RequestScope();
    const pkg = { dir: 'package-A' };
    scope.update(pkg);
    const response = deferred<void>();
    const closeDialog = vi.fn();
    const pending = completeInScope(response.promise, scope.capture(), closeDialog);
    scope.update(null);
    scope.update(pkg);
    response.resolve();
    await pending;
    expect(closeDialog).not.toHaveBeenCalled();
  });

  it('сохранение профиля инвалидирует запоздалое чтение и выбор файла прежней формы', async () => {
    const scope = new RequestScope();
    const reading = deferred<string>();
    const picking = deferred<string[]>();
    const applyProfile = vi.fn();
    const applyPath = vi.fn();
    const read = completeInScope(reading.promise, scope.capture(), applyProfile);
    const pick = completeInScope(picking.promise, scope.capture(), applyPath);
    scope.invalidate();
    const saved = completeInScope(Promise.resolve('сохранённый профиль'), scope.capture(), applyProfile);
    reading.resolve('прежний профиль');
    picking.resolve(['/fixture/old-cli']);
    await Promise.all([read, pick, saved]);
    expect(applyProfile).toHaveBeenCalledExactlyOnceWith('сохранённый профиль');
    expect(applyPath).not.toHaveBeenCalled();
  });

  it('размонтирование отменяет UI-эффекты ответа, сохраняя выполнение начатой операции', async () => {
    const scope = new RequestScope();
    const response = deferred<string>();
    const commit = vi.fn();
    const pending = completeInScope(response.promise, scope.capture(), commit);
    scope.invalidate();
    response.resolve('результат');
    await pending;
    expect(commit).not.toHaveBeenCalled();
  });

  it('ответ текущего контекста применяется один раз', async () => {
    const scope = new RequestScope();
    scope.update('current');
    const commit = vi.fn();
    await completeInScope(Promise.resolve('ответ'), scope.capture(), commit);
    expect(commit).toHaveBeenCalledExactlyOnceWith('ответ');
  });
});
