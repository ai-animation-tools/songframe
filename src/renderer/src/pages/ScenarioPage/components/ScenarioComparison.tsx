import type { ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Box, Chip, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { ReadableValue } from '../../../components/ReadableValue';

export interface ComparisonField {
  label: string;
  before: unknown;
  after: unknown;
}

function same(field: ComparisonField): boolean {
  return JSON.stringify(field.before ?? null) === JSON.stringify(field.after ?? null);
}

/**
 * Блок сравнения сворачивается: изменённые блоки раскрыты, прочие свёрнуты, в заголовке число изменённых полей.
 * Одинаковые поля остаются рядом с изменёнными, чтобы оценить предложение в контексте.
 */
export function ScenarioComparison({ title, fields, defaultExpanded }: { title: string; fields: ComparisonField[]; defaultExpanded?: boolean }): ReactElement {
  const changed = fields.filter((field) => !same(field));
  const expanded = defaultExpanded ?? changed.length > 0;
  return (
    <Accordion defaultExpanded={expanded} disableGutters variant="outlined" sx={{ '&::before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ '& .MuiAccordionSummary-content': { alignItems: 'center', gap: 1, flexWrap: 'wrap' } }}>
        <Typography variant="subtitle2">{title}</Typography>
        {changed.length ? (
          <Chip
            size="small"
            color="warning"
            label={changed.length === 1 ? `изменено: ${changed[0].label}` : `изменено полей: ${changed.length}`}
            sx={{ height: 20 }}
          />
        ) : (
          <Chip size="small" variant="outlined" label="без изменений" sx={{ height: 20 }} />
        )}
      </AccordionSummary>
      <AccordionDetails sx={{ p: 0, overflow: 'auto' }}>
        <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 600 }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: '22%' }}>Поле</TableCell>
              <TableCell>Сейчас в проекте</TableCell>
              <TableCell>Предложение</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {fields.map((field) => (
              <TableRow key={field.label} sx={same(field) ? {} : { bgcolor: 'action.hover' }}>
                <TableCell sx={{ verticalAlign: 'top' }}>
                  <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
                    {field.label}
                    {same(field) ? null : <Chip size="small" color="warning" variant="outlined" label="изменено" sx={{ height: 18 }} />}
                  </Box>
                </TableCell>
                <TableCell sx={{ verticalAlign: 'top', overflowWrap: 'anywhere' }}>
                  <ReadableValue value={field.before} />
                </TableCell>
                <TableCell sx={{ verticalAlign: 'top', overflowWrap: 'anywhere' }}>
                  <ReadableValue value={field.after} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </AccordionDetails>
    </Accordion>
  );
}
