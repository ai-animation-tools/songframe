import CheckIcon from '@mui/icons-material/Check';
import RefreshIcon from '@mui/icons-material/Refresh';
/** Общее подтверждение платной отправки с замороженным промптом, входами и хешем запроса. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import { canAgreeToUnknownCost, formatCredits, priceAllowsGeneration } from '@shared/generation-consent';
import { aiActionProblem } from '@shared/ai-access';
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
  onConfirm(quoteToken?: string, unknownCostConsentToken?: string): Promise<void>;
}): ReactElement {
  const { describeError, aiAccess } = useApp();
  const aiProblem = aiActionProblem(aiAccess, pkg?.request?.kind === 'image' ? 'image' : 'video');
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
  const [unknownCostConsentToken, setUnknownCostConsentToken] = useState<string | null>(null);
  const agreedToUnknownCost = !!quote && unknownCostConsentToken === quote.token;
  useEffect(() => {
    // Обновление оценки или пакета требует отдельного согласия, даже если SHA запроса прежний.
    setUnknownCostConsentToken(null);
  }, [quote?.token, project, pkg?.dir, pkg?.decisionToken]);
  useEffect(() => {
    setSendError(null);
  }, [pkg]);
  const confirm = async (): Promise<void> => {
    if (sendingNow.current || aiProblem || (!external && !priceAllowsGeneration(quote, agreedToUnknownCost))) return;
    sendingNow.current = true;
    const token = quote?.token;
    const consentToken = agreedToUnknownCost ? token : undefined;
    setUnknownCostConsentToken(null);
    consumeQuote();
    setSending(true);
    setSendError(null);
    try {
      await onConfirm(token, consentToken);
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
      title="Вы уверены, что промпт правильный?"
      cancelDisabled={sending}
      closeDisabled={sending}
      confirmDisabled={
        !!aiProblem ||
        busy ||
        sending ||
        loading ||
        !pkg?.request?.sha256 ||
        (!external && (!priceAllowsGeneration(quote, agreedToUnknownCost) || quote?.requestSha !== pkg.request.sha256))
      }
      confirmLabel="Отправить и списать кредиты"
      confirmIcon={external ? <AgentIcon provider={null} monochrome /> : <SendIcon />}
      onConfirm={() => void confirm()}
    >
      {pkg?.request ? (
        <Stack spacing={1} sx={{ mt: 1 }}>
          {aiProblem ? <Alert severity="info">{aiProblem}</Alert> : null}
          <Typography variant="body2">
            Проверьте промпт и материалы перед отправкой платного запроса. Подтверждение разрешает одну попытку генерации.
          </Typography>
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
                  Стоимость: {formatCredits(quote.credits)}. Остаток: {formatCredits(quote.balance)}.
                  {quote.verdict === 'insufficient_balance'
                    ? ' Кредитов недостаточно.'
                    : quote.verdict === 'cost_or_balance_unknown'
                      ? canAgreeToUnknownCost(quote)
                        ? ' Стоимость не подтверждена. Для отправки нужно явное согласие на списание неизвестного количества кредитов.'
                        : ' Остаток кредитов не подтверждён, отправка недоступна.'
                      : ''}
                  {quote.reasons.length ? ` ${quote.reasons.join(' ')}` : ''}
                  {canAgreeToUnknownCost(quote) ? (
                    <Stack spacing={1} sx={{ mt: 1 }}>
                      {agreedToUnknownCost ? <Typography variant="body2">Вы согласились отправить этот запрос с неизвестной стоимостью.</Typography> : null}
                      <Button
                        startIcon={<CheckIcon />}
                        sx={{ alignSelf: 'start' }}
                        disabled={!!aiProblem || loading || sending || busy || agreedToUnknownCost}
                        onClick={() => setUnknownCostConsentToken(quote.token)}
                      >
                        Я согласен
                      </Button>
                    </Stack>
                  ) : null}
                </Alert>
              ) : null}
              <Button startIcon={<RefreshIcon />} sx={{ alignSelf: 'start' }} disabled={!!aiProblem || loading || sending || busy} onClick={refreshQuote}>
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
