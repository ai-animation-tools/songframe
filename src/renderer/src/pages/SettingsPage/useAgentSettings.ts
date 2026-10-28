/** Поля профиля доступны только после его загрузки; старые ответы не меняют новую форму. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentCheckResult, AgentSettings } from '@shared/agents';
import { useApp } from '../../state';
import { completeInScope, RequestScope } from '../../hooks/requestScope';

export function useAgentSettings() {
  const { notify, describeError, setAgentProvider, invalidateAiAccess, refreshAiAccess } = useApp();
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<AgentCheckResult | null>(null);
  const scope = useRef(new RequestScope()).current;
  const ready = useRef(false);
  const savingNow = useRef(false);

  useEffect(() => {
    scope.invalidate();
    const current = scope.capture();
    ready.current = false;
    setLoading(true);
    setLoadError(null);
    void completeInScope(window.api.agents.getSettings(), current, (value) => {
      setSettings(value);
      setAgentProvider(value?.provider ?? null);
      ready.current = true;
      setLoading(false);
    }).catch((error) => {
      if (current()) {
        setLoadError(describeError(error));
        setLoading(false);
      }
    });
    return () => {
      scope.invalidate();
      ready.current = false;
    };
  }, [describeError, setAgentProvider, scope]);

  const change = useCallback(
    (value: AgentSettings | null) => {
      if (savingNow.current) return;
      const switching = !!value && value.provider !== settings?.provider;
      if (value && !switching && !ready.current) return;
      scope.invalidate();
      const current = scope.capture();
      setSettings(value);
      setResult(null);
      setChecking(false);
      setProfileError(null);
      if (!switching) {
        if (!value) ready.current = true;
        setProfileLoading(false);
        return;
      }
      ready.current = false;
      setProfileLoading(true);
      void completeInScope(window.api.agents.getProviderSettings(value.provider), current, (saved) => {
        setSettings(saved ?? value);
        ready.current = true;
        setProfileLoading(false);
      }).catch((error) => {
        if (current()) {
          setProfileError(describeError(error));
          setProfileLoading(false);
        }
      });
    },
    [settings?.provider, scope, describeError]
  );

  const save = async (): Promise<void> => {
    // Ref закрывает также второй клик до следующего React render и сохранение незагруженного профиля.
    if (!ready.current || savingNow.current) return;
    savingNow.current = true;
    scope.invalidate();
    const current = scope.capture();
    invalidateAiAccess();
    setSaving(true);
    setChecking(false);
    setResult(null);
    try {
      await completeInScope(window.api.agents.saveSettings(settings), current, (saved) => {
        setSettings(saved);
        setAgentProvider(saved?.provider ?? null);
        notify('Настройки сохранены', 'success');
      });
    } catch (error) {
      if (current()) notify(describeError(error), 'error');
      void refreshAiAccess().catch(() => {});
    } finally {
      savingNow.current = false;
      if (current()) setSaving(false);
    }
  };

  const check = async (): Promise<void> => {
    if (!settings || !ready.current || savingNow.current) return;
    const current = scope.capture();
    setChecking(true);
    setResult(null);
    try {
      await completeInScope(window.api.agents.check(settings), current, setResult);
      await refreshAiAccess();
    } catch (error) {
      if (current()) notify(describeError(error), 'error');
    } finally {
      if (current()) setChecking(false);
    }
  };

  return { settings, change, loading, profileLoading, loadError, profileError, saving, checking, result, save, check };
}
