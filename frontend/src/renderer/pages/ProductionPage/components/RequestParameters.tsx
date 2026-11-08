import { productionTexts } from '@shared/texts/production';
import { useId, type ReactElement } from 'react';
import { Stack, Table, TableBody, TableCell, TableRow, Typography } from '@mui/material';
import { mediaParameterLabel } from '@shared/media-providers';
import { ReadableValue } from '../../../components/ReadableValue';

/** Строки параметров общей таблицы запроса: подпись из реестра провайдера, вложенный JSON читается целиком. */
export function RequestParameterRows({ parameters, provider }: { parameters: Record<string, unknown>; provider?: string | null }): ReactElement {
  return (
    <>
      {Object.entries(parameters).map(([name, value]) => (
        <TableRow key={name}>
          <TableCell component="th" scope="row">
            {mediaParameterLabel(provider, name)}
          </TableCell>
          <TableCell>
            <ReadableValue value={value} />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

/** Параметры отдельным блоком: подтверждение отправки и предложение агента. */
export function RequestParameters({ parameters, provider }: { parameters: Record<string, unknown>; provider?: string | null }): ReactElement {
  const labelId = useId();
  const entries = Object.entries(parameters);
  return (
    <Stack component="section" spacing={1} aria-labelledby={labelId} sx={{ minWidth: 0 }}>
      <Typography id={labelId} component="h3" variant="subtitle2">
        {productionTexts.requestParameters.heading}
      </Typography>
      {entries.length ? (
        <Table size="small" aria-labelledby={labelId} sx={{ tableLayout: 'fixed', width: '100%' }}>
          <TableBody>
            {entries.map(([name, value]) => (
              <TableRow key={name}>
                <TableCell component="th" scope="row" sx={{ width: '35%', verticalAlign: 'top', overflowWrap: 'anywhere', pl: 0 }}>
                  {mediaParameterLabel(provider, name)}
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
          {productionTexts.requestParameters.empty}
        </Typography>
      )}
    </Stack>
  );
}
