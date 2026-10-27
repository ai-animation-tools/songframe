/** Глобальные настройки доступны и без проекта, Python, FFmpeg или установленного агента. */
import type { ReactElement } from 'react';
import { Alert, Button, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import { AgentDiagnostics, AgentInstructions, AgentSettingsForm } from './components';
import { useAgentSettings } from './useAgentSettings';
import { CodexCliSettings } from './components/CodexCliSettings';
import { AgentButton } from '../../components';
import { useAgentAccount } from './useAgentAccount';
import { AgentAccountPanel } from './components/AgentAccountPanel';

export function SettingsPage(): ReactElement {
  const form = useAgentSettings();
  const accountReady = !form.loading && !form.loadError && !form.profileLoading && !form.profileError;
  const account = useAgentAccount(form.settings, accountReady);
  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <Typography variant="h5">Настройки</Typography>
      <Typography color="text.secondary">
        Текстовый агент и его модель общие для всех проектов. Модель изображений выбирается в настройках проекта. Просмотр, редактирование и локальные
        инструменты доступны без агента.
      </Typography>
      {form.loading && <LinearProgress aria-label="Загрузка настроек" />}
      {form.loadError && <Alert severity="error">{form.loadError}</Alert>}
      {!form.loading && !form.loadError && (
        <>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack spacing={2}>
              <AgentSettingsForm
                settings={form.settings}
                disabled={form.saving}
                fieldsDisabled={form.profileLoading || !!form.profileError}
                onChange={(value, pathTyping = false) => {
                  account.preparePathChange(pathTyping);
                  form.change(value);
                }}
                onPick={form.pick}
              />
              {form.profileLoading && <LinearProgress aria-label="Загрузка профиля CLI" />}
              {form.profileError && <Alert severity="error">{form.profileError}</Alert>}
              <Typography variant="body2" color="text.secondary">
                Проверка не сохраняет форму и не запускает генерацию. Статус входа не подтверждает доступ к выбранной модели или наличие средств.
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="contained" startIcon={<SaveIcon />} onClick={form.save} disabled={form.saving || form.profileLoading || !!form.profileError}>
                  {form.saving ? 'Сохранение' : 'Сохранить настройки агента'}
                </Button>
                <AgentButton
                  setup
                  provider={form.settings?.provider ?? null}
                  variant="contained"
                  onClick={form.check}
                  disabled={!form.settings || form.checking || form.saving || form.profileLoading || !!form.profileError}
                >
                  {form.checking ? 'Проверка' : 'Проверить'}
                </AgentButton>
              </Stack>
              {form.checking && <LinearProgress aria-label="Проверка CLI" />}
              {form.settings && accountReady && (
                <AgentAccountPanel
                  result={account.result}
                  loading={account.loading}
                  failed={account.failed}
                  disabled={form.saving}
                  onRefresh={account.refresh}
                />
              )}
              {form.settings?.provider === 'codex' && !form.profileLoading && !form.profileError ? <CodexCliSettings /> : null}
            </Stack>
          </Paper>
          {form.result && <AgentDiagnostics result={form.result} />}
          {form.settings && form.result && <AgentInstructions provider={form.settings.provider} result={form.result} />}
        </>
      )}
    </Stack>
  );
}
