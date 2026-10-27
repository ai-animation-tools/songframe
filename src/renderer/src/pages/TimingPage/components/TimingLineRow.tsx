import type { ReactElement } from 'react';
import { Checkbox, IconButton, TableCell, TableRow, TextField, Tooltip } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { TimingLine } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { TimingBoundaryField } from './TimingBoundaryField';
import { MIN_LENGTH } from '../timing';

interface TimingLineRowProps {
  line: TimingLine;
  selected: boolean;
  text: string;
  prevEnd: number;
  nextStart: number;
  onSelect: (line: TimingLine) => void;
  onUpdate: (id: number, patch: Partial<TimingLine>) => void;
  onPlay: (line: TimingLine) => void;
  onRemove: (id: number) => void;
}

/** Поля границ проверяют соседей; действия строки не меняют выбор побочным кликом. */
export function TimingLineRow({ line, selected, text, prevEnd, nextStart, onSelect, onUpdate, onPlay, onRemove }: TimingLineRowProps): ReactElement {
  return (
    <TableRow
      hover
      selected={selected}
      onClick={() => {
        onSelect(line);
      }}
      sx={{ cursor: 'pointer' }}
    >
      <TableCell>{line.id}</TableCell>
      <TableCell sx={{ fontWeight: selected ? 600 : 400 }}>{text}</TableCell>
      <TableCell>
        <TimingBoundaryField
          key={line.start}
          value={line.start}
          min={prevEnd}
          max={line.end - MIN_LENGTH}
          label={`Начало строки ${line.id}`}
          onCommit={(value) => onUpdate(line.id, { start: value })}
        />
      </TableCell>
      <TableCell>
        <TimingBoundaryField
          key={line.end}
          value={line.end}
          min={line.start + MIN_LENGTH}
          max={nextStart}
          label={`Конец строки ${line.id}`}
          onCommit={(value) => onUpdate(line.id, { end: value })}
        />
      </TableCell>
      <TableCell sx={{ fontFamily: 'monospace' }}>{(line.end - line.start).toFixed(2)}</TableCell>
      <TableCell align="center" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          size="small"
          color="success"
          checked={!!line.verified}
          onChange={(e) => onUpdate(line.id, { verified: e.target.checked })}
          slotProps={{ input: { 'aria-label': `Подтвердить на слух строку ${line.id}` } }}
        />
      </TableCell>
      <TableCell onClick={(e) => e.stopPropagation()}>
        <TextField
          variant="standard"
          fullWidth
          value={line.note ?? ''}
          onChange={(e) => onUpdate(line.id, { note: e.target.value })}
          inputProps={{ 'aria-label': `Примечание к строке ${line.id}`, style: { fontSize: 12 } }}
        />
      </TableCell>
      <TableCell align="right" onClick={(e) => e.stopPropagation()}>
        <Tooltip title="Прослушать строку">
          <IconButton size="small" aria-label="Воспроизвести строку" title="Воспроизвести строку" onClick={() => onPlay(line)}>
            <PlayArrowIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <DestructiveButton
          icon
          label={`Убрать строку ${line.id} из разметки`}
          description={`Будут удалены временные границы и заметка строки «${text}». Исходный текст песни сохранится.`}
          onConfirm={() => onRemove(line.id)}
          confirmLabel="Убрать"
        >
          <DeleteOutlineIcon fontSize="small" />
        </DestructiveButton>
      </TableCell>
    </TableRow>
  );
}
