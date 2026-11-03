import { productionTexts } from '@shared/texts/production';
import GridViewIcon from '@mui/icons-material/GridView';
/** Скачанные оригиналы, техническая сводка и действие приёмки результата; изображения открываются в общей галерее. */
import { useRef, useState, type ReactElement } from 'react';
import { Box, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import type { PackageView } from '@shared/types';
import { ImageGallery } from '../../../components/ImageGallery';
import { ImageThumbnail } from '../../../components/ImageThumbnail';
import { ActionButton } from '../../../components/ActionButton';
import { BUSY_REASON } from '../constants';
import { VideoReviewPanel } from './VideoReviewPanel';

export function PackageResult({
  pkg,
  busy,
  busyReason = BUSY_REASON,
  onAccept,
  onContactSheet,
  onSelectImage,
  onReopenQuestion
}: {
  pkg: PackageView;
  busy: boolean;
  /** Почему busy блокирует действия: идёт операция или нет Python. */
  busyReason?: string;
  onAccept(): void;
  onContactSheet(): void;
  onSelectImage(index: number): void;
  /** Снова задать вопрос о результате, когда прежний ответ уже записан. */
  onReopenQuestion?(): void;
}): ReactElement {
  const originalVideo = useRef<HTMLVideoElement>(null);
  const pending = pkg.pendingDecision;
  const image = pkg.request?.kind === 'image';
  const canSelectImage = !pending && pkg.stage === 'image_downloaded' && !!pkg.resultToken;
  const selectReason = busy
    ? busyReason
    : pending
      ? productionTexts.packageResult.decisionRequired
      : pkg.stage !== 'image_downloaded'
        ? productionTexts.packageResult.selectionUnavailable
        : !pkg.resultToken
          ? productionTexts.packageResult.resultUnconfirmed
          : null;
  const downloaded = pkg.request?.downloads.length ? pkg.request.downloads : [];
  const [gallery, setGallery] = useState<{ kind: string; images: { imagePath: string; label: string }[]; index: number } | null>(null);
  const frame = pkg.request?.frameId ? `${pkg.request.frameId} · ` : '';
  const variants = image
    ? downloaded.map((path, index) => ({ imagePath: path, label: productionTexts.packageResult.candidateLabel({ frame, variant: index + 1 }) }))
    : [];
  const previews = pkg.preview.map((path, index) => ({
    imagePath: path,
    label: productionTexts.packageResult.summaryLabel({ filename: path.split(/[\\/]/).pop() ?? index + 1 })
  }));
  return (
    <>
      {downloaded.length ? (
        <Box sx={{ mb: 1 }}>
          <Typography variant="subtitle2" gutterBottom>
            {productionTexts.packageResult.heading}
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {downloaded.map((path, index) =>
              image ? (
                <Box key={path} sx={{ width: 420, minWidth: 0, maxWidth: '100%' }}>
                  <ImageThumbnail
                    path={path}
                    label={variants[index].label}
                    title={path}
                    aspectRatio={null}
                    dashed
                    highlight="warning"
                    onOpen={() => setGallery({ kind: productionTexts.packageResult.galleryKind, images: variants, index })}
                  />
                  <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                    {variants[index].label}
                  </Typography>
                  <ActionButton
                    startIcon={<CheckCircleIcon />}
                    variant="outlined"
                    sx={{ mt: 1 }}
                    disabled={busy || !canSelectImage}
                    disabledReason={selectReason}
                    onClick={() => onSelectImage(index)}
                  >
                    {productionTexts.packageResult.select}
                  </ActionButton>
                </Box>
              ) : (
                <video
                  key={path}
                  ref={index === 0 ? originalVideo : undefined}
                  controls
                  preload="metadata"
                  src={window.api.shell.fileUrl(path)}
                  style={{ width: 420, maxWidth: '100%', borderRadius: 8, background: '#000' }}
                />
              )
            )}
          </Box>
          {image ? (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              {productionTexts.packageResult.selectionHint}
            </Typography>
          ) : pkg.preview.length ? (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
              {previews.map((preview, index) => (
                <Box key={preview.imagePath} sx={{ width: 420, maxWidth: '100%' }}>
                  <ImageThumbnail
                    path={preview.imagePath}
                    label={preview.label}
                    title={preview.imagePath}
                    aspectRatio={null}
                    onOpen={() => setGallery({ kind: productionTexts.packageResult.summary, images: previews, index })}
                  />
                </Box>
              ))}
            </Box>
          ) : (
            <ActionButton startIcon={<GridViewIcon />} size="small" sx={{ mt: 1 }} onClick={onContactSheet} disabled={busy} disabledReason={busyReason}>
              {productionTexts.packageResult.createSummary}
            </ActionButton>
          )}
          {!image && ['downloaded', 'edit_review', 'accepted'].includes(pkg.stage) ? (
            <VideoReviewPanel
              key={pkg.dir}
              packageDir={pkg.dir}
              onSeek={(timeSeconds) => {
                // Таймкод отчёта относится к оригиналу; монтажный срез и приёмка не меняются.
                const video = originalVideo.current;
                if (video) video.currentTime = Math.max(0, Math.min(timeSeconds, Number.isFinite(video.duration) ? video.duration : timeSeconds));
              }}
            />
          ) : null}
          {!image && !pending && ['downloaded', 'edit_review'].includes(pkg.stage) ? (
            <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
              <ActionButton variant="contained" color="error" startIcon={<CheckCircleIcon />} disabled={busy} disabledReason={busyReason} onClick={onAccept}>
                {productionTexts.packageResult.accept}
              </ActionButton>
              {onReopenQuestion ? (
                <ActionButton variant="outlined" startIcon={<HelpOutlineIcon />} disabled={busy} disabledReason={busyReason} onClick={onReopenQuestion}>
                  {productionTexts.packageResult.reopen}
                </ActionButton>
              ) : null}
            </Box>
          ) : null}
        </Box>
      ) : null}
      {gallery ? <ImageGallery kind={gallery.kind} images={gallery.images} initialIndex={gallery.index} onClose={() => setGallery(null)} /> : null}
    </>
  );
}
