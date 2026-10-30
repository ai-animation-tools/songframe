import { commonTexts } from '@shared/texts/common';
import { sourcesTexts } from '@shared/texts/sources';
/** Генерация и выбор обложки остаются временными до сохранения формы исходников. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Box, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import CheckIcon from '@mui/icons-material/Check';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { CoverCrop, CoverGenerationSession } from '@shared/cover-generation';
import { MEDIA_PROVIDERS, mediaProviderInfo } from '@shared/media-providers';
import { canAgreeToUnknownCost, formatCredits, priceAllowsGeneration, priceNotice } from '@shared/generation-consent';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { useApp } from '../../../state';
import { aiActionProblem } from '@shared/ai-access';
import { ActionButton } from '../../../components/ActionButton';
import { AgentButton } from '../../../components/AgentButton';
import { AiProblemAlert } from '../../../components/AiProblemAlert';
import { useCoverGeneration } from '../useCoverGeneration';
import { CoverCropEditor } from './CoverCropEditor';
import { centeredCrop } from './crop';

interface Props {
  project: string;
  idea: string;
  onAccepted: (result: { id: string; path: string }) => void;
  onClose: () => void;
}

export function CoverGenerateDialog({ project, idea, onAccepted, onClose }: Props): ReactElement {
  const { aiAccess } = useApp();
  // Обложку готовит провайдер изображений проекта; выбранный агент на неё не влияет.
  const blockedReason = aiActionProblem(aiAccess, 'image');
  const [prompt, setPrompt] = useState(() =>
    idea.trim()
      ? // eslint-disable-next-line no-restricted-syntax -- Исходная инструкция генерации принадлежит диалогу, а не словарю подписей интерфейса.
        `Создай выразительную квадратную обложку музыкального клипа.\n\nИдея клипа:\n${idea.trim()}`
      : ''
  );
  const [crop, setCrop] = useState<CoverCrop | null>(null);
  const { session, working, accepting, error, preparedSha, start, next, refreshQuote, generate, accept } = useCoverGeneration(project);
  const [agreedToken, setAgreedToken] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<CoverGenerationSession | null>(null);
  const preparingClick = useRef(false);
  const confirmingClick = useRef(false);
  const image = session?.image ?? null;
  const imagePath = image?.path;
  const width = image?.width;
  const height = image?.height;
  useEffect(() => {
    setCrop(width && height ? centeredCrop({ width, height }) : null);
  }, [imagePath, width, height]);

  const generating = session?.status === 'generating';
  const preparing = working || !!session?.preparing;
  // Платный провайдер показывает цену и требует её подтверждения; агент-исполнитель обозначается своим знаком.
  const info = session ? MEDIA_PROVIDERS[session.provider] : null;
  const paid = !!info?.paid;
  const confirmationInfo = confirmation ? MEDIA_PROVIDERS[confirmation.provider] : null;
  // До первой подготовки исполнитель известен из проверенного выбора проекта.
  const generationExecutor = mediaProviderInfo(session?.provider ?? aiAccess?.image.provider, 'image')?.executor ?? null;
  const prepared = !!preparedSha && preparedSha === session?.requestSha && !!session?.approvalToken;
  const quote = prepared ? session?.quote : null;
  const coverNotice = priceNotice(quote, info);
  const agreedToUnknownCost = !!session?.approvalToken && agreedToken === session.approvalToken;
  const unknownCost = canAgreeToUnknownCost(quote);
  const blockedQuote = paid && prepared && !priceAllowsGeneration(quote, agreedToUnknownCost);
  useEffect(() => {
    // Согласие относится к одной подготовке, даже если SHA повторился при обновлении цены.
    setAgreedToken(null);
    setConfirmation((current) => (current?.approvalToken === session?.approvalToken && !error ? current : null));
  }, [session?.approvalToken, error]);
  const isRetry = session?.status === 'ready' || session?.status === 'failed';
  const actionLabel = isRetry ? sourcesTexts.more : sourcesTexts.generateCover;
  const generationLabel =
    paid && prepared && quote?.verdict === 'ok'
      ? sourcesTexts.generationCostLabel({ action: actionLabel, credits: formatCredits(quote.credits) })
      : actionLabel;
  const generationDisabled = Boolean(blockedReason) || preparing || generating || !!blockedQuote || (!session && !prompt.trim());
  // Причины блокировки для подсказок; недоступность исполнителя AgentButton показывает сам, обычной кнопке её передаём явно.
  const waitReason = preparing ? sourcesTexts.waitRequestPreparation : generating ? sourcesTexts.waitCoverGeneration : null;
  const quoteReason = blockedQuote
    ? unknownCost
      ? sourcesTexts.agreeToShownCost
      : quote?.verdict === 'insufficient_balance'
        ? sourcesTexts.insufficientCredits
        : sourcesTexts.costUnconfirmed
    : null;
  const ownGenerationReason = waitReason ?? quoteReason ?? (!session && !prompt.trim() ? sourcesTexts.enterCoverPrompt : null);
  const acceptReason = preparing
    ? sourcesTexts.waitPreparation
    : !image
      ? sourcesTexts.generateCoverFirst
      : session?.status !== 'ready'
        ? sourcesTexts.waitReadyCover
        : !crop
          ? sourcesTexts.chooseCoverCrop
          : null;
  const onGenerate = async (): Promise<void> => {
    if (preparingClick.current || blockedReason || generationDisabled) return;
    preparingClick.current = true;
    try {
      const preparedSession = prepared ? session : await (session ? next() : start(prompt));
      if (!preparedSession?.approvalToken || !preparedSession.requestSha) return;
      if (MEDIA_PROVIDERS[preparedSession.provider].paid && !priceAllowsGeneration(preparedSession.quote, agreedToken === preparedSession.approvalToken))
        return;
      confirmingClick.current = false;
      setConfirmation(preparedSession);
    } finally {
      preparingClick.current = false;
    }
  };
  const confirmGeneration = (): void => {
    if (confirmingClick.current || !confirmation?.approvalToken || confirmation.approvalToken !== session?.approvalToken || blockedReason) return;
    confirmingClick.current = true;
    const allowUnknownCost =
      MEDIA_PROVIDERS[confirmation.provider].paid && canAgreeToUnknownCost(confirmation.quote) && agreedToken === confirmation.approvalToken;
    setConfirmation(null);
    setAgreedToken(null);
    void generate({ approvalToken: confirmation.approvalToken, promptConfirmed: true, ...(allowUnknownCost ? { allowUnknownCost: true } : {}) });
  };

  return (
    <>
      <Dialog
        open
        fullWidth
        maxWidth="md"
        onClose={accepting ? undefined : onClose}
        aria-labelledby="cover-generation-title"
        PaperProps={{ sx: { maxHeight: 'calc(100% - 32px)' } }}
      >
        <DialogTitle id="cover-generation-title">{sourcesTexts.createCover}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <AiProblemAlert kinds={['image']} />
            <Typography variant="body2" color="text.secondary">
              {session ? sourcesTexts.promptSessionFixed : idea.trim() ? sourcesTexts.ideaAddedToPrompt : sourcesTexts.ideaMissingForPrompt}
            </Typography>
            <TextField
              label={sourcesTexts.coverPrompt}
              value={session?.prompt ?? prompt}
              onChange={(event) => setPrompt(event.target.value)}
              multiline
              minRows={3}
              maxRows={7}
              fullWidth
              slotProps={{ input: { readOnly: !!session || preparing } }}
              helperText={session ? sourcesTexts.promptRetryFixed : sourcesTexts.promptEditable}
            />
            {session && (
              <Stack spacing={0.5}>
                <Typography variant="body2">
                  {sourcesTexts.executorModel({ provider: info?.title, model: session.model ?? (paid ? sourcesTexts.modelPending : info?.defaultModelLabel) })}
                </Typography>
                {prepared && session.requestSha && (
                  <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere', fontFamily: 'monospace' }}>
                    {sourcesTexts.requestSha({ sha: session.requestSha })}
                  </Typography>
                )}
              </Stack>
            )}
            {paid && prepared && (
              <Alert severity={coverNotice?.severity ?? 'warning'}>
                <Stack spacing={1} alignItems="flex-start">
                  <Typography variant="body2">
                    {coverNotice?.text ?? sourcesTexts.costUnavailable} {quote?.verdict === 'ok' ? sourcesTexts.confirmPromptBeforeSend : ''}
                    {/* Пояснение инструмента нужно, только когда цену не узнать обычным путём. */}
                    {quote?.message && coverNotice?.severity !== 'info' && quote.verdict !== 'ok' ? ` ${quote.message}` : ''}
                  </Typography>
                  {unknownCost && (
                    <ActionButton
                      variant={agreedToUnknownCost ? 'outlined' : 'contained'}
                      startIcon={<CheckIcon />}
                      disabled={Boolean(blockedReason) || preparing || agreedToUnknownCost}
                      disabledReason={blockedReason ?? (preparing ? sourcesTexts.waitRequestPreparation : sourcesTexts.costAlreadyAgreed)}
                      onClick={() => setAgreedToken(session?.approvalToken ?? null)}
                    >
                      {agreedToUnknownCost ? sourcesTexts.costAgreed : sourcesTexts.agree}
                    </ActionButton>
                  )}
                  {quote?.verdict !== 'ok' && (
                    <ActionButton
                      startIcon={<RefreshIcon />}
                      disabled={Boolean(blockedReason) || preparing}
                      disabledReason={blockedReason ?? sourcesTexts.waitRequestPreparation}
                      onClick={() => void refreshQuote()}
                    >
                      {sourcesTexts.refreshCost}
                    </ActionButton>
                  )}
                </Stack>
              </Alert>
            )}
            {(preparing || generating) && (
              <Stack direction="row" spacing={1} alignItems="center" role="status">
                <CircularProgress size={20} />
                <Typography variant="body2">
                  {accepting ? sourcesTexts.preparingCrop : generating ? sourcesTexts.generatingCover : sourcesTexts.preparingRequest}
                </Typography>
              </Stack>
            )}
            {(error || session?.error) && <Alert severity="error">{error ?? session?.error}</Alert>}
            {image && crop && <CoverCropEditor image={image} crop={crop} onCrop={setCrop} disabled={working} />}
            {session?.status === 'failed' && (
              <Typography variant="body2" color="text.secondary">
                {sourcesTexts.retryCoverHint}
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              {sourcesTexts.acceptedCoverHint}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1, flexWrap: 'wrap' }}>
          {/* Закрытие без «Принять» не меняет форму исходников, поэтому это всегда отмена. */}
          <ActionButton startIcon={<CancelOutlinedIcon />} onClick={onClose} disabled={accepting} disabledReason={sourcesTexts.waitCropPreparation}>
            {commonTexts.cancel}
          </ActionButton>
          <Box sx={{ flexGrow: 1 }} />
          {generationExecutor ? (
            <AgentButton
              aiKind="image"
              provider={generationExecutor}
              variant={image ? 'outlined' : 'contained'}
              disabled={generationDisabled}
              disabledReason={ownGenerationReason}
              onClick={() => void onGenerate()}
            >
              {generationLabel}
            </AgentButton>
          ) : (
            <ActionButton
              variant={image ? 'outlined' : 'contained'}
              startIcon={<AutoAwesomeIcon />}
              disabled={generationDisabled}
              disabledReason={blockedReason ?? ownGenerationReason}
              onClick={() => void onGenerate()}
            >
              {generationLabel}
            </ActionButton>
          )}
          <ActionButton
            variant="contained"
            startIcon={<CheckIcon />}
            disabled={!image || !crop || session?.status !== 'ready' || preparing}
            disabledReason={acceptReason}
            onClick={() => {
              if (crop)
                void accept(crop, (result) => {
                  onAccepted(result);
                  onClose();
                });
            }}
          >
            {sourcesTexts.accept}
          </ActionButton>
        </DialogActions>
      </Dialog>
      <ConfirmationDialog
        open={!!confirmation}
        title={sourcesTexts.confirmPromptTitle}
        description={sourcesTexts.confirmPromptQuestion}
        confirmLabel={sourcesTexts.generateCover}
        // Знак подтверждения — программа-исполнитель провайдера изображений, а не выбранный текстовый агент.
        {...(confirmationInfo?.executor
          ? { confirmAgent: { aiKind: 'image' as const, provider: confirmationInfo.executor } }
          : { confirmIcon: <AutoAwesomeIcon /> })}
        cancelLabel={commonTexts.cancel}
        onClose={() => setConfirmation(null)}
        onConfirm={confirmGeneration}
        confirmDisabled={Boolean(blockedReason) || preparing || !confirmation?.approvalToken || confirmation.approvalToken !== session?.approvalToken}
        confirmDisabledReason={blockedReason ?? (preparing ? sourcesTexts.waitRequestPreparation : sourcesTexts.requestChanged)}
      >
        {confirmation && (
          <Stack spacing={2} sx={{ mt: 2 }}>
            <TextField
              label={sourcesTexts.confirmedPrompt}
              value={confirmation.prompt}
              multiline
              fullWidth
              minRows={4}
              maxRows={10}
              slotProps={{ input: { readOnly: true } }}
            />
            <Typography variant="body2">
              {sourcesTexts.executorModel({ provider: confirmationInfo?.title, model: confirmation.model ?? confirmationInfo?.defaultModelLabel })}
            </Typography>
            <Typography variant="body2">
              {confirmationInfo?.paid
                ? sourcesTexts.confirmPaidRequest({ credits: formatCredits(confirmation.quote?.credits) })
                : sourcesTexts.confirmAccountGeneration({ provider: confirmationInfo?.title })}
            </Typography>
          </Stack>
        )}
      </ConfirmationDialog>
    </>
  );
}
