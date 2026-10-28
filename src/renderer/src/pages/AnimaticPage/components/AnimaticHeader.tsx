/** Состояние текущей сборки и команды проверки и сборки. */

import type { ReactElement } from 'react';
import { Box, Button, Chip, Tooltip, Typography } from '@mui/material';
import BuildIcon from '@mui/icons-material/Build';
import RefreshIcon from '@mui/icons-material/Refresh';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import type { AnimaticView } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { ActionButton, JobStatus } from '../../../components';

export function AnimaticHeader({
  built,
  accepted,
  running,
  blockedReason,
  onRefresh,
  onBuild
}: {
  built: AnimaticView['built'];
  accepted: boolean;
  running: boolean;
  /** Сборка недоступна до утверждения актуального сценария: причина видна в подсказке кнопок. */
  blockedReason?: string | null;
  onRefresh: () => unknown;
  onBuild: (planOnly: boolean) => Promise<void>;
}): ReactElement {
  const disabled = running || !!blockedReason;
  const disabledReason = running ? 'Дождитесь завершения сборки.' : blockedReason;
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
      {/* Индикатор сборки в закреплённой панели виден при любой прокрутке. */}
      <JobStatus running={running} />
      <Box sx={{ flex: 1 }} />
      <Button startIcon={<RefreshIcon />} onClick={onRefresh}>
        Обновить
      </Button>
      <ActionButton
        title="Проверить материалы и длительности без сборки видео"
        startIcon={<FactCheckIcon />}
        disabled={disabled}
        disabledReason={disabledReason}
        onClick={() => onBuild(true)}
      >
        Проверить
      </ActionButton>
      {built ? (
        // Назначение показывается у доступной кнопки; у выключенной подсказку с причиной даёт сама кнопка.
        <Tooltip title={disabled ? '' : 'Обновить карточки и собрать видео. Текущий результат будет заменён'}>
          <span>
            <DestructiveButton
              label="Пересобрать"
              description="Текущий результат сборки будет заменён. После пересборки результат потребуется проверить заново."
              confirmLabel="Пересобрать"
              startIcon={<BuildIcon />}
              size="medium"
              disabled={disabled}
              disabledReason={disabledReason}
              onConfirm={() => void onBuild(false)}
            />
          </span>
        </Tooltip>
      ) : (
        <ActionButton
          title="Обновить карточки и собрать видео"
          variant="contained"
          startIcon={<BuildIcon />}
          disabled={disabled}
          disabledReason={disabledReason}
          onClick={() => onBuild(false)}
        >
          Собрать
        </ActionButton>
      )}
    </Box>
  );
}
