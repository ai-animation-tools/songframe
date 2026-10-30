/** Признак сети для интерфейса: без подключения сетевые действия блокируются заранее, а не завершаются ошибкой. */
import { commonTexts } from '@shared/texts/common';
import { useEffect, useState } from 'react';
import type { AiAccess, AiExecutorAccess } from '@shared/ai-access';

export const OFFLINE_MESSAGE = commonTexts.network.actionOffline;

/** navigator.onLine отражает подключение компьютера к сети; доступность конкретного сервиса проверяется отдельно. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

const offline = <T extends AiExecutorAccess>(executor: T | undefined, fallback: T): T => ({
  ...(executor ?? fallback),
  available: false,
  message: OFFLINE_MESSAGE
});

/** Без сети агент и провайдеры медиа недоступны: все проверки aiActionProblem получают одну понятную причину. */
export function offlineAccess(access: AiAccess | null): AiAccess {
  const blocked = { provider: null, selected: true, available: false, message: OFFLINE_MESSAGE };
  return { agent: offline(access?.agent, blocked), image: offline(access?.image, blocked), video: offline(access?.video, blocked) };
}
