import { commonTexts } from '@shared/texts/common';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { Alert, AlertTitle, Button, Stack, Typography } from '@mui/material';
import TheatersIcon from '@mui/icons-material/Theaters';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { ScenarioStatus } from '@shared/scenario-status';
import { LinkedText } from './LinkedText';

/** Отсутствие сценария оформляется одинаково на всех зависимых страницах, на всю рабочую ширину. */
export function ScenarioRequired({
  title,
  status,
  onRefresh
}: {
  title: string;
  status: Exclude<ScenarioStatus, 'ready'>;
  onRefresh: () => void;
}): ReactElement {
  const heading = status === 'missing' ? commonTexts.scenario.missing : status === 'empty' ? commonTexts.scenario.empty : commonTexts.scenario.invalid;
  const message = status === 'missing' ? commonTexts.scenario.create : status === 'empty' ? commonTexts.scenario.addScenes : commonTexts.scenario.repair;
  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <Typography variant="h5">{title}</Typography>
      <Alert severity={status === 'invalid' ? 'error' : 'info'}>
        <AlertTitle>{heading}</AlertTitle>
        <LinkedText text={message} />
      </Alert>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        <Button component={Link} to="/project/scenario" variant="contained" startIcon={<TheatersIcon />}>
          {commonTexts.scenario.open}
        </Button>
        <Button startIcon={<RefreshIcon />} onClick={onRefresh}>
          {commonTexts.refresh}
        </Button>
      </Stack>
    </Stack>
  );
}
