/** Сохранённые параметры запроса и переход к общему подтверждению отправки. */
import type { ReactElement } from 'react';
import { Box, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import { AiButton } from '../../../components/AiButton';
import type { PackageView } from '@shared/types';
import { ATTEMPT_LABELS, productionInputLabel } from '@shared/production-labels';
import { isExternalPackage } from '../decisions';
import { RequestModelSelection } from './RequestModelSelection';
import { RequestParameters } from './RequestParameters';
import { RequestPrompt } from './RequestPrompt';

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
        <Box sx={{ mb: 2, minWidth: 0 }}>
          <Typography variant="subtitle2" gutterBottom>
            {pkg.request.kind === 'image' ? 'Запрос изображения' : 'Запрос видео'}
          </Typography>
          <RequestModelSelection selection={pkg.request.modelSelection} />
          <Table size="small" sx={{ tableLayout: 'fixed', width: '100%', '& .MuiTableCell-root': { overflowWrap: 'anywhere' } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: '35%' }}>Параметр</TableCell>
                <TableCell>Значение</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              <TableRow>
                <TableCell>Исполнитель</TableCell>
                <TableCell>
                  {pkg.request.provider ?? 'не указан'}
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
          <Box sx={{ my: 2 }}>
            <RequestParameters parameters={pkg.request.parameters} />
          </Box>
          {pkg.request.promptText ? <RequestPrompt text={pkg.request.promptText} /> : null}
          {canSubmit ? (
            <Tooltip title={klingAvailable ? 'Платная отправка из приложения' : 'Kling не найден'}>
              <span>
                <AiButton
                  aiKind={pkg.request?.kind === 'image' ? 'image' : 'video'}
                  sx={{ mt: 1.5 }}
                  variant="contained"
                  startIcon={<SendIcon />}
                  disabled={busy || !klingAvailable}
                  onClick={onSubmit}
                >
                  Отправить
                </AiButton>
              </span>
            </Tooltip>
          ) : null}
        </Box>
      ) : null}
    </>
  );
}
