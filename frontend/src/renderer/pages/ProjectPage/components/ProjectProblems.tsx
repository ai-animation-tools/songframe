/** Проблемы проекта; при производстве они уже показаны в подсказке следующего шага. */

import type { ReactElement } from 'react';
import { Alert } from '@mui/material';
import type { ProjectStatus } from '@shared/types';
import { LinkedText } from '../../../components/LinkedText';

export function ProjectProblems({ status }: { status: ProjectStatus }): ReactElement | null {
  return status.problems.length && status.state !== 'in_production' ? (
    <Alert severity="warning">
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {status.problems.map((p) => (
          <li key={p}>
            <LinkedText text={p} />
          </li>
        ))}
      </ul>
    </Alert>
  ) : null;
}
