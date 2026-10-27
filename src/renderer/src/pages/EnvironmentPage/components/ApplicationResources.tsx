import type { ReactElement } from 'react';
import { Box, Button, Paper, Typography } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import type { AppState } from '@shared/types';

interface ApplicationResourcesProps {
  state: AppState | null;
  onChooseToolsRoot: () => Promise<void>;
  onResetToolsRoot: () => Promise<void>;
}

/** Выбор checkout доступен только при запуске из исходников без найденных ресурсов. */
export function ApplicationResources({ state, onChooseToolsRoot, onResetToolsRoot }: ApplicationResourcesProps): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        Ресурсы приложения
      </Typography>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {state?.toolsRoot ? state.toolsRoot : state ? 'Ресурсы не найдены.' : 'Определяем ресурсы…'}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
        Локальное состояние (текущий проект, история): {state?.localDir}
      </Typography>
      {state?.packaged ? (
        <Typography variant="body2" color="text.secondary">
          Ресурсы входят в приложение и определяются автоматически. Состояние хранится отдельно и сохраняется после обновления приложения.
        </Typography>
      ) : state?.packaged === false && !state.toolsRoot ? (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary" sx={{ width: '100%' }}>
            Только для запуска из исходников: укажите репозиторий или восстановите автоматический поиск.
          </Typography>
          <Button size="small" variant="outlined" startIcon={<FolderOpenIcon />} onClick={onChooseToolsRoot}>
            Указать папку исходников
          </Button>
          <Button size="small" startIcon={<ManageSearchIcon />} onClick={onResetToolsRoot}>
            Определять автоматически
          </Button>
        </Box>
      ) : null}
    </Paper>
  );
}
