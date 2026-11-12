/**
 * Своё видео плана: готовый MP4, снятый или сделанный вне приложения, становится результатом новой попытки без описания,
 * опор и видеопромпта (D-048). Форма та же, что у ручной генерации: файл, обязательный источник, стоимость и примечание.
 * Формат и запись проверяет Go до создания попытки; отказ остаётся в окне, черновик закрывается только кнопкой отмены.
 */
import { useState, type ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { productionTexts } from '@shared/texts/production';
import type { ManualVideo } from '@shared/types';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { LinkedText } from '../../../components/LinkedText';
import { ManualVideoForm } from './ManualVideoForm';

const texts = productionTexts.ownVideo;

export function OwnVideoDialog({
  shot,
  busy,
  error,
  onClose,
  onUpload
}: {
  shot: string;
  /** Загрузка запускается: окно ждёт ответа Go. */
  busy: boolean;
  /** Отказ Go при последней попытке загрузить. */
  error: string | null;
  onClose(): void;
  onUpload(video: ManualVideo): void;
}): ReactElement {
  const [state, setState] = useState<{ video: ManualVideo | null; problem: string | null }>({ video: null, problem: null });
  const reason = busy ? productionTexts.productionWorkflowPanel.loadingReason : state.problem;
  return (
    <ConfirmationDialog
      open
      maxWidth="sm"
      explicitCancelOnly
      title={texts.title({ shot })}
      contentLabel={texts.title({ shot })}
      confirmLabel={productionTexts.manualGeneration.upload}
      confirmIcon={<UploadFileIcon />}
      confirmDisabled={busy || !state.video}
      confirmDisabledReason={reason}
      cancelDisabled={busy}
      onClose={onClose}
      onConfirm={() => {
        if (state.video) onUpload(state.video);
      }}
    >
      <Stack spacing={2} sx={{ pt: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {texts.intro}
        </Typography>
        <Alert severity="info">{texts.format}</Alert>
        {error ? (
          <Alert severity="error">
            <LinkedText text={error} />
          </Alert>
        ) : null}
        <ManualVideoForm
          busy={busy}
          busyReason={productionTexts.productionWorkflowPanel.loadingReason}
          sourceHint={texts.sourceHint}
          onChange={(video, problem) => setState({ video, problem })}
        />
      </Stack>
    </ConfirmationDialog>
  );
}
