import { projectTexts } from '@shared/texts/project';
import { commonTexts } from '@shared/texts/common';
/** Название и частота кадров проекта, действия над открытой папкой; путь и статус уже показаны в шапке приложения. */

import type { ReactElement } from 'react';
import { Box, Button, Chip, Tooltip, Typography } from '@mui/material';
import { projectsTexts } from '@shared/texts/projects';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import CloseIcon from '@mui/icons-material/Close';
import { PageActionBar } from '../../../components/PageActionBar';
import { useNavigate } from 'react-router-dom';
import type { ProjectStatus } from '@shared/types';

interface ProjectHeaderProps {
  status: ProjectStatus;
  onRefresh: () => Promise<void>;
  onOpenFolder: () => Promise<void>;
  onClose: () => Promise<void>;
  onRename: () => void;
  openingFolder: boolean;
}

export function ProjectHeader({ status, onRefresh, onOpenFolder, onClose, onRename, openingFolder }: ProjectHeaderProps): ReactElement {
  const navigate = useNavigate();
  return (
    <PageActionBar>
      <Typography variant="h5">{status.name}</Typography>
      {/* Недопустимая частота показана среди проблем проекта; здесь — только действующая сетка. */}
      {status.fps !== null ? (
        <Tooltip title={projectsTexts.projectFrameRateHint}>
          <Chip color="primary" variant="outlined" label={projectsTexts.projectFrameRate(status.fps)} />
        </Tooltip>
      ) : null}
      <Box sx={{ flex: 1 }} />
      <Button startIcon={<RefreshIcon />} onClick={onRefresh}>
        {commonTexts.refresh}
      </Button>
      <Button startIcon={<EditOutlinedIcon />} onClick={onRename}>
        {commonTexts.rename}
      </Button>
      <Button startIcon={<FolderOpenIcon />} onClick={onOpenFolder} loading={openingFolder}>
        {commonTexts.openFolder}
      </Button>
      <Button startIcon={<SwapHorizIcon />} onClick={() => navigate('/projects')}>
        {projectTexts.changeProject}
      </Button>
      <Button color="inherit" startIcon={<CloseIcon />} onClick={onClose}>
        {commonTexts.close}
      </Button>
    </PageActionBar>
  );
}
