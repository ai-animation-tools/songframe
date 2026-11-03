import { settingsTexts } from '@shared/texts/settings';
import { navigationTexts } from '@shared/texts/navigation';
import { componentTexts } from '@shared/texts/component-manager';
import { migrationTexts } from '@shared/texts/migration';
import { updatesTexts } from '@shared/texts/updates';
/** Глобальные настройки доступны и без проекта, Python, FFmpeg или установленного агента. */
import type { ReactElement } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Button, Paper, Stack, Typography } from '@mui/material';
import ExtensionIcon from '@mui/icons-material/Extension';
import { AgentSettingsSection, AppUpdates } from './components';
import { PageActionBar } from '../../components/PageActionBar';
import { RequireMigrated } from '../../components/NotMigratedNotice';

/**
 * Отличие от 634fd94: добавлен переход к странице «Компоненты» (замена Python/Whisper-части среды,
 * этап 41.3), а блоки агента и обновлений показывают «Ещё не перенесено в Go», пока их методов нет.
 */
export function SettingsPage(): ReactElement {
  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <PageActionBar>
        <Typography variant="h5">{navigationTexts.pages.settings}</Typography>
      </PageActionBar>
      <Typography color="text.secondary">{settingsTexts.description}</Typography>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <Typography fontWeight={600}>{componentTexts.title}</Typography>
          <Typography variant="body2" color="text.secondary">
            {migrationTexts.componentsHint}
          </Typography>
          <Button component={RouterLink} to="/components" variant="outlined" startIcon={<ExtensionIcon />}>
            {componentTexts.open}
          </Button>
        </Stack>
      </Paper>
      <RequireMigrated title={migrationTexts.agentSection} methods={['agents.getSettings']} level="section">
        <AgentSettingsSection />
      </RequireMigrated>
      <RequireMigrated title={updatesTexts.title} methods={['updates.view']} level="section">
        <AppUpdates />
      </RequireMigrated>
    </Stack>
  );
}
