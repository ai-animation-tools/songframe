import { useId, type ReactElement } from 'react';
import { Stack, Table, TableBody, TableCell, TableRow, Typography } from '@mui/material';
import { ReadableValue } from '../../../components/ReadableValue';

/** Строка на параметр сохраняет имена API, а вложенный JSON читается без расширения диалога. */
export function RequestParameters({ parameters }: { parameters: Record<string, unknown> }): ReactElement {
  const labelId = useId();
  const entries = Object.entries(parameters);
  return (
    <Stack component="section" spacing={1} aria-labelledby={labelId} sx={{ minWidth: 0 }}>
      <Typography id={labelId} component="h3" variant="subtitle2">
        Параметры запроса
      </Typography>
      {entries.length ? (
        <Table size="small" aria-labelledby={labelId} sx={{ tableLayout: 'fixed', width: '100%' }}>
          <TableBody>
            {entries.map(([name, value]) => (
              <TableRow key={name}>
                <TableCell component="th" scope="row" sx={{ width: '35%', verticalAlign: 'top', overflowWrap: 'anywhere', pl: 0 }}>
                  {name}
                </TableCell>
                <TableCell sx={{ verticalAlign: 'top', overflowWrap: 'anywhere', pr: 0 }}>
                  <ReadableValue value={value} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Дополнительные параметры не заданы.
        </Typography>
      )}
    </Stack>
  );
}
