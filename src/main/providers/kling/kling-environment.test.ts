/** Строка «Среды», проверка и вход Kling через общий PythonLauncher и media_request без сети. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentCheck, ToolResult } from '@shared/types';
import { PythonLauncher } from '../../python-launcher';
import type { PythonOptions } from '../../python-runtime';
import { kling } from '.';

const options: PythonOptions = { toolsRoot: '/songframe', packaged: true, resourcesPath: '/app/resources', localDir: '/state' };
const result = (stdout: string, code: number | null = 0, stderr = ''): ToolResult => ({ code, stdout, stderr, command: 'python' });

function launcherRun(...answers: (ToolResult | Error)[]) {
  const spy = vi.spyOn(PythonLauncher.prototype, 'run');
  for (const answer of answers) {
    if (answer instanceof Error) spy.mockRejectedValueOnce(answer);
    else spy.mockResolvedValueOnce(answer);
  }
  return spy;
}

afterEach(() => vi.restoreAllMocks());

describe('Среда Kling', () => {
  it('показывает одну строку клиента из поставки с кнопкой входа и без Node', () => {
    const checks = kling.environment(options).checks;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: 'kling', label: 'Kling', bundled: true, loginProvider: 'kling', productionOnly: true, status: 'pending' });
    expect(checks[0].external).toBeUndefined();
    expect(kling.installed(options)).toBe(true);
  });

  it('строка проверяет только наличие клиента и не обращается к сервису', async () => {
    const spy = vi.spyOn(PythonLauncher.prototype, 'run');
    const environment = kling.environment(options);
    const updates: Partial<EnvironmentCheck>[] = [];
    await environment.run((_id, patch) => updates.push(patch));
    expect(spy).not.toHaveBeenCalled();
    expect(updates).toEqual([{ status: 'done', ok: true, detail: 'Клиент SongFrame входит в поставку', elapsedMs: 0 }]);
  });

  it('checkAuth проверяет вход тем же launcher, что и производство', async () => {
    const spy = launcherRun(result('{"status":"authenticated"}'));
    expect(await kling.checkAuth(options)).toEqual({ status: 'authenticated' });
    expect(spy).toHaveBeenCalledWith(null, 'media_request', ['auth-status', '--provider', 'kling', '--json'], { timeoutMs: 45000 });
    expect(spy.mock.contexts[0]).toMatchObject({ options });
  });

  it('checkAuth передаёт статус и пояснение media_request, а сломанный ответ считает неизвестным', async () => {
    launcherRun(result('{"status":"authenticated"}'), result('{"status":"unauthenticated","message":"Войдите"}'), result('не JSON'), new Error('нет Python'));
    expect(await kling.checkAuth(options)).toEqual({ status: 'authenticated' });
    expect(await kling.checkAuth(options)).toEqual({ status: 'unauthenticated', message: 'Войдите' });
    expect((await kling.checkAuth(options)).status).toBe('unknown');
    expect((await kling.checkAuth(options)).status).toBe('unknown');
  });
});

describe('Вход в Kling', () => {
  const url = 'http://127.0.0.1:9/auth/authorize?client_id=c&state=s';
  /** Подставной запуск: печатает адрес в stderr по частям, как Python, и отдаёт итог. */
  function streamingRun(answer: ToolResult) {
    return vi.spyOn(PythonLauncher.prototype, 'run').mockImplementationOnce(async (_project, _tool, _args, settings) => {
      settings?.onOutput?.('AUTHORIZE_URL http://127.0.0.1:9/auth/', true);
      settings?.onOutput?.('authorize?client_id=c&state=s\n', true);
      return answer;
    });
  }

  it('запускает вход без браузера в Python, ждёт дольше пяти минут и сообщает адрес приложению один раз', async () => {
    const spy = streamingRun(result('{"ok":true,"message":"Вход в Kling выполнен, авторизация сохранена."}'));
    const authorizeUrl = vi.fn();
    expect(await kling.login(options, { authorizeUrl })).toEqual({ ok: true, message: 'Вход в Kling выполнен, авторизация сохранена.' });
    const [project, tool, args, settings] = spy.mock.calls[0];
    expect([project, tool, args]).toEqual([null, 'media_request', ['login', '--provider', 'kling', '--no-browser']]);
    expect(settings?.timeoutMs).toBeGreaterThanOrEqual(300000);
    expect(authorizeUrl).toHaveBeenCalledTimes(1);
    expect(authorizeUrl).toHaveBeenCalledWith(url);
  });

  it('отмена прерывает ожидание и сообщает об отмене', async () => {
    const controller = new AbortController();
    const spy = vi.spyOn(PythonLauncher.prototype, 'run').mockImplementationOnce(async (_project, _tool, _args, settings) => {
      controller.abort();
      expect(settings?.signal?.aborted).toBe(true);
      return result('', null, 'Выполнение остановлено пользователем.');
    });
    expect(await kling.login(options, { signal: controller.signal })).toEqual({ ok: false, message: 'Вход в Kling отменён.' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('при неудаче возвращает сообщение Python или понятную причину', async () => {
    const failed = '{"ok":false,"message":"Вход в Kling не завершён: истекло время."}';
    launcherRun(result(failed, 1), result('', null, 'Превышено время выполнения'), new Error('Корень комплекса не найден.'));
    expect(await kling.login(options)).toEqual({ ok: false, message: 'Вход в Kling не завершён: истекло время.' });
    expect((await kling.login(options)).message).toContain('Подтвердите вход в браузере');
    expect(await kling.login(options)).toMatchObject({ ok: false, message: expect.stringContaining('Корень комплекса не найден.') });
  });
});
