/**
 * Свой видеопромпт без агента: текст с длиной и пределом провайдера. «Сохранить и принять» отдаёт текст Go: он проверяет его
 * правилами ответа агента и пределом, записывает в попытку, а интерфейс сразу утверждает:
 * автор своего текста — сам пользователь. Сверх предела сохранить нельзя:
 * такой промпт не утверждается. Черновик закрывается только кнопкой отмены.
 */
import { useState, type ReactElement } from 'react';
import { Alert, Stack, TextField, Typography } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import { productionTexts } from '@shared/texts/production';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { LinkedText } from '../../../components/LinkedText';
import { promptOverLimit } from '../promptLimit';

const texts = productionTexts.ownPromptDialog;

/** Первая причина, по которой свой промпт нельзя сохранить; null — можно отдавать Go. */
export function ownPromptProblem(text: string, limit: number | null | undefined): string | null {
  if (!text.trim()) return texts.required;
  const over = promptOverLimit(text.trim(), limit);
  return over ? productionTexts.promptLimit.approveReason(over) : null;
}

export function OwnPromptDialog({
  shot,
  initial,
  limit,
  busy,
  error,
  onClose,
  onSave
}: {
  shot: string;
  initial: string;
  /** Предел длины провайдера видео (ProductionWorkflowView.promptMaxChars); нет — длина не ограничена. */
  limit: number | null | undefined;
  busy: boolean;
  /** Отказ Go последней попытки сохранения: окно остаётся открытым для исправления. */
  error: string | null;
  onClose(): void;
  onSave(prompt: string): void;
}): ReactElement {
  const [text, setText] = useState(initial);
  const problem = ownPromptProblem(text, limit);
  const over = promptOverLimit(text.trim(), limit);
  return (
    <ConfirmationDialog
      open
      maxWidth="md"
      explicitCancelOnly
      title={texts.title({ shot })}
      contentLabel={texts.title({ shot })}
      confirmLabel={productionTexts.ownDescriptionDialog.save}
      confirmIcon={<CheckIcon />}
      confirmDisabled={busy || !!problem}
      confirmDisabledReason={busy ? productionTexts.productionWorkflowPanel.loadingReason : problem}
      cancelDisabled={busy}
      onClose={onClose}
      onConfirm={() => onSave(text.trim())}
    >
      <Stack spacing={2} sx={{ pt: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {texts.saveHint}
        </Typography>
        {error ? (
          <Alert severity="error">
            <LinkedText text={error} />
          </Alert>
        ) : null}
        <TextField
          label={texts.prompt}
          multiline
          minRows={6}
          maxRows={18}
          autoFocus
          error={!!over}
          helperText={texts.chars({ chars: Array.from(text.trim()).length, limit })}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Stack>
    </ConfirmationDialog>
  );
}
