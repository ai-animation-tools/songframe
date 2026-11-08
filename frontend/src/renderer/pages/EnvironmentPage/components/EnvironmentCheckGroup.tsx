import { environmentTexts } from '@shared/texts/environment';
import type { ReactElement } from 'react';
import { List, Paper, Typography } from '@mui/material';
import type { EnvironmentCheck } from '@shared/types';
import { EnvironmentCheckRow, type EnvironmentCheckCategory, type ProviderLogin } from './EnvironmentCheckRow';

interface EnvironmentCheckGroupProps {
  title: string;
  items: EnvironmentCheck[];
  category: EnvironmentCheckCategory;
  logins?: Record<string, ProviderLogin>;
}

/** Группа объединяет строки диагностики и объясняет назначение необязательных CLI. */
export function EnvironmentCheckGroup({ title, items, category, logins }: EnvironmentCheckGroupProps): ReactElement {
  return (
    <Paper variant="outlined">
      <Typography variant="subtitle1" sx={{ px: 2, pt: 1 }}>
        {title}
      </Typography>
      {category === 'external' ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pt: 1 }}>
          {environmentTexts.externalExplanation}
        </Typography>
      ) : null}
      <List dense disablePadding>
        {items.map((check) => (
          <EnvironmentCheckRow key={check.id} check={check} category={category} logins={logins} />
        ))}
      </List>
    </Paper>
  );
}
