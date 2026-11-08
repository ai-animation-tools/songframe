import { settingsTexts } from '@shared/texts/settings';
import { navigationTexts } from '@shared/texts/navigation';
import { componentTexts } from '@shared/texts/component-manager';
/** Глобальные настройки доступны и без проекта, FFmpeg или установленного агента. */
import type { ReactElement } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Button, Paper, Stack, Typography } from '@mui/material';
import ExtensionIcon from '@mui/icons-material/Extension';
import { AgentSettingsSection, AppUpdates } from './components';
import { PageActionBar } from '../../components/PageActionBar';

/**
 * Настройки: выбор агента и его модели, переход к компонентам и обновление приложения.
 *
 * Отличие от 634fd94: добавлен переход к странице «Компоненты» (замена Python/Whisper-части среды,
 * этап 41.3).
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
            {componentTexts.settingsPageHint}
          </Typography>
          <Button component={RouterLink} to="/components" variant="outlined" startIcon={<ExtensionIcon />}>
            {componentTexts.open}
          </Button>
        </Stack>
      </Paper>
      <AgentSettingsSection />
      <AppUpdates />
    </Stack>
  );
}
