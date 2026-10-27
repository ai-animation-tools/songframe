/** Проверяем различие между отсутствием входа, сбоем проверки и подтверждённым сохранением авторизации. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkKlingAuth, loginKling } from './kling-auth';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-kling-auth-'));
  mkdirSync(join(work, 'kling/dist'), { recursive: true });
  writeFileSync(join(work, 'kling/package.json'), JSON.stringify({ name: '@klingai/cli-global', version: '0.2.3', type: 'module' }));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function cli(stdout: unknown, stderr = '', code = 0): void {
  writeFileSync(
    join(work, 'kling/dist/cli.js'),
    `console.log(${JSON.stringify(JSON.stringify(stdout))});console.error(${JSON.stringify(stderr)});process.exitCode=${code};`
  );
}
const options = () => ({ packaged: true, resourcesPath: work, toolsRoot: work, execPath: process.execPath });

describe('Авторизация Kling', () => {
  it('подтверждает вход через who_am_i и не возвращает данные аккаунта в интерфейс', async () => {
    cli({ ok: true, status: 200, body: { email: 'private@example.test', availableModels: { secret: [] } } });
    expect(await checkKlingAuth(options())).toEqual({ status: 'authenticated' });
  });

  it.each([
    'No login state found for the configured endpoint (.credentials is missing ACCESS_TOKEN). Run: kling login',
    'Login has expired and no refresh token is available. Run again: kling login',
    'Credentials are missing CLIENT_ID, so the token cannot be refreshed. Run again: kling login',
    'Token refresh failed: HTTP 400 invalid_grant'
  ])('распознаёт явное отсутствие действующего входа: %s', async (message) => {
    cli(null, message, 1);
    expect(await checkKlingAuth(options())).toEqual({ status: 'unauthenticated' });
  });

  it.each([
    'fetch failed',
    'Token refresh failed: HTTP 500. The login state is no longer valid. Run again: kling login',
    'Token refresh failed: HTTP 429. The login state is no longer valid. Run again: kling login'
  ])('не выдаёт сетевой сбой за выход из аккаунта: %s', async (message) => {
    cli(null, message, 1);
    expect(await checkKlingAuth(options())).toMatchObject({ status: 'unknown' });
  });

  it.each([{ ok: false, status: 400 }, { ok: true }, { ok: true, status: 400 }, null])('не подтверждает вход по неполному ответу: %j', async (payload) => {
    cli(payload);
    expect(await checkKlingAuth(options())).toMatchObject({ status: 'unknown' });
  });

  it('не считает отсутствие CLI отсутствием авторизации', async () => {
    expect(await checkKlingAuth(options())).toMatchObject({ status: 'unknown' });
  });

  it('требует подтверждения сохранённого входа даже при нулевом коде CLI', async () => {
    cli({ ok: true });
    expect((await loginKling(options())).ok).toBe(false);
    cli({ ok: true, loggedIn: true });
    expect((await loginKling(options())).ok).toBe(true);
  });
});
