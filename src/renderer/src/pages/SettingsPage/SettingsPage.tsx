import { settingsTexts } from '@shared/texts/settings';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
/** Глобальные настройки доступны и без проекта, Python, FFmpeg или установленного агента. */
import type { ReactElement } from 'react';
import { Alert, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import { AgentDiagnostics, AgentInstructions, AgentSettingsForm } from './components';
import { useAgentSettings } from './useAgentSettings';
import { ActionButton, AgentButton } from '../../components';
import { PageActionBar } from '../../components/PageActionBar';
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
  // Причины блокировки кнопок формы: сначала идущая операция, затем состояние профиля.
  const profileReason = form.profileLoading ? settingsTexts.profileLoading : form.profileError ? settingsTexts.profileFailed : null;
  const saveReason = form.saving ? commonTexts.waitForSaving : profileReason;
  const checkReason = !form.settings ? settingsTexts.selectAgent : form.checking ? commonTexts.waitForCheck : saveReason;
  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <PageActionBar>
        <Typography variant="h5">{navigationTexts.pages.settings}</Typography>
      </PageActionBar>
      <Typography color="text.secondary">{settingsTexts.description}</Typography>
      {form.loading && <LinearProgress aria-label={settingsTexts.loadingSettings} />}
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
              {form.profileLoading && <LinearProgress aria-label={settingsTexts.loadingProfile} />}
              {form.profileError && <Alert severity="error">{form.profileError}</Alert>}
              <Typography variant="body2" color="text.secondary">
                {settingsTexts.checkExplanation}
              </Typography>
              <Stack direction="row" spacing={1}>
                <ActionButton
                  variant="contained"
                  startIcon={<SaveIcon />}
                  onClick={form.save}
                  disabled={form.saving || form.profileLoading || !!form.profileError}
                  disabledReason={saveReason}
                >
                  {form.saving ? commonTexts.saving : settingsTexts.saveAgent}
                </ActionButton>
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
                  disabledReason={checkReason}
                >
                  {form.checking ? commonTexts.checking : commonTexts.check}
                </AgentButton>
              </Stack>
              {form.checking && <LinearProgress aria-label={settingsTexts.checkingAgent} />}
              {/* Итог проверки сразу под кнопкой, а не после панели аккаунта. */}
              {form.result && <AgentDiagnostics result={form.result} />}
              {form.settings && accountReady && (
                <AgentAccountPanel
                  provider={form.settings.provider}
                  result={account.result}
                  loading={account.loading}
                  failed={account.failed}
                  disabled={form.saving || !online}
                  disabledReason={form.saving ? settingsTexts.waitForSettingsSaving : settingsTexts.offline}
                  onRefresh={account.refresh}
                />
              )}
            </Stack>
          </Paper>
          {form.settings && form.result && <AgentInstructions provider={form.settings.provider} result={form.result} />}
        </>
      )}
    </Stack>
  );
}
