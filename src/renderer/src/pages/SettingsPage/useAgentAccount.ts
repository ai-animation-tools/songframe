/** Аккаунт читается для текущего CLI; модель и сохранение формы не меняют источник его лимитов. */
import { useEffect, useRef, useState } from 'react';
import type { AgentAccountResult, AgentSettings } from '@shared/agents';
import { RequestScope } from '../../hooks/requestScope';

interface Snapshot {
  current(): boolean;
  result: AgentAccountResult | null;
  loading: boolean;
  failed: boolean;
}

export function useAgentAccount(settings: AgentSettings | null, ready: boolean) {
  const provider = settings?.provider;
  const executablePath = settings?.executablePath ?? '';
  const enabled = ready && !!provider;
  const context = JSON.stringify([enabled, provider, executablePath]);
  const scope = useRef(new RequestScope()).current;
  const delayPathRead = useRef(false);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  // Инвалидация при render сразу скрывает прежний аккаунт, в том числе при A → B → A.
  scope.update(context);
  useEffect(() => {
    scope.invalidate();
    const current = scope.capture();
    const delay = delayPathRead.current ? 600 : 0;
    delayPathRead.current = false;
    setSnapshot({ current, result: null, loading: enabled, failed: false });
    if (!enabled || !provider) return;

    const read = (): void => {
      void window.api.agents.account({ provider, executablePath }).then(
        (result) => {
          if (current()) setSnapshot({ current, result, loading: false, failed: false });
        },
        () => {
          // Текст ошибки CLI не переносим в UI: он может содержать служебный вывод или личные данные.
          if (current()) setSnapshot({ current, result: null, loading: false, failed: true });
        }
      );
    };
    const timer = delay ? setTimeout(read, delay) : null;
    if (!timer) read();
    return () => {
      if (timer) clearTimeout(timer);
      scope.invalidate();
    };
  }, [context, enabled, provider, executablePath, revision, scope]);

  const visible = snapshot?.current() ? snapshot : null;
  return {
    result: visible?.result ?? null,
    loading: enabled && (visible?.loading ?? true),
    failed: visible?.failed ?? false,
    preparePathChange: (typing: boolean): void => {
      delayPathRead.current = typing;
    },
    refresh: (): void => {
      delayPathRead.current = false;
      scope.invalidate();
      setRevision((value) => value + 1);
    }
  };
}
