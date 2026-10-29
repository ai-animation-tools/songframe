import { useState, type ReactElement } from 'react';
import { Box, Chip, InputAdornment, Paper, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { matchesWords, searchWords } from '../../../components/searchText';
import type { ScenesFile } from '@shared/types';
import { formatClock } from '../../../format';
import { FPS } from '@shared/video';

/** Показывает список планов с таймингом и признаками заполнения; поиск стоит сверху, прокручивается только список. */
export function SceneList({
  scenes,
  selected,
  onSelect,
  maxHeight
}: {
  scenes: ScenesFile;
  selected: string | null;
  onSelect(id: string): void;
  /** Высота колонки: в закреплённой раскладке — до низа окна. */
  maxHeight: string | Record<string, string>;
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
          label="Поиск плана"
          placeholder="Код, строка песни или действие"
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
          {words.length ? `Найдено планов: ${shown.length} из ${scenes.scenes.length}` : `Планов: ${scenes.scenes.length}`}
        </Typography>
      </Box>
      <Box sx={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
        {words.length && !shown.length ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
            Ничего не найдено. Попробуйте код плана или часть строки песни.
          </Typography>
        ) : null}
        {shown.map((s) => {
          const filled = !s.action.startsWith('ЗАПОЛНИТЬ') && !s.camera.startsWith('ЗАПОЛНИТЬ');
          return (
            <Box
              key={s.id}
              data-shot-id={s.id}
              onClick={() => onSelect(s.id)}
              sx={{
                px: 1.5,
                py: 0.75,
                cursor: 'pointer',
                borderLeft: 3,
                borderColor: s.id === selected ? 'primary.main' : 'transparent',
                bgcolor: s.id === selected ? 'action.selected' : undefined,
                '&:hover': { bgcolor: 'action.hover' }
              }}
            >
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <Typography fontWeight={600} sx={{ fontFamily: 'monospace' }}>
                  {s.id}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatClock(s.start_frame / FPS)}–{formatClock(s.end_frame_exclusive / FPS)}
                </Typography>
                {!filled ? <Chip size="small" label="пусто" color="warning" variant="outlined" sx={{ height: 18 }} /> : null}
                {s.lipsync ? <Chip size="small" label="речь" sx={{ height: 18 }} /> : null}
              </Box>
              <Typography variant="caption" noWrap display="block" color="text.secondary">
                {s.original}
              </Typography>
            </Box>
          );
        })}
      </Box>
    </Paper>
  );
}
