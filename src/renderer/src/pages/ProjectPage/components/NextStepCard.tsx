import { projectTexts } from '@shared/texts/project';
/** Следующий шаг и переход к соответствующему разделу проекта. */

import type { ReactElement } from 'react';
import { Button, Paper, Typography } from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { useNavigate } from 'react-router-dom';
import type { ProjectStatus } from '@shared/types';
import { nextStep } from '../nextStep';
import { LinkedText } from '../../../components/LinkedText';

export function NextStepCard({ status }: { status: ProjectStatus }): ReactElement {
  const navigate = useNavigate();
  const step = nextStep(status);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        {projectTexts.nextStep.title}
      </Typography>
      <Typography variant="h6" gutterBottom>
        {step.title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        <LinkedText text={step.text} />
      </Typography>
      {step.action ? (
        <Button variant="contained" startIcon={<ArrowForwardIcon />} onClick={() => navigate(step.action!.to)}>
          {step.action.label}
        </Button>
      ) : null}
    </Paper>
  );
}
