import type { ReactElement } from 'react';
import { Paper, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';

export interface ComparisonField {
  label: string;
  before: unknown;
  after: unknown;
}

/** Одинаковые поля остаются видимыми рядом с изменёнными, чтобы оценить предложение в контексте. */
export function ScenarioComparison({ title, fields }: { title: string; fields: ComparisonField[] }): ReactElement {
  const render = (value: unknown): string => {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
    return typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value, null, 2);
  };
  return (
    <Paper variant="outlined" sx={{ overflow: 'auto' }}>
      <Typography variant="subtitle2" sx={{ p: 1.5 }}>
        {title}
      </Typography>
      <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 600 }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: '22%' }}>Поле</TableCell>
            <TableCell>До</TableCell>
            <TableCell>Предложение</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {fields.map((field) => (
            <TableRow key={field.label} sx={JSON.stringify(field.before) === JSON.stringify(field.after) ? {} : { bgcolor: 'action.hover' }}>
              <TableCell sx={{ verticalAlign: 'top' }}>{field.label}</TableCell>
              <TableCell sx={{ verticalAlign: 'top', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{render(field.before)}</TableCell>
              <TableCell sx={{ verticalAlign: 'top', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{render(field.after)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}
