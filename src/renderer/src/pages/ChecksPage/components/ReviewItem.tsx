import { FPS } from '@shared/video';
import { useRef, type ReactElement } from 'react';
import { Box, Chip, IconButton, Typography } from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import type { ReviewInfo } from '@shared/types';
import { DateTime } from '../../../components/DateTime';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { ActionButton } from '../../../components/ActionButton';

interface ReviewItemProps {
  review: ReviewInfo;
  openReview: ReviewInfo | null;
  deletingReview: string | null;
  setOpenReview: (review: ReviewInfo | null) => void;
  openDirectory: (dir: string) => Promise<void>;
  removeReview: (review: ReviewInfo) => Promise<void>;
}

/** Показывает сведения о пробе и раскрывает её встроенное видео. */
export function ReviewItem({ review, openReview, deletingReview, setOpenReview, openDirectory, removeReview }: ReviewItemProps): ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);

  const remove = (): void => {
    // Освобождаем MP4 до IPC, чтобы Windows могла удалить файл ещё до размонтирования плеера.
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    if (openReview?.video === review.video) setOpenReview(null);
    void removeReview(review);
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="body2" sx={{ fontFamily: 'monospace', flex: 1 }} noWrap title={review.dir}>
          {review.dir.split(/[\\/]/).pop()}
        </Typography>
        <Chip size="small" variant="outlined" label={review.shots.join(' ')} />
        <Chip size="small" variant="outlined" label={`${(review.totalFrames / FPS).toFixed(1)} с`} />
        <Typography variant="caption" color="text.secondary">
          <DateTime value={review.createdAt} />
        </Typography>
        <ActionButton
          size="small"
          startIcon={openReview?.video === review.video ? <VisibilityOffIcon /> : <VisibilityIcon />}
          disabled={deletingReview === review.video}
          disabledReason="Проба удаляется."
          onClick={() => setOpenReview(openReview?.video === review.video ? null : review)}
        >
          {openReview?.video === review.video ? 'Скрыть' : 'Смотреть'}
        </ActionButton>
        <IconButton size="small" onClick={() => openDirectory(review.dir)} title="Открыть папку" aria-label="Открыть папку">
          <FolderOpenIcon fontSize="small" />
        </IconButton>
        <DestructiveButton
          icon
          label="Удалить пробу"
          description={`Будут удалены MP4 пробы «${review.video.split(/[\\/]/).pop()}» и её рецепт. Исходные медиа и другие файлы в папке сохранятся.`}
          disabled={deletingReview !== null}
          disabledReason="Дождитесь окончания удаления пробы."
          onConfirm={remove}
        >
          <DeleteOutlineIcon fontSize="small" />
        </DestructiveButton>
      </Box>
      {openReview?.video === review.video ? (
        <video
          ref={videoRef}
          controls
          src={window.api.shell.fileUrl(review.video)}
          style={{ width: '100%', maxWidth: 720, marginTop: 8, borderRadius: 4, background: '#000' }}
        />
      ) : null}
    </Box>
  );
}
