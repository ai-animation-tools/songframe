/**
 * Своё видео плана: готовый MP4, снятый или сделанный вне приложения, становится результатом новой попытки без описания,
 * опор и видеопромпта: они нужны только генерации, а видео уже готово. Форма та же, что у ручной генерации: файл,
 * обязательный источник, стоимость и примечание. Новая попытка может по желанию указать, как видео сделано: входы генерации
 * с ролями и промпт (раздел «Как сделано видео»); замена загруженного видео их не меняет и раздела не показывает.
 * Формат и запись проверяет Go до создания попытки; отказ остаётся в окне, черновик закрывается только кнопкой отмены.
 * После загрузки страница сама открывает приёмку; если в другой попытке плана ждёт непринятый результат, окно
 * предупреждает: приёмка этого видео удалит его вместе с остальными рабочими попытками.
 */
import { useState, type ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { productionTexts } from '@shared/texts/production';
import type { ManualVideo, OwnVideoGeneration } from '@shared/types';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { LinkedText } from '../../../components/LinkedText';
import { ManualVideoForm } from './ManualVideoForm';
import { OwnVideoGenerationForm } from './OwnVideoGenerationForm';

const texts = productionTexts.ownVideo;

/** Видео без сведений о генерации: так Go записывает попытку, как видео с телефона. */
const NO_GENERATION: OwnVideoGeneration = { inputs: [], prompt: '' };

export function OwnVideoDialog({
  shot,
  replace = false,
  unaccepted = null,
  busy,
  error,
  onClose,
  onUpload
}: {
  shot: string;
  /** Замена уже загруженного вручную видео попытки, а не новая попытка своего видео. */
  replace?: boolean;
  /** Непринятые результаты других попыток плана одной строкой («Попытка 1 (оплаченная генерация)»); null — нет. */
  unaccepted?: string | null;
  /** Загрузка запускается: окно ждёт ответа Go. */
  busy: boolean;
  /** Отказ Go при последней попытке загрузить. */
  error: string | null;
  onClose(): void;
  /** generation — входы и промпт из раздела «Как сделано видео»; при замене и пустом разделе — пустые. */
  onUpload(video: ManualVideo, generation: OwnVideoGeneration): void;
}): ReactElement {
  const [state, setState] = useState<{ video: ManualVideo | null; problem: string | null }>({ video: null, problem: null });
  const [generation, setGeneration] = useState<{ value: OwnVideoGeneration; problem: string | null }>({ value: NO_GENERATION, problem: null });
  // Сначала причина формы видео (файл, источник), затем ошибка входов генерации.
  const reason = busy ? productionTexts.productionWorkflowPanel.loadingReason : (state.problem ?? (replace ? null : generation.problem));
  return (
    <ConfirmationDialog
      open
      maxWidth="sm"
      explicitCancelOnly
      title={replace ? texts.replaceTitle({ shot }) : texts.title({ shot })}
      contentLabel={replace ? texts.replaceTitle({ shot }) : texts.title({ shot })}
      confirmLabel={productionTexts.manualGeneration.upload}
      confirmIcon={<UploadFileIcon />}
      confirmDisabled={busy || !state.video || (!replace && !!generation.problem)}
      confirmDisabledReason={reason}
      cancelDisabled={busy}
      onClose={onClose}
      onConfirm={() => {
        if (state.video) onUpload(state.video, replace ? NO_GENERATION : generation.value);
      }}
    >
      <Stack spacing={2} sx={{ pt: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {replace ? texts.replaceIntro : texts.intro}
        </Typography>
        {unaccepted ? <Alert severity="warning">{texts.unaccepted({ attempts: unaccepted })}</Alert> : null}
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
        {replace ? null : (
          <OwnVideoGenerationForm
            busy={busy}
            busyReason={productionTexts.productionWorkflowPanel.loadingReason}
            onChange={(value, problem) => setGeneration({ value, problem })}
          />
        )}
      </Stack>
    </ConfirmationDialog>
  );
}
