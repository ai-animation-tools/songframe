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
  const title = provider?.title ?? request.provider ?? 'сервиса';
  // Без ID задания продолжить получение нельзя: исход выясняет пользователь в истории генераций сервиса.
  const unknown = !request.generationId && !request.manualResult && ['submission_unknown', 'submitting'].includes(request.attemptStatus ?? '');
  const attach = async (): Promise<void> => {
    const files = await window.api.dialog.pickFiles({
      title: kind === 'image' ? 'Изображение из истории генераций' : 'Видео из истории генераций',
      filters: [kind === 'image' ? { name: 'Изображение', extensions: ['png', 'jpg', 'jpeg', 'webp'] } : { name: 'Видео MP4', extensions: ['mp4'] }],
      multiple: true
    });
    if (files.length) onAttach(files);
  };
  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      <Typography variant="body2">
        {kind === 'image' ? `Получение изображения${request.frameId ? ` · опора ${request.frameId}` : ''}` : 'Получение видео'}
        {request.provider ? ` · ${title}` : ''}
        {request.command ? ` · ${request.command}` : ''}
      </Typography>
      {unknown ? (
        <>
          <Alert severity="warning">
            Исход отправки неизвестен: {title} мог создать задание и списать кредиты, но приложение не получило ID задания, а узнать его позже нельзя. Проверьте
            сами: откройте {provider?.generationHistory ?? `историю генераций ${title}`} и найдите генерацию с промптом этой попытки, созданную во время её
            отправки.
            <br />
            Нашли — скачайте оригинал и загрузите его сюда: он станет результатом попытки без новой оплаты. Не нашли — отметьте, что задание не создано, и
            отправьте запрос заново с новым подтверждением стоимости. Если генерация ещё в работе, дождитесь её завершения в истории.
          </Alert>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <ActionButton variant="contained" startIcon={<UploadFileIcon />} disabled={busy} disabledReason={busyReason} onClick={() => void attach()}>
              Загрузить результат вручную
            </ActionButton>
            <ActionButton startIcon={<BlockIcon />} disabled={busy} disabledReason={busyReason} onClick={() => setConfirmNotCreated(true)}>
              Задание не создано
            </ActionButton>
          </Stack>
          <ConfirmationDialog
            open={confirmNotCreated}
            title="Задание не создано?"
            confirmLabel="Задание не создано"
            confirmIcon={<BlockIcon />}
            confirmColor="warning"
            onClose={() => setConfirmNotCreated(false)}
            onConfirm={() => {
              setConfirmNotCreated(false);
              onNotCreated();
            }}
          >
            <Typography variant="body2">
              Отмечайте, только если генерации нет в истории {title}. Попытка снова станет неотправленной, и на вопрос об отправке можно будет ответить заново:
              потребуется новая оценка стоимости и отдельное подтверждение.
            </Typography>
            <Typography variant="body2" sx={{ mt: 1 }}>
              Если задание всё-таки было создано, повторная отправка спишет кредиты ещё раз.
            </Typography>
          </ConfirmationDialog>
        </>
      ) : (
        <AiButton
          aiKind={kind}
          startIcon={<DownloadIcon />}
          sx={{ alignSelf: 'start' }}
          disabled={busy || !providerAvailable}
          disabledReason={busy ? busyReason : `Программа ${title} не найдена: проверьте её на странице «Среда».`}
          onClick={() => onResume()}
        >
          Продолжить получение
        </AiButton>
      )}
    </Stack>
  );
}
