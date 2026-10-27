import DownloadIcon from '@mui/icons-material/Download';
/** Получение по уже существующему ID не создаёт повторной платной отправки. */
import { useState, type ReactElement } from 'react';
import { Alert, Stack, TextField, Typography } from '@mui/material';
import { AiButton } from '../../../components/AiButton';
import type { PackageView } from '@shared/types';
import { isExternalPackage } from '../decisions';

export function PackageResume({
  pkg,
  busy,
  klingAvailable,
  onResume
}: {
  pkg: PackageView;
  busy: boolean;
  klingAvailable: boolean;
  onResume(generationId?: string): void;
}): ReactElement | null {
  const [generationId, setGenerationId] = useState('');
  const request = pkg.request;
  if (isExternalPackage(pkg)) return null;
  if (
    !request ||
    ![
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
    ].includes(request.attemptStatus ?? '')
  )
    return null;
  const unknown = request.attemptStatus === 'submission_unknown' || request.attemptStatus === 'submitting';
  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      <Typography variant="body2">
        {request.kind === 'image' ? `Получение изображения${request.frameId ? ` · опора ${request.frameId}` : ''}` : 'Получение видео'}
        {request.provider ? ` · ${request.provider}` : ''}
        {request.command ? ` · ${request.command}` : ''}
      </Typography>
      {unknown ? (
        <Alert severity="warning">
          Исход отправки неизвестен. Запрос мог быть оплачен. Автоматический повтор запрещён: укажите существующий ID генерации, чтобы проверить результат без
          новой отправки.
        </Alert>
      ) : null}
      {!request.generationId ? (
        <TextField size="small" label="ID существующей генерации Kling" value={generationId} onChange={(event) => setGenerationId(event.target.value)} />
      ) : null}
      <AiButton
        aiKind={pkg.request?.kind === 'image' ? 'image' : 'video'}
        startIcon={<DownloadIcon />}
        sx={{ alignSelf: 'start' }}
        disabled={busy || !klingAvailable || (!request.generationId && !generationId.trim())}
        onClick={() => onResume(request.generationId ?? generationId.trim())}
      >
        {request.generationId ? 'Продолжить получение' : 'Указать ID и проверить'}
      </AiButton>
    </Stack>
  );
}
