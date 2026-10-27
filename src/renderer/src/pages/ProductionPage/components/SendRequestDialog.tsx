import RefreshIcon from '@mui/icons-material/Refresh';
/** Общее подтверждение платной отправки с замороженным промптом, входами и хешем запроса. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import type { PackageView } from '@shared/types';
import { productionInputLabel } from '@shared/production-labels';
import { AgentIcon } from '../../../components';
import { useApp } from '../../../state';
import { useRequestQuote } from '../useRequestQuote';
import { RequestModelSelection } from './RequestModelSelection';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

export function SendRequestDialog({
  project,
  pkg,
  busy,
  onClose,
  onConfirm
}: {
  project: string;
  pkg: PackageView | null;
  busy: boolean;
  onClose(): void;
  onConfirm(quoteToken?: string): Promise<void>;
}): ReactElement {
  const { describeError } = useApp();
  const { quote, error, loading, external, refreshQuote, consumeQuote } = useRequestQuote(project, pkg);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sendingNow = useRef(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  useEffect(() => {
    setSendError(null);
  }, [pkg]);
  const confirm = async (): Promise<void> => {
    if (sendingNow.current) return;
    sendingNow.current = true;
    const token = quote?.token;
    consumeQuote();
    setSending(true);
    setSendError(null);
    try {
      await onConfirm(token);
    } catch (reason) {
      if (mounted.current) setSendError(describeError(reason));
    } finally {
      sendingNow.current = false;
      if (mounted.current) setSending(false);
    }
  };
  return (
    <ConfirmationDialog
      open={!!pkg}
      onClose={onClose}
      title={
        external
          ? 'Разрешить отправку внешнему агенту'
          : pkg?.request?.kind === 'image'
            ? 'Отправить запрос изображения в Kling'
            : 'Отправить запрос видео в Kling'
      }
      cancelDisabled={sending}
      closeDisabled={sending}
      confirmDisabled={
        busy || sending || loading || !pkg?.request?.sha256 || (!external && (quote?.verdict !== 'ok' || quote.requestSha !== pkg.request.sha256))
      }
      confirmLabel="Отправить и списать кредиты"
      confirmIcon={external ? <AgentIcon provider={null} monochrome /> : <SendIcon />}
      onConfirm={() => void confirm()}
    >
      {pkg?.request ? (
        <Stack spacing={1} sx={{ mt: 1 }}>
          <RequestModelSelection selection={pkg.request.modelSelection} />
          <Typography variant="body2">
            План {pkg.shot}
            {pkg.request.kind === 'image' && pkg.request.frameId ? `, опора ${pkg.request.frameId}` : ''}, провайдер {pkg.request.provider ?? 'kling'}
            {pkg.request.command ? `, команда ${pkg.request.command}` : ''}, модель {pkg.request.model}, параметры {JSON.stringify(pkg.request.parameters)}.
          </Typography>
          {pkg.request.promptText ? (
            <Typography component="pre" variant="body2" sx={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>
              {pkg.request.promptText}
            </Typography>
          ) : null}
          {pkg.request.inputs.map((input) => (
            <Typography key={`${input.slot}:${input.path}`} variant="caption">
              {productionInputLabel(input)}: {input.path}
            </Typography>
          ))}
          {external ? <Alert severity="info">Исполнитель — внешний агент. Приложение запишет разрешение; отправку выполнит агент.</Alert> : null}
          <Typography variant="body2">
            Это платная операция: будут списаны кредиты аккаунта Kling. Запрос отправляется ровно один раз, затем приложение ждёт результат и запишет его в
            пакет.
          </Typography>
          {!external ? (
            <Stack spacing={1}>
              {loading ? <Alert severity="info">Проверяем стоимость запроса и остаток кредитов в Kling.</Alert> : null}
              {error ? <Alert severity="error">{error}</Alert> : null}
              {quote ? (
                <Alert severity={quote.verdict === 'ok' ? 'info' : 'warning'}>
                  Стоимость: {quote.credits ?? 'неизвестна'} кредитов. Остаток: {quote.balance ?? 'неизвестен'} кредитов.
                  {quote.verdict === 'insufficient_balance'
                    ? ' Кредитов недостаточно.'
                    : quote.verdict === 'cost_or_balance_unknown'
                      ? ' Стоимость или остаток не подтверждены, отправка недоступна.'
                      : ''}
                  {quote.reasons.length ? ` ${quote.reasons.join(' ')}` : ''}
                </Alert>
              ) : null}
              <Button startIcon={<RefreshIcon />} sx={{ alignSelf: 'start' }} disabled={loading || sending || busy} onClick={refreshQuote}>
                Обновить стоимость
              </Button>
            </Stack>
          ) : null}
          {sendError ? (
            <Alert severity="error">{sendError} Закройте диалог для проверки состояния пакета или обновите стоимость для нового подтверждения.</Alert>
          ) : null}
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
            Хеш запроса (SHA-256): {pkg.request.sha256}
          </Typography>
        </Stack>
      ) : null}
    </ConfirmationDialog>
  );
}
