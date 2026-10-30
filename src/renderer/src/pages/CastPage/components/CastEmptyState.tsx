import type { ReactElement } from 'react';
import { Paper, Typography } from '@mui/material';
import { castTexts } from '@shared/texts/cast';
import { LinkedText } from '../../../components/LinkedText';

/** Ошибка чтения не означает первый запуск: ручные правки могут оставаться в повреждённом файле. */
export function CastEmptyState({ hasReadProblem }: { hasReadProblem: boolean }): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Typography color="text.secondary">
        <LinkedText text={hasReadProblem ? castTexts.unreadable : castTexts.empty} />
      </Typography>
    </Paper>
  );
}
