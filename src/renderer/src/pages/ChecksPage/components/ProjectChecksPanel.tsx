import { checksTexts } from '@shared/texts/checks';
import { navigationTexts } from '@shared/texts/navigation';
import type { ReactElement } from 'react';
import { Box, Divider, Paper, Stack, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import type { CheckInfo } from '@shared/types';
import type { CheckOutcome } from '../types';
import { CheckRow } from './CheckRow';
import { ANCHORS } from '../../../components/linkTargets';
import { ActionButton } from '../../../components/ActionButton';

interface ProjectChecksPanelProps {
  checks: CheckInfo[];
  disabled: boolean;
  /** Почему проверки сейчас нельзя запустить. */
  disabledReason: string | null;
  strict: boolean;
  next: boolean;
  setStrict: (value: boolean) => void;
  setNext: (value: boolean) => void;
  runAll: () => Promise<void>;
  outcome: (check: CheckInfo) => CheckOutcome | null;
  updateViews: (check: CheckInfo) => Promise<void>;
  runCheck: (check: CheckInfo) => Promise<void>;
}

/** Объединяет общий запуск и отдельные проверки реестра сцен. */
export function ProjectChecksPanel({
  checks,
  disabled,
  disabledReason,
  strict,
  next,
  setStrict,
  setNext,
  runAll,
  outcome,
  updateViews,
  runCheck
}: ProjectChecksPanelProps): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-anchor={ANCHORS.checksProject}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <PlaylistAddCheckIcon color="action" />
        <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }}>
          {navigationTexts.blocks.checksProject}
        </Typography>
      </Box>
      <Stack divider={<Divider />} spacing={1}>
        {checks.map((check) => (
          <CheckRow
            key={check.id}
            check={check}
            result={outcome(check)}
            disabled={disabled}
            disabledReason={disabledReason}
            strict={strict}
            next={next}
            setStrict={setStrict}
            setNext={setNext}
            onUpdateViews={() => updateViews(check)}
            onRun={() => runCheck(check)}
          />
        ))}
      </Stack>
      <ActionButton
        sx={{ mt: 1 }}
        variant="contained"
        size="small"
        startIcon={<PlayArrowIcon />}
        disabled={disabled}
        disabledReason={disabledReason}
        onClick={runAll}
      >
        {checksTexts.runAll}
      </ActionButton>
    </Paper>
  );
}
