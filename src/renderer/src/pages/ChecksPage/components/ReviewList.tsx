import type { ReactElement } from 'react';
import { Stack, Typography } from '@mui/material';
import type { ReviewInfo } from '@shared/types';
import { ReviewItem } from './ReviewItem';

interface ReviewListProps {
  reviews: ReviewInfo[];
  openReview: ReviewInfo | null;
  deletingReview: string | null;
  setOpenReview: (review: ReviewInfo | null) => void;
  openDirectory: (dir: string) => Promise<void>;
  removeReview: (review: ReviewInfo) => Promise<void>;
}

/** Список сохранённых проб с общим выбором открытого видео. */
export function ReviewList({ reviews, openReview, deletingReview, setOpenReview, openDirectory, removeReview }: ReviewListProps): ReactElement | null {
  if (!reviews.length) return null;
  return (
    <Stack spacing={0.5} sx={{ mt: 2 }}>
      <Typography variant="subtitle2">Собранные пробы в plan/batches</Typography>
      {reviews.map((review) => (
        <ReviewItem
          key={review.video}
          review={review}
          openReview={openReview}
          deletingReview={deletingReview}
          setOpenReview={setOpenReview}
          openDirectory={openDirectory}
          removeReview={removeReview}
        />
      ))}
    </Stack>
  );
}
