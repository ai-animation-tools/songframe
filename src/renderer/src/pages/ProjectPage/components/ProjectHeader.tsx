/** Название проекта, пути и действия над открытой папкой. */

import type { ReactElement } from 'react';
import { Box, Button, Typography } from '@mui/material';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import CloseIcon from '@mui/icons-material/Close';
import { PageActionBar } from '../../../components/PageActionBar';
import { useNavigate } from 'react-router-dom';
import type { ProjectStatus } from '@shared/types';
import { StateChip } from '../../../components';

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
    <>
      <PageActionBar>
        <Typography variant="h5">{status.name}</Typography>
        <Button size="small" startIcon={<EditOutlinedIcon />} onClick={onRename}>
          Переименовать
        </Button>
        <StateChip state={status.state} />
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<RefreshIcon />} onClick={onRefresh}>
          Обновить
        </Button>
        <Button size="small" startIcon={<FolderOpenIcon />} onClick={onOpenFolder} loading={openingFolder}>
          Открыть папку
        </Button>
        <Button size="small" startIcon={<FactCheckIcon />} onClick={() => navigate('/project/checks')}>
          Проверки
        </Button>
        <Button size="small" startIcon={<SwapHorizIcon />} onClick={() => navigate('/projects')}>
          Сменить проект
        </Button>
        <Button size="small" color="inherit" startIcon={<CloseIcon />} onClick={onClose}>
          Закрыть
        </Button>
      </PageActionBar>
      <Typography variant="body2" color="text.secondary">
        {status.path}
        {status.animaticVideo ? ` · MP4 аниматика: ${status.animaticVideo}` : ''}
      </Typography>
    </>
  );
}
