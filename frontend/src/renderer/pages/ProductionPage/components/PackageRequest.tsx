import { productionTexts } from '@shared/texts/production';
/** Сохранённые параметры запроса и переход к общему подтверждению отправки. */
import type { ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Box, Stack, Table, TableBody, TableCell, TableRow, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SendIcon from '@mui/icons-material/Send';
import { AiButton } from '../../../components/AiButton';
import type { PackageView } from '@shared/types';
import { ATTEMPT_LABELS, productionInputLabel } from '@shared/production-labels';
import { MEDIA_PROVIDERS, mediaCommandLabel, normalizeMediaProvider } from '@shared/media-providers';
import { RequestModelSelection } from './RequestModelSelection';
import { RequestParameterRows } from './RequestParameters';
import { RequestPrompt } from './RequestPrompt';
import { BUSY_REASON } from '../constants';

export function PackageRequest({
  pkg,
  busy,
  busyReason = BUSY_REASON,
  providerAvailable,
  onSubmit
}: {
  pkg: PackageView;
  busy: boolean;
  /** Почему busy блокирует действия: идёт операция. */
  busyReason?: string;
  providerAvailable: boolean;
  onSubmit(): void;
}): ReactElement {
  const pending = pkg.pendingDecision;
  const canSubmit = !pending && ['request_choice', 'image_request_choice', 'ready'].includes(pkg.stage) && pkg.request?.attemptStatus === 'prepared';
  // Название исполнителя берётся из реестра провайдеров, а не из текста интерфейса.
  const providerId = normalizeMediaProvider(pkg.request?.provider);
  const providerTitle = providerId ? MEDIA_PROVIDERS[providerId].title : productionTexts.packageRequest.provider;
  return (
    <>
      {pkg.request ? (
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" gutterBottom>
            {pkg.request.kind === 'image' ? productionTexts.packageRequest.image : productionTexts.packageRequest.video}
          </Typography>
          <RequestModelSelection selection={pkg.request.modelSelection} />
          {/* Одна таблица на весь запрос: колонки сведений и параметров совпадают. */}
          <Table
            size="small"
            aria-label={pkg.request.kind === 'image' ? productionTexts.packageRequest.image : productionTexts.packageRequest.video}
            sx={{
              tableLayout: 'fixed',
              width: '100%',
              '& .MuiTableCell-root': { overflowWrap: 'anywhere', verticalAlign: 'top' },
              '& th.MuiTableCell-root': { width: '38%', color: 'text.secondary', fontWeight: 400, pl: 0 },
              '& td.MuiTableCell-root': { pr: 0 }
            }}
          >
            <TableBody>
              <TableRow>
                <TableCell component="th" scope="row">
                  {productionTexts.packageRequest.executor}
                </TableCell>
                <TableCell>
                  {providerTitle}
                  {pkg.request.command ? ` · ${mediaCommandLabel(providerId, pkg.request.command)}` : ''}
                </TableCell>
              </TableRow>
              {pkg.request.kind === 'image' && pkg.request.frameId ? (
                <TableRow>
                  <TableCell component="th" scope="row">
                    {productionTexts.packageRequest.frame}
                  </TableCell>
                  <TableCell>{pkg.request.frameId}</TableCell>
                </TableRow>
              ) : null}
              <TableRow>
                <TableCell component="th" scope="row">
                  {productionTexts.packageRequest.model}
                </TableCell>
                <TableCell>{pkg.request.model}</TableCell>
              </TableRow>
              <RequestParameterRows parameters={pkg.request.parameters} provider={providerId} />
              <TableRow>
                <TableCell component="th" scope="row">
                  {productionTexts.packageRequest.inputs}
                </TableCell>
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
                <TableCell component="th" scope="row">
                  {productionTexts.packageRequest.attempt}
                </TableCell>
                <TableCell>
                  {productionTexts.packageRequest.charged({
                    status: pkg.request.attemptStatus ? (ATTEMPT_LABELS[pkg.request.attemptStatus] ?? pkg.request.attemptStatus) : '—',
                    generationId: pkg.request.generationId,
                    credits: pkg.request.creditsConsumed
                  })}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <Accordion disableGutters elevation={0} sx={{ my: 1, '&::before': { display: 'none' } }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0 }}>
              <Typography variant="body2" color="text.secondary">
                {productionTexts.packageRequest.technical}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 0 }}>
              <Stack spacing={0.5}>
                <Typography variant="caption" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                  {`${productionTexts.packageRequest.command}: ${pkg.request.command ?? '—'}`}
                </Typography>
                <Typography variant="caption" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                  {`${productionTexts.packageRequest.apiParameters}: ${JSON.stringify(pkg.request.parameters)}`}
                </Typography>
                <Typography variant="caption" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                  {`${productionTexts.packageRequest.hash}: ${pkg.request.sha256 ?? '—'}`}
                </Typography>
              </Stack>
            </AccordionDetails>
          </Accordion>
          {pkg.request.promptText ? <RequestPrompt text={pkg.request.promptText} /> : null}
          {canSubmit ? (
            <AiButton
              aiKind={pkg.request?.kind === 'image' ? 'image' : 'video'}
              sx={{ mt: 1.5 }}
              variant="contained"
              startIcon={<SendIcon />}
              title={productionTexts.packageRequest.sendHint}
              disabled={busy || !providerAvailable}
              disabledReason={busy ? busyReason : productionTexts.packageRequest.providerMissing({ providerTitle })}
              onClick={onSubmit}
            >
              {productionTexts.packageRequest.send}
            </AiButton>
          ) : null}
        </Box>
      ) : null}
    </>
  );
}
