import type { ReactElement } from 'react';
import { Alert, Box, Stack, TextField } from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import UndoIcon from '@mui/icons-material/Undo';
import StartIcon from '@mui/icons-material/Start';
import LastPageIcon from '@mui/icons-material/LastPage';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import type { TimingLine } from '@shared/types';
import { timingEditorTexts as texts } from '@shared/texts/timing-editor';
import { timingTexts } from '@shared/texts/timing';
import { ActionButton } from '../../../components/ActionButton';
import { DestructiveButton } from '../../../components/DestructiveButton';
import type { TimingBoundaryDrafts } from '../manualTiming';
import { canVerifyEditorLine, type TimingCandidate } from '../timingEditor';

export interface TimingWorkingLineProps {
  line: TimingLine;
  candidate?: TimingCandidate;
  drafts?: TimingBoundaryDrafts[number];
  duration: number;
  time: number;
  hasTrack: boolean;
  playing: boolean;
  looping: boolean;
  onInput(id: number, field: 'start' | 'end', text: string): void;
  onUpdate(id: number, patch: Partial<TimingLine>): void;
  onPlay(line: TimingLine): void;
  onLoop(line: TimingLine): void;
  onNavigate(direction: -1 | 1): void;
  onRemove(id: number): void;
  previousDisabled: boolean;
  nextDisabled: boolean;
}

/** Раскрывается только у рабочей строки; сырые значения принадлежат странице и переживают сворачивание. */
export function TimingWorkingLine({
  line,
  candidate,
  drafts,
  time,
  hasTrack,
  onInput,
  onUpdate,
  onNavigate,
  onRemove,
  previousDisabled,
  nextDisabled
}: TimingWorkingLineProps): ReactElement {
  const raw = (field: 'start' | 'end'): string => drafts?.[field] ?? (Number.isFinite(line[field]) ? String(line[field]) : '');
  return (
    <Stack spacing={1.5} sx={{ px: 2, pb: 2, pt: 0.5 }}>
      {candidate && (
        <Alert severity="warning">
          {texts.candidateReason({ reason: candidate.reason })} {texts.candidateHint}
        </Alert>
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'flex-start' }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            label={texts.start}
            value={raw('start')}
            sx={{ width: 140 }}
            inputProps={{ 'aria-label': timingTexts.lineStart({ id: line.source_line }), inputMode: 'decimal' }}
            onChange={(event) => onInput(line.id, 'start', event.target.value)}
          />
          <ActionButton
            startIcon={<StartIcon />}
            disabled={!hasTrack}
            disabledReason={texts.trackRequired}
            onClick={() => onInput(line.id, 'start', String(Math.round(time * 100) / 100))}
          >
            {texts.startHere}
          </ActionButton>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            label={texts.end}
            value={raw('end')}
            sx={{ width: 140 }}
            inputProps={{ 'aria-label': timingTexts.lineEnd({ id: line.source_line }), inputMode: 'decimal' }}
            onChange={(event) => onInput(line.id, 'end', event.target.value)}
          />
          <ActionButton
            startIcon={<LastPageIcon />}
            disabled={!hasTrack}
            disabledReason={texts.trackRequired}
            onClick={() => onInput(line.id, 'end', String(Math.round(time * 100) / 100))}
          >
            {texts.endHere}
          </ActionButton>
        </Stack>
      </Box>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <ActionButton
          variant="contained"
          startIcon={line.verified ? <UndoIcon /> : <CheckCircleOutlineIcon />}
          disabled={!line.verified && !canVerifyEditorLine(line)}
          disabledReason={texts.rangeRequired}
          onClick={() => onUpdate(line.id, { verified: !line.verified })}
        >
          {line.verified ? texts.unverify : texts.verify}
        </ActionButton>
      </Box>
      <TextField
        label={texts.note}
        value={line.note ?? ''}
        fullWidth
        inputProps={{ 'aria-label': timingTexts.lineNote({ id: line.source_line }) }}
        onChange={(event) => onUpdate(line.id, { note: event.target.value })}
      />
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <ActionButton startIcon={<ArrowUpwardIcon />} disabled={previousDisabled} onClick={() => onNavigate(-1)}>
          {texts.previous}
        </ActionButton>
        <ActionButton startIcon={<ArrowDownwardIcon />} disabled={nextDisabled} onClick={() => onNavigate(1)}>
          {texts.next}
        </ActionButton>
        <Box sx={{ flex: 1 }} />
        <DestructiveButton
          startIcon={<DeleteOutlineIcon />}
          variant="contained"
          label={texts.clear}
          description={texts.clearDescription}
          confirmLabel={texts.clear}
          onConfirm={() => onRemove(line.id)}
        />
      </Box>
    </Stack>
  );
}
