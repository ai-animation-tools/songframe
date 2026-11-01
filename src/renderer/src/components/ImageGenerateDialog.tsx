import { commonTexts } from '@shared/texts/common';
import { sourcesTexts } from '@shared/texts/sources';
/** Общий диалог сохраняет согласования обложки и принимает референс целиком, без квадратного кадрирования. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import CheckIcon from '@mui/icons-material/Check';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { ReferenceImageContextDrafts, ReferenceImageOption } from '@shared/reference-image-generation';
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
import { useReferenceImageSupports } from '../hooks/useReferenceImageSupports';
import { useReferenceImageComposer } from '../hooks/useReferenceImageComposer';
import { ReferenceImageComposer } from './ReferenceImageComposer';
import { ImageThumbnail } from './ImageThumbnail';
import { ImageGallery } from './ImageGallery';
import { CoverCropEditor } from './CoverCropEditor';
import { centeredCrop } from './imageCrop';

interface Props {
  project: string;
  idea?: string;
  mode?: 'cover' | 'reference';
  target?: string;
  initialPrompt?: string;
  referenceInput?: { images: ReferenceImageOption[] };
  referenceContextDrafts?: ReferenceImageContextDrafts;
  referenceDescription?: string;
  acceptedHint?: string;
  onAccepted: (result: ImageGenerationResult) => void | Promise<void>;
  onClose: () => void;
}

export function ImageGenerateDialog({
  project,
  idea = '',
  mode = 'cover',
  target,
  initialPrompt,
  referenceInput,
  referenceContextDrafts,
  referenceDescription = '',
  acceptedHint,
  onAccepted,
  onClose
}: Props): ReactElement {
  const reference = mode === 'reference';
  const { aiAccess } = useApp();
  // Обложку готовит провайдер изображений проекта; выбранный агент на неё не влияет.
  const blockedReason = aiActionProblem(aiAccess, 'image');
  const [coverPrompt, setCoverPrompt] = useState(
    () =>
      initialPrompt ??
      (idea.trim()
        ? // eslint-disable-next-line no-restricted-syntax -- Исходная инструкция генерации принадлежит диалогу, а не словарю подписей интерфейса.
          `Создай выразительную квадратную обложку музыкального клипа.\n\nИдея клипа:\n${idea.trim()}`
        : '')
  );
  // Исходный список сохраняется целиком: дедупликация сессии не должна убирать доступные флажки.
  const [referenceOptions] = useState(() => referenceInput?.images ?? []);
  const [selectedImages, setSelectedImages] = useState(() => referenceOptions.map((_image, index) => index));
  const selectedOptions = referenceOptions.filter((_image, index) => selectedImages.includes(index));
  const supports = useReferenceImageSupports(reference, selectedOptions);
  const composer = useReferenceImageComposer({
    enabled: reference,
    project,
    basePrompt: initialPrompt ?? '',
    description: referenceDescription,
    supportNotes: supports.notes,
    drafts: referenceContextDrafts
  });
  const prompt = reference ? composer.prompt : coverPrompt;
  const selectedInput = supports.input;
  const [crop, setCrop] = useState<CoverCrop | null>(null);
  const { session, working, accepting, attachmentPending, error, preparedSha, start, next, refreshQuote, generate, accept, invalidate } = useImageGeneration(
    project,
    mode,
    reference ? selectedInput : undefined
  );
  const [gallery, setGallery] = useState<{ key: string; index: number; images: { imagePath: string; label: string }[] } | null>(null);
  // При ответе create галерея старого набора закрывается до обновления внутреннего индекса.
  const galleryKey = JSON.stringify({ session: session?.id ?? null, images: referenceOptions });
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
  const editingBlocked = working || generating || accepting || attachmentPending;
  const changeReference = (action: () => void): void => {
    if (editingBlocked || !invalidate()) return;
    setConfirmation(null);
    setAgreedToken(null);
    setGallery(null);
    action();
  };
  const supportImages = (images: { path: string; label: string }[], selectable: boolean): ReactElement | null =>
    reference ? (
      <Stack component="section" aria-label={sourcesTexts.referenceSupports} spacing={1}>
        {!selectable && <Typography variant="subtitle2">{sourcesTexts.referenceSupports}</Typography>}
        <Typography variant="body2" color="text.secondary">
          {selectable
            ? images.length
              ? sourcesTexts.referenceSelectImages
              : sourcesTexts.referenceSupportsEmpty
            : images.length
              ? sourcesTexts.referenceSupportsFixed
              : sourcesTexts.referenceNoSelectedImages}
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: 1, minWidth: 0 }}>
          {images.map((image, index) => (
            <Stack key={`${image.path}:${index}`} spacing={0.5} sx={{ minWidth: 0 }}>
              <ImageThumbnail
                path={image.path}
                label={image.label}
                onOpen={() => setGallery({ key: galleryKey, index, images: images.map((item) => ({ imagePath: item.path, label: item.label })) })}
              />
              {selectable ? (
                <FormControlLabel
                  sx={{ m: 0, alignItems: 'flex-start', '& .MuiFormControlLabel-label': { overflowWrap: 'anywhere', minWidth: 0 } }}
                  label={sourcesTexts.referenceUseImage({ label: image.label })}
                  control={
                    <Checkbox
                      checked={selectedImages.includes(index)}
                      disabled={editingBlocked}
                      onChange={(_event, checked) =>
                        changeReference(() => setSelectedImages((current) => (checked ? [...current, index] : current.filter((value) => value !== index))))
                      }
                    />
                  }
                />
              ) : (
                <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                  {image.label}
                </Typography>
              )}
            </Stack>
          ))}
        </Box>
        {selectable && images.length > 0 && selectedOptions.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {sourcesTexts.referenceNoSelectedImages}
          </Typography>
        )}
      </Stack>
    ) : null;
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
  const generationDisabled =
    attachmentPending ||
    Boolean(blockedReason) ||
    preparing ||
    generating ||
    !!blockedQuote ||
    (!session && !prompt.trim()) ||
    (reference && (!composer.ready || !supports.ready));
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
    (reference && !supports.ready ? (supports.error ?? sourcesTexts.referenceSupportsLoading) : null) ??
    (reference && !composer.ready ? (composer.loading ? sourcesTexts.referenceContextLoading : sourcesTexts.referenceContextUnavailable) : null) ??
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
        maxWidth={reference ? 'lg' : 'md'}
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
                ? reference
                  ? sourcesTexts.referenceContextFixed
                  : sourcesTexts.promptSessionFixed
                : reference
                  ? sourcesTexts.referencePromptHint
                  : idea.trim()
                    ? sourcesTexts.ideaAddedToPrompt
                    : sourcesTexts.ideaMissingForPrompt}
            </Typography>
            {reference && supports.loading && (
              <Typography role="status" variant="body2">
                {sourcesTexts.referenceSupportsLoading}
              </Typography>
            )}
            {reference && supports.error && (
              <Alert severity="error">
                <Stack spacing={1} alignItems="flex-start">
                  <Typography variant="body2">{supports.error}</Typography>
                  {!supports.restartRequired && (
                    <ActionButton
                      startIcon={<RefreshIcon />}
                      onClick={supports.retry}
                      disabled={editingBlocked}
                      disabledReason={sourcesTexts.referenceConstructorBusy}
                    >
                      {sourcesTexts.referenceSupportsRetry}
                    </ActionButton>
                  )}
                </Stack>
              </Alert>
            )}
            {reference && (
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) minmax(0, 2fr)' },
                  gap: 2,
                  alignItems: 'start',
                  '& > *': { minWidth: 0 }
                }}
              >
                <Accordion
                  disableGutters
                  variant="outlined"
                  defaultExpanded={false}
                  slotProps={{ transition: { unmountOnExit: true } }}
                  sx={{ '&:before': { display: 'none' } }}
                >
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Box sx={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                      <Typography variant="subtitle2">{sourcesTexts.referenceSupports}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {sourcesTexts.referenceSelectedSupportCount({ selected: selectedOptions.length, total: referenceOptions.length })}
                      </Typography>
                    </Box>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Stack spacing={1}>
                      {supportImages(referenceOptions, true)}
                      <Box>
                        <ActionButton
                          startIcon={<RefreshIcon />}
                          onClick={() => changeReference(supports.retry)}
                          disabled={editingBlocked || supports.loading || supports.restartRequired || selectedOptions.length === 0}
                          disabledReason={
                            supports.restartRequired
                              ? sourcesTexts.referenceSupportsRestartRequired
                              : editingBlocked
                                ? sourcesTexts.referenceConstructorBusy
                                : selectedOptions.length === 0
                                  ? sourcesTexts.referenceNoSelectedImages
                                  : sourcesTexts.referenceSupportsLoading
                          }
                        >
                          {sourcesTexts.referenceSupportsRetry}
                        </ActionButton>
                      </Box>
                    </Stack>
                  </AccordionDetails>
                </Accordion>
                <ReferenceImageComposer
                  composer={composer}
                  description={referenceDescription}
                  disabled={editingBlocked || supports.loading}
                  onChange={changeReference}
                />
              </Box>
            )}
            <TextField
              label={reference ? sourcesTexts.referenceImagePrompt : sourcesTexts.coverPrompt}
              value={reference ? prompt : (session?.prompt ?? prompt)}
              onChange={(event) => (reference ? changeReference(() => composer.edit(event.target.value)) : setCoverPrompt(event.target.value))}
              multiline
              minRows={reference ? 10 : 3}
              maxRows={reference ? 24 : 7}
              fullWidth
              slotProps={{ input: { readOnly: reference ? editingBlocked : !!session || preparing } }}
              helperText={
                reference
                  ? sourcesTexts.referenceCharacterCount({ count: Array.from(prompt).length })
                  : session
                    ? sourcesTexts.promptRetryFixed
                    : sourcesTexts.promptEditable
              }
            />
            {reference && (
              <Typography variant="caption" color="text.secondary">
                {sourcesTexts.referenceRequestInvalidated}
              </Typography>
            )}
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
                <CircularProgress size={20} aria-hidden />
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
            {supportImages(confirmation.referenceImages ?? [], false)}
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
      {gallery !== null && gallery.key === galleryKey && gallery.index < gallery.images.length && (
        <ImageGallery images={gallery.images} initialIndex={gallery.index} kind={sourcesTexts.referenceSupports} onClose={() => setGallery(null)} />
      )}
    </>
  );
}
