/** Путь Codex относится к компьютеру, а модель изображений выбирается в проекте. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, LinearProgress, Stack, TextField } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import type { AgentSettings } from '@shared/agents';
import { useApp } from '../../../state';
import { completeInScope, RequestScope } from '../../../hooks/requestScope';

export function CodexCliSettings(): ReactElement {
  const { notify, describeError } = useApp();
  const [profile, setProfile] = useState<AgentSettings>({ provider: 'codex' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef(new RequestScope()).current;
  const ready = useRef(false);
  const savingNow = useRef(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    scope.invalidate();
    const current = scope.capture();
    ready.current = false;
    setLoading(true);
    void completeInScope(window.api.agents.getImageSettings(), current, (value) => {
      setProfile(value ?? { provider: 'codex' });
      ready.current = true;
      setLoading(false);
    }).catch((reason) => {
      if (current()) {
        setError(describeError(reason));
        setLoading(false);
      }
    });
    return () => {
      scope.invalidate();
      ready.current = false;
    };
  }, [describeError, scope]);
  const change = (value: string): void => {
    if (!ready.current || savingNow.current) return;
    scope.invalidate();
    setError(null);
    // Скрытая legacy-модель сохраняется для совместимости ранее записанного профиля.
    setProfile((current) => ({ ...current, executablePath: value }));
  };
  return (
    <Stack spacing={2}>
      {loading && <LinearProgress aria-label="Загрузка пути Codex CLI" />}
      {error && <Alert severity="error">{error}</Alert>}
      <TextField
        label="Путь к Codex CLI для изображений"
        value={profile.executablePath ?? ''}
        disabled={busy || loading || !ready.current}
        helperText="Пусто — автоматический поиск. Модель выбирается в настройках проекта."
        onChange={(event) => change(event.target.value)}
      />
      <Button
        variant="contained"
        startIcon={<SaveIcon />}
        size="medium"
        sx={{ alignSelf: 'flex-start' }}
        disabled={busy || loading || !!error || !ready.current}
        onClick={async () => {
          if (!ready.current || savingNow.current || loading || error) return;
          savingNow.current = true;
          scope.invalidate();
          const current = scope.capture();
          setBusy(true);
          setError(null);
          try {
            await completeInScope(window.api.agents.saveImageSettings(profile), current, (saved) => {
              setProfile(saved);
              notify('Путь Codex CLI сохранён', 'success');
            });
          } catch (reason) {
            if (current()) setError(describeError(reason));
          } finally {
            savingNow.current = false;
            if (current()) setBusy(false);
          }
        }}
      >
        Сохранить путь Codex CLI
      </Button>
    </Stack>
  );
}
