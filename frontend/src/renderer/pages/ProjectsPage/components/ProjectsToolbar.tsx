import { projectsTexts } from '@shared/texts/projects';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import type { ReactElement } from 'react';
import { PageActionBar } from '../../../components/PageActionBar';
import { Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import AddIcon from '@mui/icons-material/Add';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';

interface ProjectsToolbarProps {
  busy: boolean;
  onPickFolder: () => void;
  onCreateProject: () => void;
}

/** Общая панель выбора и создания проекта блокируется на время открытия папки. */
export function ProjectsToolbar({ busy, onPickFolder, onCreateProject }: ProjectsToolbarProps): ReactElement {
  const busyReason = projectsTexts.opening;
  return (
    <PageActionBar>
      <Typography variant="h5" sx={{ flex: 1 }}>
        {navigationTexts.pages.projects}
      </Typography>
      <ActionButton variant="outlined" startIcon={<FolderOpenIcon />} disabled={busy} disabledReason={busyReason} onClick={onPickFolder}>
        {commonTexts.openFolder}
      </ActionButton>
      <ActionButton variant="contained" color="success" startIcon={<AddIcon />} disabled={busy} disabledReason={busyReason} onClick={onCreateProject}>
        {navigationTexts.pages.newProject}
      </ActionButton>
    </PageActionBar>
  );
}
