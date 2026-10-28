/** Адаптер Kling: правила запроса для общего платного адаптера; вход и вызовы сервиса выполняет Python-клиент из поставки. */
import type { ProviderAuth } from '@shared/media-providers';
import type { EnvironmentCheck } from '@shared/types';
import { PythonLauncher } from '../../python-launcher';
import type { PythonOptions } from '../../python-runtime';
import type { LoginControl, PaidProviderAdapter } from '../types';
import { KLING_ID, KLING_TITLE } from './kling-title';

/** Проверка входа делает один бесплатный вызов сервиса; лимит покрывает обновление токена. */
const AUTH_TIMEOUT_MS = 45000;
/** Python ждёт подтверждения в браузере до пяти минут; наружный лимит оставляет время на обмен кода. */
const LOGIN_TIMEOUT_MS = 330000;
const STATUSES = new Set<ProviderAuth['status']>(['authenticated', 'unauthenticated', 'unknown']);

/** JSON-ответ инструмента — последняя непустая строка stdout. */
function payload(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function checkKlingAuth(options: PythonOptions): Promise<ProviderAuth> {
  try {
    const result = await new PythonLauncher(options).run(null, 'media_request', ['auth-status', '--provider', KLING_ID, '--json'], {
      timeoutMs: AUTH_TIMEOUT_MS
    });
    const value = payload(result.stdout);
    const status = value?.status as ProviderAuth['status'] | undefined;
    if (result.code === 0 && status && STATUSES.has(status))
      return { status, ...(typeof value?.message === 'string' && status !== 'authenticated' ? { message: value.message } : {}) };
  } catch {
    // Повреждённая поставка Python не подтверждает отсутствие сохранённого входа.
  }
  return { status: 'unknown', message: `Не удалось проверить вход в ${KLING_TITLE}. Проверьте соединение и повторите проверку.` };
}

export async function loginKling(options: PythonOptions, control: LoginControl = {}): Promise<{ ok: boolean; message: string }> {
  const fallback = `Вход в ${KLING_TITLE} не завершён. Подтвердите вход в браузере и повторите при необходимости.`;
  let stderr = '';
  let announced = false;
  try {
    // Браузер открывает приложение: Python только ждёт ответа и печатает адрес, пока ожидание ещё действует.
    const result = await new PythonLauncher(options).run(null, 'media_request', ['login', '--provider', KLING_ID, '--no-browser'], {
      timeoutMs: LOGIN_TIMEOUT_MS,
      signal: control.signal,
      onOutput: (text, error) => {
        if (!error || announced) return;
        stderr += text;
        // Вывод приходит частями: адрес считается полным только после конца строки.
        const url = /^AUTHORIZE_URL (\S+)\r?\n/m.exec(stderr)?.[1];
        if (url) {
          announced = true;
          control.authorizeUrl?.(url);
        }
      }
    });
    if (control.signal?.aborted) return { ok: false, message: `Вход в ${KLING_TITLE} отменён.` };
    const value = payload(result.stdout);
    const message = typeof value?.message === 'string' ? value.message : fallback;
    return { ok: result.code === 0 && value?.ok === true, message };
  } catch (error) {
    return { ok: false, message: `${fallback} ${(error as Error).message}` };
  }
}

export const kling: PaidProviderAdapter = {
  type: 'paid',
  id: KLING_ID,
  rules: {
    aliases: { image: { resolution: ['resolution', 'img_resolution', 'imgResolution'], aspect_ratio: ['aspect_ratio', 'aspectRatio'] } },
    outputCount: ['image_count', 'imageCount'],
    inputFlags: {
      image: /^(?:first_image|image(?:_\d+)?|keyframe_\d+)$/,
      tailImage: /^tail_image(?:_\d+)?$/,
      audio: /^audio(?:_\d+)?$/,
      video: /^video(?:_\d+)?$/
    },
    // Проект использует оригиналы без логотипа; старые options не должны разрешить новый запрос с водяным знаком.
    enforced: {
      watermark: { value: false, rejected: [true, 'true'], message: 'Снимите устаревшую настройку watermark=true: оригиналы запрашиваются без логотипа.' }
    },
    image: {
      command: (references) => (references ? 'image_to_image' : 'text_to_image'),
      // image_N относится к N-му переданному референсу независимо от порядка ключей capabilities.
      referenceSlot: (index) => `image_${index + 1}`,
      series: { names: ['story_mode', 'storyMode'], off: false }
    },
    // Обычному плану до этапа запроса нужен только режим по опорам; остальные режимы агент видит при запросе и для липсинка.
    draftVideoCommands: ['image_to_video']
  },

  // Клиент входит в Python-поставку: отдельной программы провайдера нет.
  installed: () => true,

  environment() {
    const check: EnvironmentCheck = {
      id: KLING_ID,
      label: KLING_TITLE,
      hint: 'Клиент входит в поставку. Войдите кнопкой входа в браузере; без сети состояние входа не определяется.',
      productionOnly: true,
      ok: false,
      detail: 'Ожидание проверки',
      status: 'pending',
      bundled: true,
      loginProvider: KLING_ID
    };
    return {
      checks: [check],
      // Строка проверяет только наличие клиента; состояние входа страница узнаёт одним отдельным запросом.
      async run(update) {
        update(KLING_ID, { status: 'done', ok: true, detail: 'Клиент SongFrame входит в поставку', elapsedMs: 0 });
      }
    };
  },

  checkAuth: (options) => checkKlingAuth(options),
  login: (options, control) => loginKling(options, control),

  smokeChecks: () => [
    {
      name: `Клиент ${KLING_TITLE} без сети`,
      code: `import json,os,subprocess,sys
from pathlib import Path
from tools.common import local_directory
from tools.kling_request import kling_mcp
state = Path(os.environ['SONGFRAME_LOCAL_DIR']).resolve()
path = kling_mcp.credentials_path()
assert local_directory() == state and path.is_relative_to(state), 'Токены должны храниться в каталоге состояния'
assert not path.exists(), 'Проверка поставки не должна находить чужой вход'
tool = Path('tools/media_request/media_request.py').resolve()
result = subprocess.run([sys.executable, '-B', '-X', 'utf8', str(tool), 'auth-status', '--provider', '${KLING_ID}', '--json'], capture_output=True, timeout=30)
assert result.returncode == 0, result.stderr.decode('utf-8', errors='replace')
status = json.loads(result.stdout)['status']
assert status == 'unauthenticated', status
print(json.dumps({'credentials': str(path.relative_to(state)), 'authStatus': status, 'networkUsed': False}))`
    }
  ]
};
