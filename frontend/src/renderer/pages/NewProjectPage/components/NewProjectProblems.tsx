import type { ReactElement } from 'react';
import { Alert } from '@mui/material';
import { LinkedText } from '../../../components/LinkedText';

interface NewProjectProblemsProps {
  problems: string[];
}

/** Показывает все причины, по которым проверка параметров не разрешила создание. */
export function NewProjectProblems({ problems }: NewProjectProblemsProps): ReactElement {
  return (
    <Alert severity="warning">
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {problems.map((problem) => (
          <li key={problem}>
            <LinkedText text={problem} />
          </li>
        ))}
      </ul>
    </Alert>
  );
}
