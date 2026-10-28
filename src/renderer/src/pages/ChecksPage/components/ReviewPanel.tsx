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
  const gapReason = positions.some((value, index) => index > 0 && value !== positions[index - 1] + 1)
    ? 'Выберите сцены подряд: проба собирается под непрерывный участок песни. Диапазон удобно выбрать щелчком с Shift.'
    : null;
  const buildReason =
    (disabled ? disabledReason : null) ??
    (deletingReview !== null ? 'Дождитесь окончания удаления пробы.' : !selected.length ? 'Выберите сцены для пробы.' : gapReason);
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-anchor={ANCHORS.checksReview}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <MovieFilterIcon color="action" />
        <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }}>
          Проба стыков
        </Typography>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Соберите временный ролик, чтобы оценить переходы между планами. Готовые планы будут показаны принятыми клипами, остальные — карточками, под непрерывный
        участок музыки. Проба сохраняется в plan/batches. Она не заменяет аниматик, её сборка не означает приёмку сцен.
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Для диапазона выберите первую сцену, затем последнюю с зажатым Shift. Диапазон добавится к выбранным сценам. С клавиатуры: Shift + Enter.
      </Typography>
      {shots.length ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
          {shots.map((shot) => (
            <Chip
              key={shot.id}
              label={`${shot.id}${shot.asset && !shot.asset.video ? ' · видео отсутствует' : ''}`}
              size="small"
              color={selected.includes(shot.id) ? 'primary' : 'default'}
              variant={shot.asset?.video ? 'filled' : 'outlined'}
              aria-pressed={selected.includes(shot.id)}
              onClick={(event) => toggleShot(shot.id, event.shiftKey)}
              title={`${shot.title} · ${shot.stageLabel}${shot.asset?.video ? '' : ' · пойдёт карточкой'}`}
            />
          ))}
        </Box>
      ) : (
        <Typography variant="caption" color="text.secondary">
          Планы появятся после сборки реестра сцен.
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <FormControlLabel
          control={<Checkbox checked={planOnly} onChange={(e) => setPlanOnly(e.target.checked)} />}
          label="Только проверить, без создания видео"
        />
        <Typography variant="caption" color="text.secondary">
          Заливка: принятое видео доступно; контур: пойдёт карточкой.
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
          {planOnly ? 'Проверить' : 'Собрать'}
        </ActionButton>
        {selected.length ? (
          <Button size="small" startIcon={<ClearIcon />} onClick={clearSelection}>
            Снять выбор
          </Button>
        ) : null}
      </Box>
    </Paper>
  );
}
