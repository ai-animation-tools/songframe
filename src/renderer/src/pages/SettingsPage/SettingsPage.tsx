/** Глобальные настройки доступны и без проекта, Python, FFmpeg или установленного агента. */
import type { ReactElement } from 'react';
import { Alert, Button, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import { AgentDiagnostics, AgentInstructions, AgentSettingsForm } from './components';
import { useAgentSettings } from './useAgentSettings';
import { AgentButton } from '../../components';
import { useApp } from '../../state';
import { useAgentAccount } from './useAgentAccount';
import { useAgentModels } from './useAgentModels';
import { useInstalledAgents } from './useInstalledAgents';
import { AgentAccountPanel } from './components/AgentAccountPanel';

export function SettingsPage(): ReactElement {
  const form = useAgentSettings();
  const { online } = useApp();
  const accountReady = !form.loading && !form.loadError && !form.profileLoading && !form.profileError;
  // Аккаунт и каталог моделей читаются у сервисов агента: без сети не запрашиваем, после подключения прочитаем снова.
  const networkReady = accountReady && online;
  const account = useAgentAccount(form.settings, networkReady);
  const models = useAgentModels(form.settings?.provider, networkReady);
  const installed = useInstalledAgents();
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
                models={models.models}
                modelsLoading={models.loading}
                modelsMessage={models.message}
                installed={installed}
                onChange={form.change}
              />
              {form.profileLoading && <LinearProgress aria-label="Загрузка профиля агента" />}
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
                  provider={form.settings?.provider}
                  variant="contained"
                  onClick={async () => {
                    await form.check();
                    // После установки или входа каталог мог стать доступен.
                    models.refresh();
                  }}
                  disabled={!form.settings || form.checking || form.saving || form.profileLoading || !!form.profileError}
                >
                  {form.checking ? 'Проверка' : 'Проверить'}
                </AgentButton>
              </Stack>
              {form.checking && <LinearProgress aria-label="Проверка агента" />}
              {form.settings && accountReady && (
                <AgentAccountPanel
                  provider={form.settings.provider}
                  result={account.result}
                  loading={account.loading}
                  failed={account.failed}
                  disabled={form.saving || !online}
                  onRefresh={account.refresh}
                />
              )}
            </Stack>
          </Paper>
          {form.result && <AgentDiagnostics result={form.result} />}
          {form.settings && form.result && <AgentInstructions provider={form.settings.provider} result={form.result} />}
        </>
      )}
    </Stack>
  );
}
