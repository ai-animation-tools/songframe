/** Генерация и выбор обложки остаются временными до сохранения формы исходников. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import CheckIcon from '@mui/icons-material/Check';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { CoverCrop, CoverGenerationSession } from '@shared/cover-generation';
import { COVER_AGENT_REQUIRED } from '@shared/cover-generation';
import { canAgreeToUnknownCost, formatCredits, priceAllowsGeneration } from '@shared/generation-consent';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { AgentIcon } from '../../../components/AgentIcon';
import { useApp } from '../../../state';
import { aiActionProblem } from '@shared/ai-access';
import { AgentButton } from '../../../components/AgentButton';
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
  const { agentProvider, aiAccess } = useApp();
  const blockedReason = !agentProvider ? COVER_AGENT_REQUIRED : aiActionProblem(aiAccess, 'image');
  const [prompt, setPrompt] = useState(() => (idea.trim() ? `Создай выразительную квадратную обложку музыкального клипа.\n\nИдея клипа:\n${idea.trim()}` : ''));
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
  const kling = session?.provider === 'kling';
  const prepared = !!preparedSha && preparedSha === session?.requestSha && !!session?.approvalToken;
  const quote = prepared ? session?.quote : null;
  const agreedToUnknownCost = !!session?.approvalToken && agreedToken === session.approvalToken;
  const unknownCost = canAgreeToUnknownCost(quote);
  const blockedQuote = kling && prepared && !priceAllowsGeneration(quote, agreedToUnknownCost);
  useEffect(() => {
    // Согласие относится к одной подготовке, даже если SHA повторился при обновлении цены.
    setAgreedToken(null);
    setConfirmation((current) => (current?.approvalToken === session?.approvalToken && !error ? current : null));
  }, [session?.approvalToken, error]);
  const isRetry = session?.status === 'ready' || session?.status === 'failed';
  const actionLabel = session ? (isRetry ? 'Ещё' : 'Сгенерировать') : 'Сгенерировать';
  const generationLabel = kling && prepared && quote?.verdict === 'ok' ? `${actionLabel} · ${quote.credits} кредитов` : actionLabel;
  const generationDisabled = Boolean(blockedReason) || preparing || generating || !!blockedQuote || (!session && !prompt.trim());
  const onGenerate = async (): Promise<void> => {
    if (preparingClick.current || blockedReason || generationDisabled) return;
    preparingClick.current = true;
    try {
      const preparedSession = prepared ? session : await (session ? next() : start(prompt));
      if (!preparedSession?.approvalToken || !preparedSession.requestSha) return;
      if (preparedSession.provider === 'kling' && !priceAllowsGeneration(preparedSession.quote, agreedToken === preparedSession.approvalToken)) return;
      confirmingClick.current = false;
      setConfirmation(preparedSession);
    } finally {
      preparingClick.current = false;
    }
  };
  const confirmGeneration = (): void => {
    if (confirmingClick.current || !confirmation?.approvalToken || confirmation.approvalToken !== session?.approvalToken || blockedReason) return;
    confirmingClick.current = true;
    const allowUnknownCost = confirmation.provider === 'kling' && canAgreeToUnknownCost(confirmation.quote) && agreedToken === confirmation.approvalToken;
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
        <DialogTitle id="cover-generation-title">Создать обложку</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {blockedReason ? <Alert severity="info">{blockedReason}</Alert> : null}
            <Typography variant="body2" color="text.secondary">
              {session
                ? 'Промпт зафиксирован для этой сессии. Каждая новая попытка использует тот же текст.'
                : idea.trim()
                  ? 'Идея клипа уже добавлена в промпт. Уточните содержание и стиль обложки перед генерацией.'
                  : 'Идея клипа пока не заполнена. Опишите вручную содержание и стиль обложки.'}
            </Typography>
            <TextField
              label="Промпт обложки"
              value={session?.prompt ?? prompt}
              onChange={(event) => setPrompt(event.target.value)}
              multiline
              minRows={3}
              maxRows={7}
              fullWidth
              slotProps={{ input: { readOnly: !!session || preparing } }}
              helperText={session ? 'Промпт зафиксирован. «Ещё» создаёт новую попытку по этому же тексту.' : 'Промпт можно изменить до первого запуска.'}
            />
            {session && (
              <Stack spacing={0.5}>
                <Typography variant="body2">
                  Исполнитель: {kling ? 'Kling' : 'Codex'} · Модель: {session.model ?? (kling ? 'уточняется при подготовке' : 'из настроек Codex CLI')}
                </Typography>
                {prepared && session.requestSha && (
                  <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere', fontFamily: 'monospace' }}>
                    SHA запроса: {session.requestSha}
                  </Typography>
                )}
              </Stack>
            )}
            {kling && prepared && (
              <Alert severity={quote?.verdict === 'ok' ? 'info' : 'warning'}>
                <Stack spacing={1} alignItems="flex-start">
                  <Typography variant="body2">
                    Стоимость: {formatCredits(quote?.credits)}. Остаток: {formatCredits(quote?.balance)}.{' '}
                    {quote?.verdict === 'ok'
                      ? 'Перед отправкой проверьте и подтвердите промпт.'
                      : unknownCost
                        ? 'Цена неизвестна. Чтобы разрешить один запрос, нажмите «Я согласен», затем подтвердите промпт.'
                        : (quote?.message ??
                          (quote?.verdict === 'insufficient_balance'
                            ? 'Недостаточно кредитов для отправки.'
                            : 'Цена или остаток не подтверждены. Отправка недоступна.'))}
                  </Typography>
                  {unknownCost && (
                    <Button
                      variant={agreedToUnknownCost ? 'outlined' : 'contained'}
                      startIcon={<CheckIcon />}
                      disabled={Boolean(blockedReason) || preparing || agreedToUnknownCost}
                      onClick={() => setAgreedToken(session?.approvalToken ?? null)}
                    >
                      {agreedToUnknownCost ? 'Согласие получено' : 'Я согласен'}
                    </Button>
                  )}
                  {quote?.verdict !== 'ok' && (
                    <Button startIcon={<RefreshIcon />} disabled={Boolean(blockedReason) || preparing} onClick={() => void refreshQuote()}>
                      Обновить стоимость
                    </Button>
                  )}
                </Stack>
              </Alert>
            )}
            {(preparing || generating) && (
              <Stack direction="row" spacing={1} alignItems="center" role="status">
                <CircularProgress size={20} />
                <Typography variant="body2">
                  {accepting
                    ? 'Подготовка выбранной области…'
                    : generating
                      ? 'Создаётся обложка… Закрытие отменит ожидание и удалит временные файлы.'
                      : 'Подготовка запроса и сведений о модели…'}
                </Typography>
              </Stack>
            )}
            {(error || session?.error) && <Alert severity="error">{error ?? session?.error}</Alert>}
            {image && crop && <CoverCropEditor image={image} crop={crop} onCrop={setCrop} disabled={working} />}
            {session?.status === 'failed' && (
              <Typography variant="body2" color="text.secondary">
                Нажмите «Ещё», чтобы подготовить новую попытку с тем же промптом.
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              Принятая область подставится в форму. Чтобы сохранить обложку в проекте, нажмите «Сохранить» на странице исходников.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1, flexWrap: 'wrap' }}>
          <Button startIcon={<CancelOutlinedIcon />} onClick={onClose} disabled={accepting}>
            Закрыть
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          {kling ? (
            <Button variant={image ? 'outlined' : 'contained'} startIcon={<AutoAwesomeIcon />} disabled={generationDisabled} onClick={() => void onGenerate()}>
              {generationLabel}
            </Button>
          ) : (
            <AgentButton
              aiKind="image"
              variant={image ? 'outlined' : 'contained'}
              provider={session ? 'codex' : null}
              disabled={generationDisabled}
              onClick={() => void onGenerate()}
            >
              {generationLabel}
            </AgentButton>
          )}
          <Button
            variant="contained"
            startIcon={<CheckIcon />}
            disabled={!image || !crop || session?.status !== 'ready' || preparing}
            onClick={() => {
              if (crop)
                void accept(crop, (result) => {
                  onAccepted(result);
                  onClose();
                });
            }}
          >
            Принять
          </Button>
        </DialogActions>
      </Dialog>
      <ConfirmationDialog
        open={!!confirmation}
        title="Проверьте промпт перед генерацией"
        description="Вы уверены, что промпт правильный?"
        confirmLabel="Генерировать"
        confirmIcon={confirmation?.provider === 'codex' ? <AgentIcon provider="codex" /> : <AutoAwesomeIcon />}
        cancelLabel="Отмена"
        onClose={() => setConfirmation(null)}
        onConfirm={confirmGeneration}
        confirmDisabled={Boolean(blockedReason) || preparing || !confirmation?.approvalToken || confirmation.approvalToken !== session?.approvalToken}
      >
        {confirmation && (
          <Stack spacing={2} sx={{ mt: 2 }}>
            <TextField
              label="Подтверждаемый промпт"
              value={confirmation.prompt}
              multiline
              fullWidth
              minRows={4}
              maxRows={10}
              slotProps={{ input: { readOnly: true } }}
            />
            <Typography variant="body2">
              Исполнитель: {confirmation.provider === 'kling' ? 'Kling' : 'Codex'} · Модель: {confirmation.model ?? 'из настроек Codex CLI'}
            </Typography>
            <Typography variant="body2">
              {confirmation.provider === 'kling'
                ? `Стоимость: ${formatCredits(confirmation.quote?.credits)}. Будет отправлен один запрос.`
                : 'Генерация через Codex по условиям вашего аккаунта.'}
            </Typography>
          </Stack>
        )}
      </ConfirmationDialog>
    </>
  );
}
