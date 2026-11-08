import { productionTexts } from '@shared/texts/production';
/** Итоги производства, фильтр планов со счётчиками и ручное обновление. */
import type { ReactElement } from 'react';
import { Box, Button, Chip, MenuItem, TextField, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { ProductionView } from '@shared/types';
import type { ProductionFilter } from '../constants';
import { FILTER_LABELS } from '../constants';
import { isQueuedPackage } from '../decisions';
import { ANCHORS } from '../../../components/linkTargets';

export function ProductionToolbar({
  view,
  filter,
  onFilter,
  onRefresh
}: {
  view: ProductionView;
  filter: ProductionFilter;
  onFilter(value: ProductionFilter): void;
  onRefresh(): void;
}): ReactElement {
  // Счётчики стоят в пунктах списка «Показать»: отдельные чипы и кнопка очереди дублировали бы этот же фильтр.
  const counts: Record<ProductionFilter, number> = {
    all: view.shots.length,
    attention: view.shots.filter((s) => s.attention).length,
    progress: view.shots.filter((s) => s.state === 'progress').length,
    planned: view.shots.filter((s) => s.state === 'planned').length,
    completed: view.shots.filter((s) => s.state === 'completed').length,
    stale: view.shots.filter((s) => s.state === 'stale').length,
    queued: view.shots.flatMap((shot) => shot.packages.filter(isQueuedPackage)).length + view.broken.length
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
      <Typography variant="h5" noWrap>
        {productionTexts.productionToolbar.heading}
      </Typography>
      {/* Счётчик появляется после создания планов: пустой проект ещё нечего принимать. */}
      {view.shots.length ? (
        <Chip
          size="small"
          label={productionTexts.productionToolbar.accepted({ completed: counts.completed, total: view.shots.length })}
          color={counts.completed === view.shots.length ? 'success' : 'default'}
        />
      ) : null}
      {/* Планы, ждущие решения пользователя, — сигнал, а не просто счётчик: чип остаётся в панели и открывает их фильтр. */}
      {counts.attention ? (
        <Chip
          size="small"
          color="primary"
          label={productionTexts.productionToolbar.attention({ attention: counts.attention })}
          title={productionTexts.productionToolbar.attentionHint}
          onClick={() => onFilter('attention')}
        />
      ) : null}
      {/* Принятые по прежней постановке планы ждут нового производства: чип показывает их фильтр. */}
      {counts.stale ? (
        <Chip
          size="small"
          color="info"
          label={productionTexts.productionToolbar.stale({ stale: counts.stale })}
          title={productionTexts.productionToolbar.staleHint}
          onClick={() => onFilter('stale')}
        />
      ) : null}
      <Box sx={{ flex: 1 }} />
      {/* Подпись остаётся видимой и после выбора конкретного состояния планов. */}
      <TextField
        select
        size="small"
        label={productionTexts.productionToolbar.show}
        data-anchor={ANCHORS.productionFilter}
        value={filter}
        onChange={(e) => onFilter(e.target.value as ProductionFilter)}
        sx={{ minWidth: 160 }}
      >
        {(Object.keys(FILTER_LABELS) as ProductionFilter[]).map((value) => (
          <MenuItem key={value} value={value}>
            {FILTER_LABELS[value]} ({counts[value]})
          </MenuItem>
        ))}
      </TextField>
      <Button startIcon={<RefreshIcon />} onClick={onRefresh} sx={{ flexShrink: 0 }}>
        {productionTexts.productionToolbar.refresh}
      </Button>
    </Box>
  );
}
