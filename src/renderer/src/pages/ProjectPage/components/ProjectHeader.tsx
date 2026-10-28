/** Название проекта и действия над открытой папкой; путь и статус уже показаны в шапке приложения. */

import type { ReactElement } from 'react';
import { Box, Button, Typography } from '@mui/material';
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
      <Box sx={{ flex: 1 }} />
      <Button startIcon={<RefreshIcon />} onClick={onRefresh}>
        Обновить
      </Button>
      <Button startIcon={<EditOutlinedIcon />} onClick={onRename}>
        Переименовать
      </Button>
      <Button startIcon={<FolderOpenIcon />} onClick={onOpenFolder} loading={openingFolder}>
        Открыть папку
      </Button>
      <Button startIcon={<SwapHorizIcon />} onClick={() => navigate('/projects')}>
        Сменить проект
      </Button>
      <Button color="inherit" startIcon={<CloseIcon />} onClick={onClose}>
        Закрыть
      </Button>
    </PageActionBar>
  );
}
