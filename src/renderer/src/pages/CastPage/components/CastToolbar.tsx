import type { ReactElement } from 'react';
import { PageActionBar } from '../../../components/PageActionBar';
import { Button, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import SyncIcon from '@mui/icons-material/Sync';

interface CastToolbarProps {
  busy: boolean;
  dirty: boolean;
  hasManifest: boolean;
  hasCast: boolean;
  onInit: () => void;
  onSave: () => void;
}

/** Действия кастинга учитывают несохранённые изменения и выполняющуюся операцию. */
export function CastToolbar({ busy, dirty, hasManifest, hasCast, onInit, onSave }: CastToolbarProps): ReactElement {
  return (
    <PageActionBar>
      <Typography variant="h5" sx={{ flex: 1 }}>
        Кастинг
      </Typography>
      <Button variant="outlined" color="success" startIcon={<SyncIcon />} disabled={busy || dirty || !hasManifest} onClick={onInit}>
        {hasCast ? 'Дополнить из исходников' : 'Создать из исходников'}
      </Button>
      <Button variant="contained" startIcon={<SaveIcon />} disabled={busy || !dirty} onClick={onSave}>
        Сохранить
      </Button>
    </PageActionBar>
  );
}
