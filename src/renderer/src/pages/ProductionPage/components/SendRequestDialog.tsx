import CheckIcon from '@mui/icons-material/Check';
import RefreshIcon from '@mui/icons-material/Refresh';
/** Общее подтверждение платной отправки с замороженным промптом, входами и хешем запроса. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import { canAgreeToUnknownCost, priceAllowsGeneration, priceNotice } from '@shared/generation-consent';
import { mediaProviderInfo, normalizeMediaProvider } from '@shared/media-providers';
import { aiActionProblem } from '@shared/ai-access';
import type { PackageView } from '@shared/types';
import { productionInputLabel } from '@shared/production-labels';
import { useApp } from '../../../state';
import { useRequestQuote } from '../useRequestQuote';
import { RequestModelSelection } from './RequestModelSelection';
import { RequestParameters } from './RequestParameters';
import { RequestPrompt } from './RequestPrompt';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { ActionButton } from '../../../components/ActionButton';
import { BUSY_REASON } from '../constants';

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
  const { quote, error, loading, refreshQuote, consumeQuote } = useRequestQuote(project, pkg);
  // Название и правила цены берём у провайдера запроса из реестра, а не по имени сервиса.
  const providerInfo = pkg?.request ? mediaProviderInfo(normalizeMediaProvider(pkg.request.provider), pkg.request.kind === 'image' ? 'image' : 'video') : null;
  const providerTitle = providerInfo?.title ?? pkg?.request?.provider ?? 'сервисе';
  const notice = priceNotice(quote, providerInfo);
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
  // Причины по тем же ветвям, что и блокировка кнопок: подсказка выключенной кнопки говорит, что сделать дальше.
  const commonReason = aiProblem ?? (sending ? 'Запрос уже отправляется.' : busy ? BUSY_REASON : loading ? 'Дождитесь проверки стоимости.' : null);
  const priceReason = !quote
    ? 'Стоимость не проверена: нажмите «Обновить стоимость».'
    : quote.verdict === 'insufficient_balance'
      ? 'Кредитов недостаточно: пополните баланс и обновите стоимость.'
      : canAgreeToUnknownCost(quote) && !agreedToUnknownCost
        ? 'Стоимость неизвестна: нажмите «Я согласен», чтобы разрешить один запрос.'
        : !priceAllowsGeneration(quote, agreedToUnknownCost)
          ? 'Остаток кредитов не подтверждён: обновите стоимость.'
          : null;
  const confirmReason =
    commonReason ??
    (!pkg?.request?.sha256
      ? 'У запроса нет хеша: подготовьте запрос заново.'
      : (priceReason ?? (quote?.requestSha !== pkg.request.sha256 ? 'Стоимость проверена для другой версии запроса: обновите стоимость.' : null)));
  const confirm = async (): Promise<void> => {
    if (sendingNow.current || aiProblem || !priceAllowsGeneration(quote, agreedToUnknownCost)) return;
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
      cancelDisabledReason="Дождитесь окончания отправки запроса."
      closeDisabled={sending}
      confirmDisabled={
        !!aiProblem ||
        busy ||
        sending ||
        loading ||
        !pkg?.request?.sha256 ||
        !priceAllowsGeneration(quote, agreedToUnknownCost) ||
        quote?.requestSha !== pkg.request.sha256
      }
      confirmDisabledReason={confirmReason}
      confirmLabel="Отправить и списать кредиты"
      confirmIcon={<SendIcon />}
      onConfirm={() => void confirm()}
    >
      {pkg?.request ? (
        <Stack spacing={2} sx={{ mt: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
          <Typography variant="body2">
            Проверьте промпт и материалы перед отправкой платного запроса. Подтверждение разрешает одну попытку генерации.
          </Typography>
          <RequestModelSelection selection={pkg.request.modelSelection} />
          <Typography variant="body2">
            План {pkg.shot}
            {pkg.request.kind === 'image' && pkg.request.frameId ? `, опора ${pkg.request.frameId}` : ''}, провайдер {pkg.request.provider ?? 'не указан'}
            {pkg.request.command ? `, команда ${pkg.request.command}` : ''}, модель {pkg.request.model}.
          </Typography>
          <RequestParameters parameters={pkg.request.parameters} />
          {pkg.request.promptText ? <RequestPrompt text={pkg.request.promptText} /> : null}
          {pkg.request.inputs.map((input) => (
            <Typography key={`${input.slot}:${input.path}`} variant="caption">
              {productionInputLabel(input)}: {input.path}
            </Typography>
          ))}
          <Typography variant="body2">
            Это платная операция: будут списаны кредиты аккаунта {providerTitle}. Запрос отправляется ровно один раз, затем приложение ждёт результат и запишет
            его в пакет.
          </Typography>
          <Stack spacing={1}>
            {loading ? <Alert severity="info">Проверяем стоимость запроса и остаток кредитов в {providerTitle}.</Alert> : null}
            {error ? <Alert severity="error">{error}</Alert> : null}
            {quote && notice ? (
              <Alert severity={notice.severity}>
                {notice.text}
                {/* Технические причины инструмента нужны, только когда цену не узнать обычным путём. */}
                {quote.reasons.length && notice.severity !== 'info' ? ` ${quote.reasons.join(' ')}` : ''}
                {canAgreeToUnknownCost(quote) ? (
                  <Stack spacing={1} sx={{ mt: 1 }}>
                    {agreedToUnknownCost ? <Typography variant="body2">Вы согласились отправить этот запрос с неизвестной стоимостью.</Typography> : null}
                    <ActionButton
                      startIcon={<CheckIcon />}
                      sx={{ alignSelf: 'start' }}
                      disabled={!!aiProblem || loading || sending || busy || agreedToUnknownCost}
                      disabledReason={commonReason ?? 'Согласие на этот запрос уже дано.'}
                      onClick={() => setUnknownCostConsentToken(quote.token)}
                    >
                      Я согласен
                    </ActionButton>
                  </Stack>
                ) : null}
              </Alert>
            ) : null}
            <ActionButton
              startIcon={<RefreshIcon />}
              sx={{ alignSelf: 'start' }}
              disabled={!!aiProblem || loading || sending || busy}
              disabledReason={commonReason}
              onClick={refreshQuote}
            >
              Обновить стоимость
            </ActionButton>
          </Stack>
          {sendError ? (
            <Alert severity="error">{sendError} Закройте диалог для проверки состояния пакета или обновите стоимость для нового подтверждения.</Alert>
          ) : null}
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
            Хеш запроса (SHA-256): {pkg.request.sha256}
          </Typography>
        </Stack>
      ) : null}
    </ConfirmationDialog>
  );
}
