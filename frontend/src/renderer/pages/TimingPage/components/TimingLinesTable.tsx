import { timingTexts } from '@shared/texts/timing';
import { useState, type ReactElement } from 'react';
import { Box, Paper, Stack, ToggleButton, ToggleButtonGroup, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { TimingLine } from '@shared/types';
import { filterTimingLines, type TimingLineFilter } from '../timingPlayback';
import { neighbours } from '../timing';
import { TimingLineRow } from './TimingLineRow';
import type { TimingBoundaryDrafts } from '../manualTiming';

interface TimingLinesTableProps {
  lines: TimingLine[];
  selected: number | null;
  playingLineId?: number | null;
  loopingLineId?: number | null;
  onLoop?: (line: TimingLine) => void;
  manualMode?: boolean;
  boundaryDrafts?: TimingBoundaryDrafts;
  onBoundaryInput?: (id: number, field: 'start' | 'end', value: string) => void;
  duration: number;
  textOf: (line: TimingLine) => string;
  onSelect: (line: TimingLine) => void;
  onUpdate: (id: number, patch: Partial<TimingLine>) => void;
  onPlay: (line: TimingLine) => void;
  onRemove: (id: number) => void;
}

/** Черновики привязаны к ID, поэтому перестановка строк по времени не теряет незаконченный ввод. */
export function TimingLinesTable({
  lines,
  selected,
  playingLineId,
  loopingLineId,
  onLoop,
  duration,
  textOf,
  onSelect,
  onUpdate,
  onPlay,
  onRemove,
  manualMode = false,
  boundaryDrafts,
  onBoundaryInput
}: TimingLinesTableProps): ReactElement {
  const [filter, setFilter] = useState<TimingLineFilter>('all');
  // Ручной ввод не переставляет активную строку после каждого символа; сохранение упорядочит документ.
  const sorted = manualMode || (boundaryDrafts && Object.keys(boundaryDrafts).length) ? lines : [...lines].sort((a, b) => a.start - b.start);
  const visible = filterTimingLines(sorted, filter);
  return (
    <Stack spacing={1}>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          aria-label={timingTexts.lineFilter}
          onChange={(_event, next: TimingLineFilter | null) => {
            if (next) setFilter(next);
          }}
        >
          <ToggleButton value="all">{timingTexts.filterAll}</ToggleButton>
          <ToggleButton value="verified">{timingTexts.filterVerified}</ToggleButton>
          <ToggleButton value="unverified">{timingTexts.filterUnverified}</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="body2" color="text.secondary">
          {timingTexts.filteredCount({ visible: visible.length, total: lines.length })}
        </Typography>
      </Box>
      {/* Локальная прокрутка сохраняет читаемую ширину текста и полей; таблица не превращает строку песни в узкий столбец. */}
      <Paper variant="outlined" role="region" aria-label={timingTexts.linesTable} tabIndex={0} sx={{ minWidth: 0, maxHeight: '70vh', overflow: 'auto' }}>
        <Table size="small" stickyHeader sx={{ minWidth: 1000 }}>
          <TableHead>
            <TableRow>
              <TableCell width={40}>{timingTexts.numberColumn}</TableCell>
              <TableCell sx={{ minWidth: 260 }}>{timingTexts.lineColumn}</TableCell>
              <TableCell sx={{ minWidth: 110 }}>{timingTexts.startColumn}</TableCell>
              <TableCell sx={{ minWidth: 110 }}>{timingTexts.endColumn}</TableCell>
              <TableCell sx={{ minWidth: 70 }}>{timingTexts.durationColumn}</TableCell>
              <TableCell sx={{ minWidth: 60 }} align="center">
                {timingTexts.verifiedColumn}
              </TableCell>
              <TableCell sx={{ minWidth: 160 }}>{timingTexts.noteColumn}</TableCell>
              <TableCell sx={{ minWidth: 116 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((line) => (
              <TimingLineRow
                key={line.id}
                line={line}
                playing={playingLineId === line.id}
                looping={loopingLineId === line.id}
                onLoop={onLoop}
                manualMode={manualMode}
                boundaryDrafts={boundaryDrafts?.[line.id]}
                onBoundaryInput={onBoundaryInput}
                selected={line.id === selected}
                text={textOf(line)}
                {...neighbours(line.id, lines, duration)}
                onSelect={onSelect}
                onUpdate={onUpdate}
                onPlay={onPlay}
                onRemove={onRemove}
              />
            ))}
            {!visible.length ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <Typography color="text.secondary" sx={{ py: 2 }}>
                    {lines.length ? timingTexts.filteredEmpty : timingTexts.empty}
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}
