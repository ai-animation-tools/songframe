import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import {
  Box,
  Chip,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import type { LyricsLine, TimingLine, TimingSection } from '@shared/types';
import { timingEditorTexts as texts } from '@shared/texts/timing-editor';
import { TimingWorkingLine } from './TimingWorkingLine';
import type { TimingBoundaryDrafts } from '../manualTiming';
import {
  editorSectionLayout,
  moveEditorLine,
  visibleEditorRows,
  type EditorSectionHeader,
  type TimingCandidate,
  type TimingEditorFilter
} from '../timingEditor';

export interface TimingLyricsEditorProps {
  lyrics: LyricsLine[];
  filter?: TimingEditorFilter;
  onFilterChange?(filter: TimingEditorFilter): void;
  rows: TimingLine[];
  /** Текущая музыкальная карта: пересчитывается при каждой правке границ строк. */
  sections?: TimingSection[];
  candidates: TimingCandidate[];
  selected: number | null;
  selectedIds?: number[];
  order: number[];
  drafts: TimingBoundaryDrafts;
  time: number;
  duration: number;
  hasTrack: boolean;
  playingLineId: number | null;
  loopingLineId: number | null;
  onSelect(id: number | null): void;
  onStop(): void;
  onOrder(order: number[]): void;
  onInput(id: number, field: 'start' | 'end', text: string): void;
  onUpdate(id: number, patch: Partial<TimingLine>): void;
  onPlay(line: TimingLine): void;
  onLoop(line: TimingLine): void;
  onRemove(id: number): void;
}

/** Единый список сохраняет место пропуска и связь одинаковых припевов с source_line. */
export function TimingLyricsEditor({
  lyrics,
  filter: controlledFilter,
  onFilterChange,
  rows,
  sections = [],
  candidates,
  selected,
  selectedIds = [],
  order,
  drafts,
  time,
  duration,
  hasTrack,
  playingLineId,
  loopingLineId,
  onSelect,
  onStop,
  onOrder,
  onInput,
  onUpdate,
  onPlay,
  onLoop,
  onRemove
}: TimingLyricsEditorProps): ReactElement {
  const [localFilter, setLocalFilter] = useState<TimingEditorFilter>('all');
  const filter = controlledFilter ?? localFilter;
  const setFilter = onFilterChange ?? setLocalFilter;
  const [dragged, setDragged] = useState<number | null>(null);
  // Строка под курсором во время перетаскивания: на ней рисуется линия места вставки.
  const [over, setOver] = useState<number | null>(null);
  const endDrag = (): void => {
    setDragged(null);
    setOver(null);
  };
  const visible = visibleEditorRows(rows, filter);
  const source = new Map(lyrics.map((line) => [line.number, line]));
  const proposed = new Map(candidates.map((line) => [line.source_line, line]));
  // Горячая клавиша подтверждения использует то же продвижение, что и кнопка рабочей строки.
  useEffect(() => {
    if (selected === null || filter === 'all' || visible.some((line) => line.id === selected)) return;
    const index = rows.findIndex((line) => line.id === selected);
    const next =
      visible.find((line) => rows.indexOf(line) > index) ??
      visible
        .slice()
        .reverse()
        .find((line) => rows.indexOf(line) < index);
    onStop();
    onSelect(next?.id ?? null);
  }, [selected, filter, visible, rows, onStop, onSelect]);

  const select = (id: number | null): void => {
    if (id !== selected) onStop();
    onSelect(id);
  };
  const layout = editorSectionLayout(lyrics, sections, rows, visible);
  return (
    <Stack spacing={1.5}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          aria-label={texts.filter}
          onChange={(_event, next: TimingEditorFilter | null) => {
            if (!next) return;
            onStop();
            setFilter(next);
            if (!visibleEditorRows(rows, next).some((line) => line.id === selected)) onSelect(null);
          }}
        >
          <ToggleButton value="all">{texts.all}</ToggleButton>
          <ToggleButton value="remaining">{texts.remaining}</ToggleButton>
          <ToggleButton value="verified">{texts.verified}</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="body2" color="text.secondary">
          {texts.count({ visible: visible.length, total: rows.length })}
        </Typography>
      </Box>
      {filter === 'all' && (
        <Typography variant="caption" color="text.secondary">
          {texts.reorderHint}
        </Typography>
      )}
      <Paper variant="outlined" role="region" aria-label={texts.list} sx={{ overflow: 'hidden' }}>
        <List disablePadding>
          {visible.map((line, index) => {
            const candidate = proposed.get(line.source_line);
            const title = source.get(line.source_line)?.text ?? '';
            const headers = layout.before.get(line.id) ?? [];
            const timed = Number.isFinite(line.start) && Number.isFinite(line.end);
            const active = selected === line.id;
            const highlighted = active || selectedIds.includes(line.id);
            // moveEditorLine ставит строку на место цели: при движении вниз — после неё, вверх — перед ней.
            const insert =
              dragged !== null && over === line.source_line && dragged !== over ? (order.indexOf(dragged) < order.indexOf(over) ? 'after' : 'before') : null;
            return (
              <Box
                component="li"
                key={line.source_line}
                sx={{
                  listStyle: 'none',
                  position: 'relative',
                  opacity: dragged === line.source_line ? 0.5 : undefined,
                  // Линия места вставки поверх содержимого строки, чтобы её не перекрывали фон и разделитель.
                  '&::after': insert
                    ? {
                        content: '""',
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        height: 3,
                        bgcolor: 'primary.main',
                        pointerEvents: 'none',
                        zIndex: 1,
                        ...(insert === 'before' ? { top: 0 } : { bottom: 0 })
                      }
                    : undefined
                }}
                data-source-line={line.source_line}
                data-drop-position={insert ?? undefined}
                onDragOver={(event) => {
                  if (filter !== 'all') return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  if (dragged !== null && over !== line.source_line) setOver(line.source_line);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = dragged ?? Number(event.dataTransfer.getData('text/plain'));
                  if (filter === 'all' && Number.isFinite(from)) onOrder(moveEditorLine(order, from, line.source_line));
                  endDrag();
                }}
              >
                {headers.map((header) => (
                  <SectionHeader key={header.key} header={header} />
                ))}
                <Box sx={{ bgcolor: highlighted ? 'action.selected' : undefined, borderLeft: 3, borderColor: highlighted ? 'primary.main' : 'transparent' }}>
                  <ListItem disablePadding component="div">
                    {filter === 'all' && (
                      <Tooltip title={texts.reorderHint}>
                        <IconButton
                          size="small"
                          draggable
                          aria-label={texts.reorder({ number: line.source_line })}
                          sx={{ ml: 0.5, cursor: 'grab' }}
                          onDragStart={(event) => {
                            setDragged(line.source_line);
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/plain', String(line.source_line));
                            // Под курсором видна вся строка, а не только значок перетаскивания.
                            const row = event.currentTarget.closest('li');
                            if (row) event.dataTransfer.setDragImage(row, 16, 16);
                          }}
                          onDragEnd={endDrag}
                          onKeyDown={(event) => {
                            if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                            event.preventDefault();
                            const position = order.indexOf(line.source_line);
                            const to = order[position + (event.key === 'ArrowUp' ? -1 : 1)];
                            if (to !== undefined) onOrder(moveEditorLine(order, line.source_line, to));
                          }}
                        >
                          <DragIndicatorIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    <ListItemButton
                      selected={highlighted}
                      aria-expanded={active}
                      onClick={() => select(line.id)}
                      sx={{ px: 1.5, py: 1.5, gap: 1.5, flexWrap: 'wrap' }}
                    >
                      <Box component="span" sx={visuallyHidden}>
                        {texts.sourcePrefix}
                      </Box>
                      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 20 }}>
                        {line.source_line}
                      </Typography>
                      <Typography sx={{ flex: '1 1 260px', fontWeight: active ? 600 : 400, overflowWrap: 'anywhere' }}>{title}</Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                        {timed ? `${line.start.toFixed(2)} – ${line.end.toFixed(2)}` : texts.unmarked}
                      </Typography>
                      <Chip
                        size="small"
                        variant={line.verified ? 'filled' : 'outlined'}
                        color={line.verified ? 'success' : candidate ? 'warning' : 'default'}
                        label={line.verified ? texts.checked : candidate ? texts.candidate : texts.unchecked}
                      />
                    </ListItemButton>
                  </ListItem>
                  {active && (
                    <TimingWorkingLine
                      line={line}
                      candidate={candidate}
                      drafts={drafts[line.id]}
                      duration={duration}
                      time={time}
                      hasTrack={hasTrack}
                      playing={playingLineId === line.id}
                      looping={loopingLineId === line.id}
                      onInput={onInput}
                      onPlay={onPlay}
                      onLoop={onLoop}
                      onRemove={onRemove}
                      previousDisabled={index === 0}
                      nextDisabled={index === visible.length - 1}
                      onNavigate={(direction) => select(visible[index + direction]?.id ?? null)}
                      onUpdate={(id, patch) => {
                        onUpdate(id, patch);
                        if (filter === 'remaining' && patch.verified) {
                          onStop();
                          onSelect(visible[index + 1]?.id ?? visible[index - 1]?.id ?? null);
                        }
                      }}
                    />
                  )}
                </Box>
                {index < visible.length - 1 && <Divider />}
              </Box>
            );
          })}
          {visible.length > 0 &&
            layout.after.map((header) => (
              <Box component="li" key={header.key} sx={{ listStyle: 'none' }}>
                <Divider />
                <SectionHeader header={header} />
              </Box>
            ))}
        </List>
        {!visible.length && (
          <Typography role="status" color="text.secondary" sx={{ p: 3 }}>
            {!rows.length ? texts.empty : filter === 'remaining' ? texts.completed : texts.noVerified}
          </Typography>
        )}
      </Paper>
    </Stack>
  );
}

/** Заголовок секции над её строками: название без скобок, начало – конец и длительность по текущей карте. */
function SectionHeader({ header }: { header: EditorSectionHeader }): ReactElement {
  const timed = header.start !== undefined && header.end !== undefined;
  return (
    <Box data-section={header.name} sx={{ px: 2, py: 1, bgcolor: 'action.hover', display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap' }}>
      <Typography component="h3" variant="subtitle2">
        {header.name}
      </Typography>
      {header.note && (
        <Typography variant="caption" color="text.secondary">
          {header.note}
        </Typography>
      )}
      <Box sx={{ flex: 1 }} />
      {timed && (
        <Typography variant="body2" sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
          {texts.sectionRange({ start: header.start as number, end: header.end as number })}
        </Typography>
      )}
    </Box>
  );
}
