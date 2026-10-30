import { timingTexts } from '@shared/texts/timing';
import type { ReactElement } from 'react';
import { Paper, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { TimingLine } from '@shared/types';
import { neighbours } from '../timing';
import { TimingLineRow } from './TimingLineRow';

interface TimingLinesTableProps {
  lines: TimingLine[];
  selected: number | null;
  duration: number;
  textOf: (line: TimingLine) => string;
  onSelect: (line: TimingLine) => void;
  onUpdate: (id: number, patch: Partial<TimingLine>) => void;
  onPlay: (line: TimingLine) => void;
  onRemove: (id: number) => void;
}

/** Таблица показывает строки по времени и передаёт каждой ограничения соседей. */
export function TimingLinesTable({ lines, selected, duration, textOf, onSelect, onUpdate, onPlay, onRemove }: TimingLinesTableProps): ReactElement {
  const sorted = [...lines].sort((a, b) => a.start - b.start);
  return (
    // Локальная прокрутка сохраняет читаемую ширину текста и полей; таблица не превращает строку песни в узкий столбец.
    <Paper variant="outlined" role="region" aria-label={timingTexts.linesTable} tabIndex={0} sx={{ minWidth: 0, maxHeight: '70vh', overflow: 'auto' }}>
      <Table size="small" stickyHeader sx={{ minWidth: 1000 }}>
        <TableHead>
          <TableRow>
            <TableCell width={40}>{timingTexts.numberColumn}</TableCell>
            <TableCell sx={{ minWidth: 260 }}>{timingTexts.lineColumn}</TableCell>
            <TableCell width={110}>{timingTexts.startColumn}</TableCell>
            <TableCell width={110}>{timingTexts.endColumn}</TableCell>
            <TableCell width={70}>{timingTexts.durationColumn}</TableCell>
            <TableCell width={60} align="center">
              {timingTexts.verifiedColumn}
            </TableCell>
            <TableCell sx={{ minWidth: 160 }}>{timingTexts.noteColumn}</TableCell>
            <TableCell width={90} />
          </TableRow>
        </TableHead>
        <TableBody>
          {sorted.map((line) => (
            <TimingLineRow
              key={line.id}
              line={line}
              selected={line.id === selected}
              text={textOf(line)}
              {...neighbours(line.id, lines, duration)}
              onSelect={onSelect}
              onUpdate={onUpdate}
              onPlay={onPlay}
              onRemove={onRemove}
            />
          ))}
          {!sorted.length ? (
            <TableRow>
              <TableCell colSpan={8}>
                <Typography color="text.secondary" sx={{ py: 2 }}>
                  {timingTexts.empty}
                </Typography>
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </Paper>
  );
}
