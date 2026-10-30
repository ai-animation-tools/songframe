import { commonTexts } from '@shared/texts/common';
import { sourcesTexts } from '@shared/texts/sources';
/** Общий диалог сохраняет согласования обложки и принимает референс целиком, без квадратного кадрирования. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Box, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import CheckIcon from '@mui/icons-material/Check';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { CoverCrop, CoverGenerationSession } from '@shared/cover-generation';
import { MEDIA_PROVIDERS, mediaProviderInfo } from '@shared/media-providers';
import { canAgreeToUnknownCost, formatCredits, priceAllowsGeneration, priceNotice } from '@shared/generation-consent';
import { ConfirmationDialog } from './ConfirmationDialog';
import { useApp } from '../state';
import { aiActionProblem } from '@shared/ai-access';
import { ActionButton } from './ActionButton';
import { AgentButton } from './AgentButton';
import { AiProblemAlert } from './AiProblemAlert';
import { useImageGeneration, type ImageGenerationResult } from '../hooks/useImageGeneration';
import { CoverCropEditor } from './CoverCropEditor';
import { centeredCrop } from './imageCrop';

interface Props {
  project: string;
  idea?: string;
  mode?: 'cover' | 'reference';
  target?: string;
  initialPrompt?: string;
  acceptedHint?: string;
  onAccepted: (result: ImageGenerationResult) => void | Promise<void>;
  onClose: () => void;
}

export function ImageGenerateDialog({ project, idea = '', mode = 'cover', target, initialPrompt, acceptedHint, onAccepted, onClose }: Props): ReactElement {
  const reference = mode === 'reference';
  const { aiAccess } = useApp();
  // Обложку готовит провайдер изображений проекта; выбранный агент на неё не влияет.
  const blockedReason = aiActionProblem(aiAccess, 'image');
  const [prompt, setPrompt] = useState(
    () =>
      initialPrompt ??
      (idea.trim()
        ? // eslint-disable-next-line no-restricted-syntax -- Исходная инструкция генерации принадлежит диалогу, а не словарю подписей интерфейса.
          `Создай выразительную квадратную обложку музыкального клипа.\n\nИдея клипа:\n${idea.trim()}`
        : '')
  );
  const [crop, setCrop] = useState<CoverCrop | null>(null);
  const { session, working, accepting, attachmentPending, error, preparedSha, start, next, refreshQuote, generate, accept } = useImageGeneration(project, mode);
  const [agreedToken, setAgreedToken] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<CoverGenerationSession | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const preparingClick = useRef(false);
  const confirmingClick = useRef(false);
  const image = session?.image ?? null;
  const imagePath = image?.path;
  const width = image?.width;
  const height = image?.height;
  useEffect(() => {
    setCrop(!reference && width && height ? centeredCrop({ width, height }) : null);
  }, [reference, imagePath, width, height]);

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
  const createLabel = reference ? sourcesTexts.generateReferenceImage : sourcesTexts.generateCover;
  const actionLabel = isRetry ? sourcesTexts.more : createLabel;
  const generationLabel =
    paid && prepared && quote?.verdict === 'ok'
      ? sourcesTexts.generationCostLabel({ action: actionLabel, credits: formatCredits(quote.credits) })
      : actionLabel;
  const generationDisabled = attachmentPending || Boolean(blockedReason) || preparing || generating || !!blockedQuote || (!session && !prompt.trim());
  // Причины блокировки для подсказок; недоступность исполнителя AgentButton показывает сам, обычной кнопке её передаём явно.
  const waitReason = preparing
    ? sourcesTexts.waitRequestPreparation
    : generating
      ? reference
        ? sourcesTexts.waitReferenceGeneration
        : sourcesTexts.waitCoverGeneration
      : null;
  const quoteReason = blockedQuote
    ? unknownCost
      ? sourcesTexts.agreeToShownCost
      : quote?.verdict === 'insufficient_balance'
        ? sourcesTexts.insufficientCredits
        : sourcesTexts.costUnconfirmed
    : null;
  const ownGenerationReason =
    (attachmentPending ? sourcesTexts.referenceAttachPending : null) ??
    waitReason ??
    quoteReason ??
    (!session && !prompt.trim() ? (reference ? sourcesTexts.enterReferencePrompt : sourcesTexts.enterCoverPrompt) : null);
  const acceptReason = preparing
    ? sourcesTexts.waitPreparation
    : !image
      ? reference
        ? sourcesTexts.generateReferenceFirst
        : sourcesTexts.generateCoverFirst
      : session?.status !== 'ready'
        ? reference
          ? sourcesTexts.waitReadyReference
          : sourcesTexts.waitReadyCover
        : !reference && !crop
          ? sourcesTexts.chooseCoverCrop
          : null;
  const onGenerate = async (): Promise<void> => {
    if (preparingClick.current || blockedReason || generationDisabled) return;
    preparingClick.current = true;
    try {
      const preparedSession = prepared ? session : await (session ? next() : start(prompt));
      if (!alive.current || !preparedSession?.approvalToken || !preparedSession.requestSha) return;
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
        <DialogTitle id="cover-generation-title">{reference ? sourcesTexts.createReferenceImage : sourcesTexts.createCover}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <AiProblemAlert kinds={['image']} />
            {reference && (
              <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>
                {sourcesTexts.referenceGenerationTarget({ name: target ?? '' })}
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              {session
                ? sourcesTexts.promptSessionFixed
                : reference
                  ? sourcesTexts.referencePromptHint
                  : idea.trim()
                    ? sourcesTexts.ideaAddedToPrompt
                    : sourcesTexts.ideaMissingForPrompt}
            </Typography>
            <TextField
              label={reference ? sourcesTexts.referenceImagePrompt : sourcesTexts.coverPrompt}
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
                  {accepting
                    ? reference
                      ? sourcesTexts.acceptingReferenceImage
                      : sourcesTexts.preparingCrop
                    : generating
                      ? reference
                        ? sourcesTexts.generatingReference
                        : sourcesTexts.generatingCover
                      : sourcesTexts.preparingRequest}
                </Typography>
              </Stack>
            )}
            {(error || session?.error) && <Alert severity="error">{error ?? session?.error}</Alert>}
            {image && !reference && crop && <CoverCropEditor image={image} crop={crop} onCrop={setCrop} disabled={working} />}
            {image && reference && (
              <Box
                component="img"
                src={window.api.shell.fileUrl(image.path)}
                alt={target ?? sourcesTexts.referenceImageCandidate}
                sx={{ display: 'block', width: '100%', maxHeight: '50vh', objectFit: 'contain', bgcolor: 'action.hover', borderRadius: 1 }}
              />
            )}
            {session?.status === 'failed' && (
              <Typography variant="body2" color="text.secondary">
                {sourcesTexts.retryCoverHint}
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              {acceptedHint ?? sourcesTexts.acceptedCoverHint}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1, flexWrap: 'wrap' }}>
          {/* Закрытие без «Принять» не меняет форму исходников, поэтому это всегда отмена. */}
          <ActionButton
            startIcon={<CancelOutlinedIcon />}
            onClick={onClose}
            disabled={accepting}
            disabledReason={reference ? sourcesTexts.acceptingReferenceImage : sourcesTexts.waitCropPreparation}
          >
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
            disabled={!image || (!reference && !crop) || session?.status !== 'ready' || preparing}
            disabledReason={acceptReason}
            onClick={() => {
              if (reference || crop)
                void accept(crop, async (result) => {
                  await onAccepted(result);
                  if (alive.current) onClose();
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
        confirmLabel={createLabel}
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
