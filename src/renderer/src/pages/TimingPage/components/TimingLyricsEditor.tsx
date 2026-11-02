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
import SortIcon from '@mui/icons-material/Sort';
import type { LyricsLine, TimingLine } from '@shared/types';
import { timingEditorTexts as texts } from '@shared/texts/timing-editor';
import { ActionButton } from '../../../components/ActionButton';
import { TimingWorkingLine } from './TimingWorkingLine';
import type { TimingBoundaryDrafts } from '../manualTiming';
import { moveEditorLine, visibleEditorRows, type TimingCandidate, type TimingEditorFilter } from '../timingEditor';

export interface TimingLyricsEditorProps {
  lyrics: LyricsLine[];
  filter?: TimingEditorFilter;
  onFilterChange?(filter: TimingEditorFilter): void;
  rows: TimingLine[];
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
  const header = (number: number): string | undefined => {
    const index = lyrics.findIndex((line) => line.number === number);
    const previous = lyrics
      .slice(0, index)
      .reverse()
      .find((line) => !!line.text.trim());
    return previous?.header ? previous.text : undefined;
  };
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
        <Box sx={{ flex: 1 }} />
        <ActionButton startIcon={<SortIcon />} onClick={() => onOrder(lyrics.filter((line) => !line.header && !!line.text.trim()).map((line) => line.number))}>
          {texts.sourceOrder}
        </ActionButton>
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
            const section = header(line.source_line);
            const timed = Number.isFinite(line.start) && Number.isFinite(line.end);
            const active = selected === line.id;
            const highlighted = active || selectedIds.includes(line.id);
            return (
              <Box
                component="li"
                key={line.source_line}
                sx={{ listStyle: 'none' }}
                data-source-line={line.source_line}
                onDragOver={(event) => {
                  if (filter === 'all') event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = dragged ?? Number(event.dataTransfer.getData('text/plain'));
                  if (filter === 'all' && Number.isFinite(from)) onOrder(moveEditorLine(order, from, line.source_line));
                  setDragged(null);
                }}
              >
                {section && (
                  <Typography component="h3" variant="subtitle2" sx={{ px: 2, py: 1, bgcolor: 'action.hover' }}>
                    {section}
                  </Typography>
                )}
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
                          }}
                          onDragEnd={() => setDragged(null)}
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
