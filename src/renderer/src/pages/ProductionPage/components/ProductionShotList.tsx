import { productionTexts } from '@shared/texts/production';
/** Сетка карточек планов, как на странице «Сцены»: состояние, предпросмотр, этап или ожидающее действие. */
import type { ReactElement } from 'react';
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import { proposalAttention } from '@shared/production-workflow';
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';
import NotificationImportantIcon from '@mui/icons-material/NotificationImportant';
import type { ShotProduction } from '@shared/types';
import { ShotCard } from '../../../components/ShotCard';
import { FILTER_EMPTY_HINTS, FILTER_LABELS, type ProductionFilter } from '../constants';
import { shotPreview } from '../preview';
import { LinkedText } from '../../../components/LinkedText';

export function ProductionShotList({
  shots,
  selected,
  onSelect,
  filter = 'all',
  onResetFilter,
  withDetails = false
}: {
  shots: ShotProduction[];
  selected: string | null;
  onSelect(id: string): void;
  filter?: ProductionFilter;
  onResetFilter?(): void;
  /** Рядом открыт выбранный план: при широком окне он занимает правую колонку, а список держит три карточки в ряд. */
  withDetails?: boolean;
}): ReactElement {
  // Пустой фильтр оформлен как пустая очередь: заголовок с числом, пояснение и путь назад к полному списку.
  if (!shots.length)
    return (
      <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
        <Stack spacing={2}>
          <Typography variant="h6">{FILTER_LABELS[filter]} (0)</Typography>
          <Alert severity="info">
            <LinkedText text={FILTER_EMPTY_HINTS[filter]} />
          </Alert>
          {filter !== 'all' && onResetFilter ? (
            <Button size="small" startIcon={<FilterAltOffIcon />} onClick={onResetFilter} sx={{ alignSelf: 'start' }}>
              {productionTexts.productionShotList.showAll}
            </Button>
          ) : null}
        </Stack>
      </Paper>
    );
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))',
        '@container workspace (min-width: 1100px)': withDetails ? { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' } : {},
        gap: 1.5,
        minWidth: 0
      }}
    >
      {shots.map((shot) => {
        const { videoPath, imagePath } = shotPreview(shot);
        return (
          <ShotCard
            key={shot.id}
            shot={shot}
            videoPath={videoPath}
            imagePath={imagePath}
            chips={
              <>
                {shot.derivedFrom ? (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={productionTexts.productionShotList.derivedFrom({ derivedFrom: shot.derivedFrom })}
                    title={productionTexts.productionShotList.derivedHint({ derivedFrom: shot.derivedFrom })}
                    sx={{ height: 18 }}
                  />
                ) : null}
                {/* Непринятое предложение агента: без отметки его видно только в панели подготовки выбранного плана. */}
                {shot.proposal ? (
                  <Chip
                    size="small"
                    variant="outlined"
                    color={shot.proposal.status === 'ready' && !shot.proposal.stale ? 'info' : 'warning'}
                    label={
                      shot.proposal.status === 'ready' && !shot.proposal.stale
                        ? productionTexts.productionShotList.proposal
                        : productionTexts.productionShotList.invalidProposal
                    }
                    title={proposalAttention(shot.proposal)}
                    sx={{ height: 18 }}
                  />
                ) : null}
                {(shot.state === 'completed' || shot.state === 'stale') && !shot.asset?.video ? (
                  <Chip size="small" color="warning" label={productionTexts.productionShotList.missingVideo} sx={{ height: 18 }} />
                ) : null}
              </>
            }
            caption={shot.attention ? productionTexts.productionShotList.attention({ attention: shot.attention }) : undefined}
            captionColor={shot.attention ? 'primary.main' : undefined}
            captionIcon={
              shot.attention ? (
                <NotificationImportantIcon fontSize="inherit" color="primary" titleAccess={productionTexts.productionShotList.attentionLabel} />
              ) : null
            }
            selected={shot.id === selected}
            onSelect={onSelect}
          />
        );
      })}
    </Box>
  );
}
