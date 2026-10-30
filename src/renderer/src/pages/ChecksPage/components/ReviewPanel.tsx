import { checksTexts } from '@shared/texts/checks';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import type { ReactElement } from 'react';
import { Box, Button, Checkbox, Chip, FormControlLabel, Paper, Typography } from '@mui/material';
import MovieFilterIcon from '@mui/icons-material/MovieFilter';
import ClearIcon from '@mui/icons-material/Clear';
import BuildIcon from '@mui/icons-material/Build';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import type { ReviewInfo, ShotProduction } from '@shared/types';
import { ReviewList } from './ReviewList';
import { ANCHORS } from '../../../components/linkTargets';
import { ActionButton } from '../../../components/ActionButton';

interface ReviewPanelProps {
  shots: ShotProduction[];
  selected: string[];
  planOnly: boolean;
  disabled: boolean;
  /** Почему пробу сейчас нельзя собрать независимо от выбора сцен. */
  disabledReason: string | null;
  reviews: ReviewInfo[];
  openReview: ReviewInfo | null;
  deletingReview: string | null;
  setPlanOnly: (value: boolean) => void;
  toggleShot: (id: string, extend: boolean) => void;
  clearSelection: () => void;
  buildReview: () => Promise<void>;
  setOpenReview: (review: ReviewInfo | null) => void;
  openDirectory: (dir: string) => Promise<void>;
  removeReview: (review: ReviewInfo) => Promise<void>;
}

/** Выбор планов и режима сборки пробы, а также доступ к сохранённым результатам. */
export function ReviewPanel({
  shots,
  selected,
  planOnly,
  disabled,
  disabledReason,
  reviews,
  openReview,
  deletingReview,
  setPlanOnly,
  toggleShot,
  clearSelection,
  buildReview,
  setOpenReview,
  openDirectory,
  removeReview
}: ReviewPanelProps): ReactElement {
  // Проба собирается под непрерывный участок песни: несмежный выбор инструмент отклонит, поэтому объясняем заранее.
  const positions = selected.map((id) => shots.findIndex((shot) => shot.id === id)).sort((a, b) => a - b);
  const gapReason = positions.some((value, index) => index > 0 && value !== positions[index - 1] + 1) ? checksTexts.contiguousShotsRequired : null;
  const buildReason =
    (disabled ? disabledReason : null) ??
    (deletingReview !== null ? checksTexts.reviewDeletionPending : !selected.length ? checksTexts.selectReviewShots : gapReason);
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-anchor={ANCHORS.checksReview}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <MovieFilterIcon color="action" />
        <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }}>
          {navigationTexts.blocks.checksReview}
        </Typography>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {checksTexts.reviewDescription}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {checksTexts.reviewRangeHint}
      </Typography>
      {shots.length ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
          {shots.map((shot) => (
            <Chip
              key={shot.id}
              label={checksTexts.reviewShotLabel({ id: shot.id, missingVideo: !!shot.asset && !shot.asset.video })}
              size="small"
              color={selected.includes(shot.id) ? 'primary' : 'default'}
              variant={shot.asset?.video ? 'filled' : 'outlined'}
              aria-pressed={selected.includes(shot.id)}
              onClick={(event) => toggleShot(shot.id, event.shiftKey)}
              title={checksTexts.reviewShotHint({ title: shot.title, stage: shot.stageLabel, hasVideo: !!shot.asset?.video })}
            />
          ))}
        </Box>
      ) : (
        <Typography variant="caption" color="text.secondary">
          {checksTexts.shotsUnavailable}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <FormControlLabel control={<Checkbox checked={planOnly} onChange={(e) => setPlanOnly(e.target.checked)} />} label={checksTexts.reviewPlanOnly} />
        <Typography variant="caption" color="text.secondary">
          {checksTexts.reviewChipLegend}
        </Typography>
      </Box>
      <ReviewList
        reviews={reviews}
        openReview={openReview}
        deletingReview={deletingReview}
        setOpenReview={setOpenReview}
        openDirectory={openDirectory}
        removeReview={removeReview}
      />
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1, alignItems: 'center' }}>
        <ActionButton
          variant="contained"
          startIcon={planOnly ? <FactCheckIcon /> : <BuildIcon />}
          size="small"
          disabled={disabled || deletingReview !== null || !selected.length || !!gapReason}
          disabledReason={buildReason}
          onClick={buildReview}
        >
          {planOnly ? commonTexts.check : commonTexts.build}
        </ActionButton>
        {selected.length ? (
          <Button size="small" startIcon={<ClearIcon />} onClick={clearSelection}>
            {commonTexts.clearSelection}
          </Button>
        ) : null}
      </Box>
    </Paper>
  );
}
