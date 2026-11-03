import { animaticTexts } from '@shared/texts/animatic';
/** Принятие текущей сборки или возврат на просмотр с учётом её свежести. */

import type { ReactElement } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import UndoIcon from '@mui/icons-material/Undo';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import type { AnimaticApproval, AnimaticView } from '@shared/types';

export function AnimaticAcceptance({
  built,
  accepted,
  approval,
  running,
  onConfirm
}: {
  built: NonNullable<AnimaticView['built']>;
  accepted: boolean;
  approval: AnimaticApproval;
  running: boolean;
  onConfirm: (status: 'approved' | 'review') => void;
}): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', flexDirection: 'column', gap: 1.5 }}>
        <Typography variant="subtitle1" fontWeight={600}>
          {animaticTexts.acceptance.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {accepted
            ? animaticTexts.acceptance.accepted
            : approval.status === 'approved'
              ? !built.fresh
                ? animaticTexts.acceptance.scenarioChanged
                : animaticTexts.acceptance.videoChanged
              : animaticTexts.acceptance.reviewInstruction}
        </Typography>
        {approval.current ? (
          <ActionButton
            size="small"
            disabled={running}
            disabledReason={animaticTexts.buildPending}
            startIcon={<UndoIcon />}
            onClick={() => onConfirm('review')}
          >
            {animaticTexts.acceptance.returnToReview}
          </ActionButton>
        ) : (
          <ActionButton
            size="small"
            variant="contained"
            color="primary"
            startIcon={<CheckCircleIcon />}
            disabled={running || !built.fresh || !built.videoPath}
            disabledReason={
              running
                ? animaticTexts.buildPending
                : !built.fresh
                  ? animaticTexts.acceptance.rebuildScenario
                  : !built.videoPath
                    ? animaticTexts.acceptance.buildFirst
                    : null
            }
            onClick={() => onConfirm('approved')}
          >
            {animaticTexts.acceptance.approve}
          </ActionButton>
        )}
      </Box>
    </Paper>
  );
}
