/** Локальные родители диагностики меняют только props: программы, аккаунты и сеть не вызываются. */
import { useEffect, useRef, useState } from 'react';
import { Alert, List, Stack } from '@mui/material';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import type { EnvironmentCheck } from '@shared/types';
import { commonTexts } from '@shared/texts/common';
import { environmentTexts } from '@shared/texts/environment';
import { ActionButton } from '../components/ActionButton';
import { EnvironmentCheckRow, type ProviderAuthStatus, type ProviderLogin } from '../pages/EnvironmentPage/components/EnvironmentCheckRow';
import { EnvironmentDiagnostics } from '../pages/EnvironmentPage/components/EnvironmentDiagnostics';

export const ENVIRONMENT_STORY_PROVIDER = 'story-media-provider';
export const ENVIRONMENT_STORY_LOGIN_URL = 'https://provider.example.invalid/authorize?session=storybook';
export const ENVIRONMENT_STORY_LONG_PATH =
  'D:\\Рабочие материалы музыкального клипа\\Отдельно установленные ресурсы и локальные модели\\Подготовка производства и дополнительных материалов\\faster-whisper-large-v3';

export function environmentCheck(overrides: Partial<EnvironmentCheck> = {}): EnvironmentCheck {
  return {
    id: 'python',
    label: 'Встроенный Python',
    ok: true,
    detail: 'Python 3.11.9 · resources/runtime/python',
    hint: environmentTexts.main.bundledPythonHint,
    productionOnly: false,
    bundled: true,
    status: 'done',
    elapsedMs: 428,
    ...overrides
  };
}

/** Необязательные зависимости не мешают успешному итогу основных ресурсов. */
export function environmentChecks(): EnvironmentCheck[] {
  return [
    environmentCheck(),
    environmentCheck({ id: 'ffmpeg', label: 'Встроенный FFmpeg', detail: 'FFmpeg 7.1 · resources/media/ffmpeg', productionOnly: true, elapsedMs: 97 }),
    environmentCheck({
      id: 'whisper-model',
      label: environmentTexts.main.whisperModelLabel,
      ok: false,
      detail: environmentTexts.main.modelNotFound,
      hint: environmentTexts.main.whisperModelHint,
      bundled: false,
      productionOnly: true,
      elapsedMs: 21
    }),
    environmentCheck({
      id: 'git',
      label: 'Git',
      ok: false,
      detail: 'Программа не найдена.',
      hint: environmentTexts.main.gitHint,
      bundled: false,
      external: true,
      productionOnly: true,
      elapsedMs: 12
    })
  ];
}

export function environmentProviderCheck(overrides: Partial<EnvironmentCheck> = {}): EnvironmentCheck {
  return environmentCheck({
    id: ENVIRONMENT_STORY_PROVIDER,
    label: 'Демонстрационный провайдер изображений',
    detail: 'Клиент провайдера доступен в поставке.',
    loginProvider: ENVIRONMENT_STORY_PROVIDER,
    ...overrides
  });
}

interface EnvironmentProviderStoryProps {
  initialStatus?: ProviderAuthStatus;
  initialWaiting?: boolean;
  offline?: boolean;
  failCheckOnce?: boolean;
  checkStatus?: EnvironmentCheck['status'];
  checkOk?: boolean;
  allowCompletion?: boolean;
}

export function EnvironmentProviderStory({
  initialStatus = 'unauthenticated',
  initialWaiting = false,
  offline = false,
  failCheckOnce = false,
  checkStatus = 'done',
  checkOk = true,
  allowCompletion = false
}: EnvironmentProviderStoryProps) {
  const [status, setStatus] = useState(initialStatus);
  const [waiting, setWaiting] = useState(initialWaiting);
  const [message, setMessage] = useState<string | undefined>(
    initialStatus === 'unknown' ? 'Проверка аккаунта не ответила. Повторите проверку входа.' : undefined
  );
  const [notice, setNotice] = useState<string | null>(null);
  const failed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  const checkLogin = (): Promise<void> => {
    if (offline || timer.current !== null) return Promise.resolve();
    setStatus('checking');
    setNotice(null);
    // Таймер имитирует отдельный ответ проверки и уничтожается вместе с историей.
    timer.current = setTimeout(() => {
      timer.current = null;
      if (failCheckOnce && !failed.current) {
        failed.current = true;
        setStatus('unknown');
        setMessage('Не удалось проверить вход: демонстрационный ответ недоступен. Повторите проверку.');
      } else {
        setStatus('authenticated');
        setMessage(undefined);
      }
    }, 650);
    return Promise.resolve();
  };
  const login: ProviderLogin = {
    status,
    message,
    loggingIn: waiting,
    offline,
    authorizeUrl: waiting ? ENVIRONMENT_STORY_LOGIN_URL : undefined,
    onLogin: async () => {
      if (offline || waiting) return;
      setNotice(null);
      setWaiting(true);
    },
    onCheck: checkLogin,
    onCancel: () => {
      setWaiting(false);
      setStatus('unauthenticated');
      setNotice('Вход отменён. Демонстрационный аккаунт не подключён.');
    }
  };
  return (
    <Stack spacing={2}>
      <List disablePadding>
        <EnvironmentCheckRow
          check={environmentProviderCheck({
            status: checkStatus,
            ok: checkOk,
            detail: checkOk ? 'Клиент провайдера доступен в поставке.' : 'Клиент провайдера недоступен.'
          })}
          category="core"
          logins={{ [ENVIRONMENT_STORY_PROVIDER]: login }}
        />
      </List>
      {notice && <Alert severity="info">{notice}</Alert>}
      {allowCompletion && waiting && (
        <ActionButton
          startIcon={<CheckCircleOutlineIcon />}
          onClick={() => {
            setWaiting(false);
            setStatus('authenticated');
            setNotice('Подтверждение получено только локальной моделью.');
          }}
        >
          Подтвердить вход в модели
        </ActionButton>
      )}
    </Stack>
  );
}

interface EnvironmentDiagnosticsStoryProps {
  failFirst?: boolean;
}

export function EnvironmentDiagnosticsStory({ failFirst = false }: EnvironmentDiagnosticsStoryProps) {
  const [checks, setChecks] = useState<EnvironmentCheck[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const run = (): void => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setChecks(environmentChecks().map((check) => ({ ...check, ok: false, status: 'pending' })));
    timers.current.push(
      setTimeout(() => setChecks(environmentChecks().map((check, index) => ({ ...check, status: index === 0 ? 'running' : 'pending' }))), 250)
    );
    timers.current.push(
      setTimeout(() => {
        setLoading(false);
        if (failFirst && !failed.current) {
          failed.current = true;
          // При обрыве остаются только завершённые строки, как в родителе рабочей страницы.
          setChecks([environmentCheck()]);
          setError('Демонстрационный worker завершился без ответа');
        } else {
          setChecks(environmentChecks());
        }
      }, 1000)
    );
  };
  return (
    <Stack spacing={2}>
      <ActionButton variant="contained" startIcon={<FactCheckIcon />} disabled={loading} disabledReason={commonTexts.waitForCheck} onClick={run}>
        {loading ? commonTexts.checking : commonTexts.check}
      </ActionButton>
      <EnvironmentDiagnostics checks={checks} loading={loading} error={error} />
    </Stack>
  );
}
