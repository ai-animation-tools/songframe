/** Наличие каждого агента на компьютере: ненайденную программу нельзя выбрать в настройках. */
import { useEffect, useState } from 'react';
import { AGENT_PROVIDER_IDS, type AgentProvider } from '@shared/agent-providers';

/** null — проверка ещё идёт; ошибка проверки не блокирует выбор, её покажет «Проверить». */
export type InstalledAgents = Partial<Record<AgentProvider, boolean>> | null;

export function useInstalledAgents(): InstalledAgents {
  const [installed, setInstalled] = useState<InstalledAgents>(null);
  useEffect(() => {
    let current = true;
    void Promise.all(
      AGENT_PROVIDER_IDS.map((provider) =>
        window.api.agents.check({ provider }).then(
          (result) => [provider, result.availability !== 'not_found'] as const,
          () => [provider, true] as const
        )
      )
    ).then((entries) => {
      if (current) setInstalled(Object.fromEntries(entries));
    });
    return () => {
      current = false;
    };
  }, []);
  return installed;
}
