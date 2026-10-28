import type { ReactElement, ReactNode } from 'react';
import { Box, Paper, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import type { DashboardShot } from '@shared/types';
import { formatClock } from '../../../format';
import { STATE_LABELS, type Filter } from '../types';

/** Объединяет шкалу сцен с поиском и фильтром состояния производства. */
export function ScenesTimeline({
  shots,
  selected,
  filter,
  query,
  duration,
  visibleCount,
  onSelect,
  onFilter,
  onQuery,
  actions
}: {
  shots: DashboardShot[];
  selected: string | null;
  filter: Filter;
  query: string;
  duration: number;
  visibleCount: number;
  onSelect(id: string): void;
  onFilter(value: Filter): void;
  onQuery(value: string): void;
  /** Действия над видимыми планами стоят в блоке фильтра, к которому относятся. */
  actions?: ReactNode;
}): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Box sx={{ display: 'flex', height: 26, borderRadius: 1, overflow: 'hidden', border: 1, borderColor: 'divider' }}>
        {shots.map((s) => (
          <Tooltip key={s.id} title={`${s.id} · ${s.title} · ${STATE_LABELS[s.state].label}`} placement="top">
            <Box
              onClick={() => onSelect(s.id)}
              sx={{
                flex: Math.max(s.end - s.start, 0.01),
                bgcolor: STATE_LABELS[s.state].bar,
                opacity: selected === s.id ? 1 : 0.6,
                outline: selected === s.id ? 2 : 0,
                outlineColor: 'text.primary',
                outlineOffset: -2,
                borderRight: 1,
                borderColor: 'background.paper',
                cursor: 'pointer',
                '&:hover': { opacity: 1 }
              }}
            />
          </Tooltip>
        ))}
      </Box>
      <Box sx={{ display: 'flex', gap: 1, mt: 1, alignItems: 'center', flexWrap: 'wrap' }}>
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_e, v: Filter | null) => v && onFilter(v)}>
          <ToggleButton value="all">все</ToggleButton>
          <ToggleButton value="completed">принятые</ToggleButton>
          <ToggleButton value="progress">в работе</ToggleButton>
          <ToggleButton value="planned">не начатые</ToggleButton>
        </ToggleButtonGroup>
        {/* Подпись видна и после ввода поискового запроса. */}
        <TextField
          size="small"
          label="Поиск планов"
          placeholder="По коду, строке, действию"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          sx={{ minWidth: 280 }}
        />
        <Typography variant="caption" color="text.secondary">
          {visibleCount} из {shots.length} · {formatClock(duration)}
        </Typography>
      </Box>
      {actions ? <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>{actions}</Box> : null}
    </Paper>
  );
}
