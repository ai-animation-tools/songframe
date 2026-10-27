/** Состояние текущей сборки и команды проверки и сборки. */

import type { ReactElement } from 'react';
import { Box, Button, Chip, Tooltip, Typography } from '@mui/material';
import BuildIcon from '@mui/icons-material/Build';
import RefreshIcon from '@mui/icons-material/Refresh';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import type { AnimaticView } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';

export function AnimaticHeader({
  built,
  accepted,
  running,
  onRefresh,
  onBuild
}: {
  built: AnimaticView['built'];
  accepted: boolean;
  running: boolean;
  onRefresh: () => unknown;
  onBuild: (planOnly: boolean) => Promise<void>;
}): ReactElement {
  return (
    <Box sx={{ display: 'flex', width: '100%', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Typography variant="h5">Аниматик</Typography>
      {built ? (
        <Chip
          size="small"
          color={accepted ? 'success' : built.fresh ? 'info' : 'warning'}
          label={accepted ? 'принят' : built.fresh ? 'собран, на просмотре' : 'устарел'}
        />
      ) : (
        <Chip size="small" variant="outlined" label="не собран" />
      )}
      <Box sx={{ flex: 1 }} />
      <Button size="small" startIcon={<RefreshIcon />} onClick={onRefresh}>
        Обновить
      </Button>
      <Tooltip title="Проверить материалы и длительности без сборки видео">
        <span>
          <Button size="small" variant="contained" startIcon={<FactCheckIcon />} disabled={running} onClick={() => onBuild(true)}>
            Проверить
          </Button>
        </span>
      </Tooltip>
      <Tooltip title="Обновить карточки и собрать видео. Текущий результат будет заменён">
        <span>
          {built ? (
            <DestructiveButton
              label="Пересобрать"
              description="Текущий результат сборки будет заменён. После пересборки результат потребуется проверить заново."
              confirmLabel="Пересобрать"
              startIcon={<BuildIcon />}
              disabled={running}
              onConfirm={() => void onBuild(false)}
            />
          ) : (
            <Button size="small" variant="contained" startIcon={<BuildIcon />} disabled={running} onClick={() => onBuild(false)}>
              Собрать
            </Button>
          )}
        </span>
      </Tooltip>
    </Box>
  );
}
