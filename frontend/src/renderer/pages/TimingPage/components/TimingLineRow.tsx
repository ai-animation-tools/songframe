import { timingTexts } from '@shared/texts/timing';
import { commonTexts } from '@shared/texts/common';
import type { ReactElement } from 'react';
import { Box, Checkbox, TableCell, TableRow, TextField, Tooltip } from '@mui/material';
import StopIcon from '@mui/icons-material/Stop';
import RepeatIcon from '@mui/icons-material/Repeat';
import { lighten } from '@mui/material/styles';
import { visuallyHidden } from '@mui/utils';
import { ActionButton } from '../../../components/ActionButton';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { TimingLine } from '@shared/types';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { TimingBoundaryField } from './TimingBoundaryField';
import { MIN_LENGTH } from '../timing';
import type { TimingBoundaryDrafts } from '../manualTiming';

interface TimingLineRowProps {
  line: TimingLine;
  selected: boolean;
  playing?: boolean;
  looping?: boolean;
  onLoop?: (line: TimingLine) => void;
  manualMode?: boolean;
  boundaryDrafts?: TimingBoundaryDrafts[number];
  onBoundaryInput?: (id: number, field: 'start' | 'end', value: string) => void;
  text: string;
  prevEnd: number;
  nextStart: number;
  onSelect: (line: TimingLine) => void;
  onUpdate: (id: number, patch: Partial<TimingLine>) => void;
  onPlay: (line: TimingLine) => void;
  onRemove: (id: number) => void;
}

/** Обычные границы проверяют соседей, ручной ввод остаётся черновиком строки до сохранения. */
export function TimingLineRow({
  line,
  selected,
  playing = false,
  looping = false,
  onLoop,
  manualMode = false,
  boundaryDrafts,
  onBoundaryInput,
  text,
  prevEnd,
  nextStart,
  onSelect,
  onUpdate,
  onPlay,
  onRemove
}: TimingLineRowProps): ReactElement {
  const labelSx = { display: 'none', '@container workspace (min-width: 1000px)': { display: 'inline' } };
  const buttonSx = { minWidth: 32, px: 0.75, whiteSpace: 'nowrap', '& .MuiButton-startIcon': { m: 0 }, gap: 0.5 };
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
          key={manualMode || onBoundaryInput || boundaryDrafts?.start !== undefined ? 'draft' : line.start}
          manualMode={manualMode}
          draft={boundaryDrafts?.start}
          onDraftChange={onBoundaryInput ? (value) => onBoundaryInput(line.id, 'start', value) : undefined}
          value={line.start}
          min={prevEnd}
          max={line.end - MIN_LENGTH}
          label={timingTexts.lineStart({ id: line.id })}
          onCommit={(value) => onUpdate(line.id, { start: value })}
        />
      </TableCell>
      <TableCell>
        <TimingBoundaryField
          key={manualMode || onBoundaryInput || boundaryDrafts?.end !== undefined ? 'draft' : line.end}
          manualMode={manualMode}
          draft={boundaryDrafts?.end}
          onDraftChange={onBoundaryInput ? (value) => onBoundaryInput(line.id, 'end', value) : undefined}
          value={line.end}
          min={line.start + MIN_LENGTH}
          max={nextStart}
          label={timingTexts.lineEnd({ id: line.id })}
          onCommit={(value) => onUpdate(line.id, { end: value })}
        />
      </TableCell>
      <TableCell sx={{ fontFamily: 'monospace' }}>{Number.isFinite(line.end - line.start) ? (line.end - line.start).toFixed(2) : '—'}</TableCell>
      <TableCell align="center" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          size="small"
          color="success"
          checked={!!line.verified}
          onChange={(e) => onUpdate(line.id, { verified: e.target.checked })}
          slotProps={{ input: { 'aria-label': timingTexts.verifyLine({ id: line.id }) } }}
        />
      </TableCell>
      <TableCell onClick={(e) => e.stopPropagation()}>
        <TextField
          variant="standard"
          fullWidth
          value={line.note ?? ''}
          onChange={(e) => onUpdate(line.id, { note: e.target.value })}
          inputProps={{ 'aria-label': timingTexts.lineNote({ id: line.id }), style: { fontSize: 12 } }}
        />
      </TableCell>
      <TableCell align="right" onClick={(e) => e.stopPropagation()}>
        <Box
          role="group"
          aria-label={timingTexts.lineActions({ id: line.id })}
          sx={{ display: 'flex', flexWrap: 'nowrap', alignItems: 'center', justifyContent: 'flex-end', gap: 0.5 }}
        >
          <Tooltip title={playing ? timingTexts.stopLine({ id: line.id }) : timingTexts.listenLine}>
            <ActionButton
              size="small"
              sx={buttonSx}
              aria-label={playing ? timingTexts.stopLine({ id: line.id }) : timingTexts.playLine}
              startIcon={playing ? <StopIcon /> : <PlayArrowIcon />}
              onClick={() => onPlay(line)}
            >
              <Box component="span" sx={labelSx}>
                {playing ? timingTexts.rowStop : timingTexts.rowPlay}
              </Box>
            </ActionButton>
          </Tooltip>
          {onLoop && (
            <ActionButton
              size="small"
              sx={buttonSx}
              aria-pressed={looping}
              aria-label={looping ? timingTexts.stopLoop({ id: line.id }) : timingTexts.loopLine({ id: line.id })}
              startIcon={looping ? <StopIcon /> : <RepeatIcon />}
              onClick={() => onLoop(line)}
            >
              <Box component="span" sx={labelSx}>
                {looping ? timingTexts.rowStop : timingTexts.rowLoop}
              </Box>
            </ActionButton>
          )}
          <DestructiveButton
            label={timingTexts.removeLine({ id: line.id })}
            description={timingTexts.removeLineDescription({ text })}
            onConfirm={() => onRemove(line.id)}
            confirmLabel={commonTexts.remove}
            startIcon={<DeleteOutlineIcon />}
            // Текст удаления должен сохранять контраст и на голубом фоне выбранной строки.
            sx={[buttonSx, (theme) => ({ color: theme.palette.mode === 'light' ? theme.palette.error.dark : lighten(theme.palette.error.light, 0.2) })]}
          >
            <Box component="span" sx={visuallyHidden}>
              {timingTexts.removeLine({ id: line.id })}
            </Box>
            <Box component="span" aria-hidden sx={labelSx}>
              {timingTexts.rowRemove}
            </Box>
          </DestructiveButton>
        </Box>
      </TableCell>
    </TableRow>
  );
}
