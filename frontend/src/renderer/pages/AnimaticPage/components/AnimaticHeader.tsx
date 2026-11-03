import { animaticTexts } from '@shared/texts/animatic';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
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
  const disabledReason = running ? animaticTexts.buildPending : blockedReason;
  return (
    <Box sx={{ display: 'flex', width: '100%', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Typography variant="h5">{navigationTexts.pages.animatic}</Typography>
      {built ? (
        <Chip
          size="small"
          color={accepted ? 'success' : built.fresh ? 'info' : 'warning'}
          label={accepted ? animaticTexts.header.accepted : built.fresh ? animaticTexts.header.review : animaticTexts.header.stale}
        />
      ) : (
        <Chip size="small" variant="outlined" label={animaticTexts.header.notBuilt} />
      )}
      {/* Индикатор сборки в закреплённой панели виден при любой прокрутке. */}
      <JobStatus running={running} />
      <Box sx={{ flex: 1 }} />
      <Button startIcon={<RefreshIcon />} onClick={onRefresh}>
        {commonTexts.refresh}
      </Button>
      <ActionButton
        title={animaticTexts.header.checkHint}
        startIcon={<FactCheckIcon />}
        disabled={disabled}
        disabledReason={disabledReason}
        onClick={() => onBuild(true)}
      >
        {commonTexts.check}
      </ActionButton>
      {built ? (
        // Назначение показывается у доступной кнопки; у выключенной подсказку с причиной даёт сама кнопка.
        <Tooltip title={disabled ? '' : animaticTexts.header.rebuildHint}>
          <span>
            <DestructiveButton
              label={animaticTexts.header.rebuild}
              description={animaticTexts.header.rebuildDescription}
              confirmLabel={animaticTexts.header.rebuild}
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
          title={animaticTexts.header.buildHint}
          variant="contained"
          startIcon={<BuildIcon />}
          disabled={disabled}
          disabledReason={disabledReason}
          onClick={() => onBuild(false)}
        >
          {commonTexts.build}
        </ActionButton>
      )}
    </Box>
  );
}
