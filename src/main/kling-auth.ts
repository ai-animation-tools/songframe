/** Состояние входа узнаём у CLI; его файл авторизации приложение не читает и не дублирует. */
import { runKling, type KlingRuntimeOptions } from './kling-runtime';

export interface KlingAuth {
  status: 'authenticated' | 'unauthenticated' | 'unknown';
  message?: string;
}

function json(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function checkKlingAuth(options: KlingRuntimeOptions): Promise<KlingAuth> {
  try {
    const result = await runKling(options, ['who_am_i', '--quiet'], { timeoutMs: 35000 });
    const payload = json(result.stdout);
    if (result.code === 0 && payload?.ok === true && payload.status === 200) return { status: 'authenticated' };
    // Ошибка сети при refresh тоже может предлагать login; только явное отсутствие входа или invalid_grant означают выход.
    const absent = [
      'No login state found for the configured endpoint (.credentials is missing ACCESS_TOKEN). Run: kling login',
      'Login has expired and no refresh token is available. Run again: kling login',
      'Credentials are missing CLIENT_ID, so the token cannot be refreshed. Run again: kling login'
    ];
    if (absent.some((text) => result.stderr.includes(text)) || /Token refresh failed: HTTP (?:400|401) invalid_grant\b/.test(result.stderr))
      return { status: 'unauthenticated' };
  } catch {
    // Повреждённая поставка или недоступный CLI не подтверждают отсутствие сохранённого входа.
  }
  return { status: 'unknown', message: 'Не удалось проверить вход в Kling. Проверьте соединение и повторите проверку.' };
}

export async function loginKling(options: KlingRuntimeOptions): Promise<{ ok: boolean; message: string }> {
  const result = await runKling(options, ['login', '--quiet'], { timeoutMs: 310000 });
  const payload = json(result.stdout);
  return result.code === 0 && payload?.ok === true && payload.loggedIn === true
    ? { ok: true, message: 'Вход в Kling выполнен. Авторизация сохранена CLI.' }
    : { ok: false, message: 'Вход в Kling не завершён. Подтвердите вход в браузере и повторите при необходимости.' };
}
