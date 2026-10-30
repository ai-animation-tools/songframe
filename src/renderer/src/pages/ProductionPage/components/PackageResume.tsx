import { productionTexts } from '@shared/texts/production';
/** Получение по уже существующему ID не создаёт повторной платной отправки; без ID исход выясняет пользователь по истории генераций сервиса. */
import { useState, type ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import BlockIcon from '@mui/icons-material/Block';
import { AiButton } from '../../../components/AiButton';
import { ActionButton } from '../../../components/ActionButton';
import { BUSY_REASON } from '../constants';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { mediaProviderInfo, normalizeMediaProvider } from '@shared/media-providers';
import type { PackageView } from '@shared/types';

const RESUMABLE = [
  'submission_unknown',
  'submitting',
  'submitted',
  'running',
  'watermark_free_pending',
  'outputs_pending',
  'download_pending',
  'downloading',
  'polling',
  'download_failed',
  'download_partial',
  'failed'
];

export function PackageResume({
  pkg,
  busy,
  busyReason = BUSY_REASON,
  providerAvailable,
  onResume,
  onAttach,
  onNotCreated
}: {
  pkg: PackageView;
  busy: boolean;
  /** Почему busy блокирует действия: идёт операция или нет Python. */
  busyReason?: string;
  providerAvailable: boolean;
  onResume(): void;
  /** Файлы результата, найденного пользователем в истории генераций сервиса. */
  onAttach(files: string[]): void;
  /** Генерации нет в истории сервиса: попытка снова ждёт подтверждения отправки. */
  onNotCreated(): void;
}): ReactElement | null {
  const [confirmNotCreated, setConfirmNotCreated] = useState(false);
  const request = pkg.request;
  if (
    !request ||
    (!RESUMABLE.includes(request.attemptStatus ?? '') &&
      // Получение оборвалось после скачивания (например, приложение закрыли): этап пакета не дошёл до вопроса о результате.
      !(request.attemptStatus === 'downloaded' && ['submitted', 'image_submitted'].includes(pkg.stage)))
  )
    return null;
  const kind = request.kind === 'image' ? 'image' : 'video';
  const provider = mediaProviderInfo(normalizeMediaProvider(request.provider), kind);
  const title = provider?.title ?? request.provider ?? productionTexts.packageResume.service;
  // Без ID задания продолжить получение нельзя: исход выясняет пользователь в истории генераций сервиса.
  const unknown = !request.generationId && !request.manualResult && ['submission_unknown', 'submitting'].includes(request.attemptStatus ?? '');
  const attach = async (): Promise<void> => {
    const files = await window.api.dialog.pickFiles({
      title: kind === 'image' ? productionTexts.packageResume.imageHistory : productionTexts.packageResume.videoHistory,
      filters: [
        kind === 'image'
          ? { name: productionTexts.packageResume.image, extensions: ['png', 'jpg', 'jpeg', 'webp'] }
          : { name: productionTexts.packageResume.video, extensions: ['mp4'] }
      ],
      multiple: true
    });
    if (files.length) onAttach(files);
  };
  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      <Typography variant="body2">
        {kind === 'image' ? productionTexts.packageResume.receivingImage({ frameId: request.frameId }) : productionTexts.packageResume.receivingVideo}
        {request.provider ? ` · ${title}` : ''}
        {request.command ? ` · ${request.command}` : ''}
      </Typography>
      {unknown ? (
        <>
          <Alert severity="warning">
            {productionTexts.packageResume.unknownDescription({
              title,
              history: provider?.generationHistory ?? productionTexts.packageResume.history({ title })
            })}
            <br />
            {productionTexts.packageResume.recoveryDescription}
          </Alert>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <ActionButton variant="contained" startIcon={<UploadFileIcon />} disabled={busy} disabledReason={busyReason} onClick={() => void attach()}>
              {productionTexts.packageResume.upload}
            </ActionButton>
            <ActionButton startIcon={<BlockIcon />} disabled={busy} disabledReason={busyReason} onClick={() => setConfirmNotCreated(true)}>
              {productionTexts.packageResume.notCreated}
            </ActionButton>
          </Stack>
          <ConfirmationDialog
            open={confirmNotCreated}
            title={productionTexts.packageResume.notCreatedTitle}
            confirmLabel={productionTexts.packageResume.notCreatedConfirm}
            confirmIcon={<BlockIcon />}
            confirmColor="warning"
            onClose={() => setConfirmNotCreated(false)}
            onConfirm={() => {
              setConfirmNotCreated(false);
              onNotCreated();
            }}
          >
            <Typography variant="body2">{productionTexts.packageResume.notCreatedDescription({ title })}</Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>
              {productionTexts.packageResume.duplicateWarning}
            </Typography>
          </ConfirmationDialog>
        </>
      ) : (
        <AiButton
          aiKind={kind}
          startIcon={<DownloadIcon />}
          sx={{ alignSelf: 'start' }}
          disabled={busy || !providerAvailable}
          disabledReason={busy ? busyReason : productionTexts.packageResume.providerMissing({ title })}
          onClick={() => onResume()}
        >
          {productionTexts.packageResume.resume}
        </AiButton>
      )}
    </Stack>
  );
}
