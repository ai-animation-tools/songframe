import { settingsTexts } from '@shared/texts/settings';
/** Каталог моделей читается для текущего CLI; ответ прежнего провайдера не попадает в форму другого. */
import { useEffect, useRef, useState } from 'react';
import type { AgentModelsResult } from '@shared/agents';
import type { AgentProvider } from '@shared/agent-providers';
import { RequestScope } from '../../hooks/requestScope';

interface Snapshot {
  current(): boolean;
  result: AgentModelsResult | null;
  loading: boolean;
}

export function useAgentModels(provider: AgentProvider | undefined, ready: boolean) {
  const enabled = ready && !!provider;
  const scope = useRef(new RequestScope()).current;
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  scope.update(JSON.stringify([enabled, provider]));
  useEffect(() => {
    scope.invalidate();
    const current = scope.capture();
    setSnapshot({ current, result: null, loading: enabled });
    if (!enabled || !provider) return;
    void window.api.agents.models({ provider }).then(
      (result) => {
        if (current()) setSnapshot({ current, result, loading: false });
      },
      () => {
        if (current()) setSnapshot({ current, result: { models: [], message: settingsTexts.modelsFailed }, loading: false });
      }
    );
    return () => scope.invalidate();
  }, [enabled, provider, revision, scope]);

  const visible = snapshot?.current() ? snapshot : null;
  return {
    models: visible?.result?.models ?? [],
    message: visible?.result?.message ?? null,
    loading: enabled && (visible?.loading ?? true),
    refresh: (): void => {
      scope.invalidate();
      setRevision((value) => value + 1);
    }
  };
}
