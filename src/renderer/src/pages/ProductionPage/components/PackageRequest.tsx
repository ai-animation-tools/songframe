/** Сохранённые параметры запроса и переход к общему подтверждению отправки. */
import type { ReactElement } from 'react';
import { Box, Button, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import type { PackageView } from '@shared/types';
import { ATTEMPT_LABELS, productionInputLabel } from '@shared/production-labels';
import { isExternalPackage } from '../decisions';
import { RequestModelSelection } from './RequestModelSelection';

export function PackageRequest({
  pkg,
  busy,
  klingAvailable,
  onSubmit
}: {
  pkg: PackageView;
  busy: boolean;
  klingAvailable: boolean;
  onSubmit(): void;
}): ReactElement {
  const pending = pkg.pendingDecision;
  const canSubmit =
    !isExternalPackage(pkg) && !pending && ['request_choice', 'image_request_choice', 'ready'].includes(pkg.stage) && pkg.request?.attemptStatus === 'prepared';
  return (
    <>
      {pkg.request ? (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            {pkg.request.kind === 'image' ? 'Запрос изображения' : 'Запрос видео'}
          </Typography>
          <RequestModelSelection selection={pkg.request.modelSelection} />
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Параметр</TableCell>
                <TableCell>Значение</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              <TableRow>
                <TableCell>Исполнитель</TableCell>
                <TableCell>
                  {pkg.request.provider ?? 'kling'}
                  {pkg.request.command ? ` · ${pkg.request.command}` : ''}
                </TableCell>
              </TableRow>
              {pkg.request.kind === 'image' && pkg.request.frameId ? (
                <TableRow>
                  <TableCell>Опорный кадр</TableCell>
                  <TableCell>{pkg.request.frameId}</TableCell>
                </TableRow>
              ) : null}
              <TableRow>
                <TableCell>Модель</TableCell>
                <TableCell>{pkg.request.model}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Параметры</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{JSON.stringify(pkg.request.parameters)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Входные материалы</TableCell>
                <TableCell>
                  {pkg.request.inputs.map((input) => (
                    <Typography
                      key={`${input.slot}:${input.path}`}
                      variant="caption"
                      display="block"
                      sx={{ overflowWrap: 'anywhere' }}
                    >{`${productionInputLabel(input)}: ${input.path}`}</Typography>
                  ))}
                  {!pkg.request.inputs.length ? '—' : null}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Попытка</TableCell>
                <TableCell>
                  {pkg.request.attemptStatus ? (ATTEMPT_LABELS[pkg.request.attemptStatus] ?? pkg.request.attemptStatus) : '—'}
                  {pkg.request.generationId ? ` · ID ${pkg.request.generationId}` : ''}
                  {pkg.request.creditsConsumed !== null ? ` · списано ${pkg.request.creditsConsumed}` : ''}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Хеш запроса (SHA-256)</TableCell>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 11 }}>{pkg.request.sha256 ?? '—'}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          {pkg.request.promptText ? (
            <Typography component="pre" variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto', mt: 1 }}>
              {pkg.request.promptText}
            </Typography>
          ) : null}
          {canSubmit ? (
            <Tooltip title={klingAvailable ? 'Платная отправка из приложения' : 'Kling CLI не найден'}>
              <span>
                <Button sx={{ mt: 1.5 }} variant="contained" startIcon={<SendIcon />} disabled={busy || !klingAvailable} onClick={onSubmit}>
                  Отправить
                </Button>
              </span>
            </Tooltip>
          ) : null}
        </Box>
      ) : null}
    </>
  );
}
