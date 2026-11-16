import { scenarioTexts } from '@shared/texts/scenario';
import { useState, type ReactElement } from 'react';
import { Box, ButtonBase, Chip, InputAdornment, Paper, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { matchesWords, searchWords } from '../../../components/searchText';
import type { ScenesFile, ShotProductionState } from '@shared/types';
import { SHOT_STATE_LABELS } from '../../../components/shotState';
import { formatClock } from '../../../format';

/**
 * Показывает список планов с таймингом, статусом производства (бейдж как в карточке «Производства») и признаками
 * заполнения; поиск стоит сверху, прокручивается только список.
 */
export function SceneList({
  scenes,
  selected,
  onSelect,
  maxHeight,
  states
}: {
  scenes: ScenesFile;
  selected: string | null;
  onSelect(id: string): void;
  /** Высота колонки: в закреплённой раскладке — до низа окна. */
  maxHeight: string | Record<string, string>;
  /** Статусы производства планов (useShotStates); null — ещё не загружены, бейджей нет. */
  states: Record<string, ShotProductionState> | null;
}): ReactElement {
  const [query, setQuery] = useState('');
  const words = searchWords(query);
  // Ищем по коду, строке песни, названию, действию и камере плана.
  const shown = words.length
    ? scenes.scenes.filter((s) => matchesWords([s.id, s.original, s.title ?? '', s.action, s.camera].join(' '), words))
    : scenes.scenes;
  return (
    <Paper variant="outlined" sx={{ maxHeight, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <Box sx={{ p: 1, pb: 0.5, borderBottom: 1, borderColor: 'divider' }}>
        <TextField
          size="small"
          type="search"
          fullWidth
          label={scenarioTexts.list.search}
          placeholder={scenarioTexts.list.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              )
            }
          }}
        />
        <Typography variant="caption" color="text.secondary" component="div" aria-live="polite" sx={{ mt: 0.5 }}>
          {words.length
            ? scenarioTexts.list.foundShots({ shown: shown.length, total: scenes.scenes.length })
            : scenarioTexts.list.shots({ count: scenes.scenes.length })}
        </Typography>
      </Box>
      <Box sx={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
        {words.length && !shown.length ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
            {scenarioTexts.list.nothingFound}
          </Typography>
        ) : null}
        {shown.map((s) => {
          // eslint-disable-next-line no-restricted-syntax -- Маркер каркаса из данных scene_scaffold, а не подпись интерфейса.
          const filled = !s.action.startsWith('ЗАПОЛНИТЬ') && !s.camera.startsWith('ЗАПОЛНИТЬ');
          const status = states ? SHOT_STATE_LABELS[states[s.id] ?? 'planned'] : null;
          return (
            // Строка — кнопка: план выбирается и с клавиатуры (Tab, Enter или пробел), выбранный отмечен aria-current.
            <ButtonBase
              key={s.id}
              component="div"
              focusRipple
              data-shot-id={s.id}
              aria-current={s.id === selected || undefined}
              onClick={() => onSelect(s.id)}
              sx={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                px: 1.5,
                py: 0.75,
                cursor: 'pointer',
                borderLeft: 3,
                borderColor: s.id === selected ? 'primary.main' : 'transparent',
                bgcolor: s.id === selected ? 'action.selected' : undefined,
                '&:hover': { bgcolor: 'action.hover' },
                '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 }
              }}
            >
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', rowGap: 0.25 }}>
                <Typography fontWeight={600} sx={{ fontFamily: 'monospace' }}>
                  {s.id}
                </Typography>
                {status ? <Chip size="small" color={status.color} label={status.label} sx={{ height: 18 }} data-testid="shot-status" /> : null}
                <Typography variant="caption" color="text.secondary">
                  {scenarioTexts.timeline.range({ start: formatClock(s.start_frame / scenes.fps), end: formatClock(s.end_frame_exclusive / scenes.fps) })}
                </Typography>
                {/* Заливка: контурный warning на фоне выбранной строки (action.selected) не держит 4.5:1. */}
                {!filled ? <Chip size="small" label={scenarioTexts.brief.empty} color="warning" sx={{ height: 18 }} /> : null}
                {s.lipsync ? <Chip size="small" label={scenarioTexts.list.speech} sx={{ height: 18 }} /> : null}
              </Box>
              <Typography variant="caption" noWrap display="block" color="text.secondary">
                {s.original}
              </Typography>
            </ButtonBase>
          );
        })}
      </Box>
    </Paper>
  );
}
