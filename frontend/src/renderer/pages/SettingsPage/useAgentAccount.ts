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
  const enabled = ready && !!provider;
  const context = JSON.stringify([enabled, provider]);
  const scope = useRef(new RequestScope()).current;
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  // Инвалидация при render сразу скрывает прежний аккаунт, в том числе при A → B → A.
  scope.update(context);
  useEffect(() => {
    scope.invalidate();
    const current = scope.capture();
    setSnapshot({ current, result: null, loading: enabled, failed: false });
    if (!enabled || !provider) return;
    void window.api.agents.account({ provider }).then(
      (result) => {
        if (current()) setSnapshot({ current, result, loading: false, failed: false });
      },
      () => {
        // Текст ошибки CLI не переносим в UI: он может содержать служебный вывод или личные данные.
        if (current()) setSnapshot({ current, result: null, loading: false, failed: true });
      }
    );
    return () => scope.invalidate();
  }, [context, enabled, provider, revision, scope]);

  const visible = snapshot?.current() ? snapshot : null;
  return {
    result: visible?.result ?? null,
    loading: enabled && (visible?.loading ?? true),
    failed: visible?.failed ?? false,
    refresh: (): void => {
      scope.invalidate();
      setRevision((value) => value + 1);
    }
  };
}
