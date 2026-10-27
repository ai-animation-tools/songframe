import type { ReactElement } from 'react';
import { PageActionBar } from '../../../components/PageActionBar';
import { Button, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';

interface ProjectsToolbarProps {
  busy: boolean;
  onPickFolder: () => void;
  onCreateProject: () => void;
}

/** Общая панель выбора и создания проекта блокируется на время открытия папки. */
export function ProjectsToolbar({ busy, onPickFolder, onCreateProject }: ProjectsToolbarProps): ReactElement {
  return (
    <PageActionBar>
      <Typography variant="h5" sx={{ flex: 1 }}>
        Проекты
      </Typography>
      <Button variant="outlined" startIcon={<FolderOpenIcon />} disabled={busy} onClick={onPickFolder}>
        Открыть папку
      </Button>
      <Button variant="contained" color="success" startIcon={<AddIcon />} disabled={busy} onClick={onCreateProject}>
        Новый проект
      </Button>
    </PageActionBar>
  );
}
