import type { ReactElement } from 'react';
import { Alert, Box, FormControlLabel, Slider, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RepeatIcon from '@mui/icons-material/Repeat';
import CloseIcon from '@mui/icons-material/Close';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import JoinInnerIcon from '@mui/icons-material/JoinInner';
import HeadphonesIcon from '@mui/icons-material/Headphones';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import { timingSelectionTexts as texts } from '@shared/texts/timing-selection';
import { ActionButton } from '../../../components/ActionButton';
import { ActionIconButton } from '../../../components/ActionIconButton';
import { VolumeSlider } from '../../../components/VolumeSlider';
import { formatClock } from '../../../format';
import type { TimingPlayerController } from '../useTimingPlayer';

/** Отмена и повтор принадлежат странице: история охватывает и правки в списке строк. */
export interface TimingHistoryControls {
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
}

interface TimingSelectionControlsProps {
  player: TimingPlayerController;
  history?: TimingHistoryControls;
}

/** Одна панель под волной управляет текущим выделением; масштаб меняет только видимую область. */
export function TimingSelectionControls({ player, history }: TimingSelectionControlsProps): ReactElement {
  const {
    trackUrl,
    playing,
    time,
    duration,
    volume,
    pps,
    setVolume,
    setPps,
    selectionIds,
    selectionBounds,
    pair,
    selectionKind,
    selectionError,
    selectionPlaying,
    selectionLooping,
    selectionPreview,
    setSelectionPreview,
    toggleSelectionPlayback,
    toggleSelectionLoop,
    playJoin,
    joinPadding,
    setJoinPadding,
    joinAtPlayhead,
    zoomAll,
    zoomSelection,
    clearSelection,
    follow,
    setFollow,
    snap,
    setSnap,
    interactionDisabled
  } = player;
  const selected = selectionKind !== 'none';
  const playLabel = playing ? texts.pause : selected ? (selectionPreview === 'join' ? texts.playJoin : texts.playSelection) : texts.play;
  const blockedReason = !trackUrl ? texts.trackRequired : interactionDisabled ? texts.operationPending : null;
  const boundsReason = blockedReason ?? (!selectionBounds ? (selected ? texts.validBoundsRequired : texts.selectionRequired) : null);
  const label = pair
    ? texts.pair({ first: pair.first.id, second: pair.second.id })
    : selectionKind === 'pair'
      ? texts.pair({ first: selectionIds[0], second: selectionIds[1] })
      : selectionKind === 'line'
        ? texts.line({ id: selectionIds[0] })
        : selectionKind === 'range'
          ? texts.range
          : texts.noSelection;

  return (
    <Stack role="group" aria-label={texts.controls} data-timing-shortcuts spacing={0.75} sx={{ mt: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.5 }}>
        <ActionIconButton
          size="small"
          color="primary"
          aria-label={playLabel}
          title={playLabel}
          disabled={!!blockedReason || (selected && !selectionBounds && !playing)}
          disabledReason={blockedReason ?? texts.validBoundsRequired}
          onClick={toggleSelectionPlayback}
          sx={{ border: 1, borderColor: 'divider' }}
        >
          {playing ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
        </ActionIconButton>
        <Typography variant="body2" sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
          {texts.clock({ time: formatClock(time), duration: formatClock(duration) })}
        </Typography>
        <VolumeSlider volume={volume} onChange={setVolume} />
        <Box sx={{ flex: 1 }} />
        {history && (
          <Stack direction="row" spacing={0.5}>
            <ActionIconButton
              size="small"
              aria-label={texts.undo}
              title={texts.undoHint}
              disabled={interactionDisabled || !history.canUndo}
              disabledReason={interactionDisabled ? texts.operationPending : texts.nothingToUndo}
              onClick={history.onUndo}
            >
              <UndoIcon fontSize="small" />
            </ActionIconButton>
            <ActionIconButton
              size="small"
              aria-label={texts.redo}
              title={texts.redoHint}
              disabled={interactionDisabled || !history.canRedo}
              disabledReason={interactionDisabled ? texts.operationPending : texts.nothingToRedo}
              onClick={history.onRedo}
            >
              <RedoIcon fontSize="small" />
            </ActionIconButton>
          </Stack>
        )}
        <Slider
          aria-label={texts.timelineScale}
          size="small"
          min={Math.min(8, pps)}
          max={400}
          value={pps}
          onChange={(_event, value) => setPps(value as number)}
          sx={{ width: 88 }}
        />
        <Stack direction="row" spacing={0.5}>
          <ActionButton size="small" startIcon={<FitScreenIcon />} title={texts.zoomAllHint} onClick={zoomAll} disabled={!duration}>
            {texts.wholeTrack}
          </ActionButton>
          <ActionButton
            size="small"
            startIcon={<ZoomInIcon />}
            title={texts.zoomSelectionHint}
            onClick={zoomSelection}
            disabled={!selectionBounds}
            disabledReason={texts.selectionRequired}
          >
            {texts.zoomSelection}
          </ActionButton>
        </Stack>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {label}
        </Typography>
        {selectionBounds && (
          <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {texts.bounds({
              start: selectionBounds.start.toFixed(2),
              end: selectionBounds.end.toFixed(2),
              duration: (selectionBounds.end - selectionBounds.start).toFixed(2)
            })}
          </Typography>
        )}
        {selected && (
          <ActionIconButton
            size="small"
            aria-label={texts.clearSelection}
            title={texts.clearSelection}
            disabled={interactionDisabled}
            disabledReason={texts.operationPending}
            onClick={clearSelection}
          >
            <CloseIcon fontSize="small" />
          </ActionIconButton>
        )}
        <Box sx={{ flex: 1 }} />
        <Stack direction="row" spacing={2} sx={{ mr: 1 }}>
          <Tooltip title={texts.followHint} describeChild>
            <FormControlLabel
              control={<Switch size="small" checked={follow} onChange={(_event, checked) => setFollow(checked)} />}
              label={<Typography variant="body2">{texts.follow}</Typography>}
              sx={{ mr: 0 }}
            />
          </Tooltip>
          <Tooltip title={texts.snapHint} describeChild>
            <FormControlLabel
              control={<Switch size="small" checked={snap} onChange={(_event, checked) => setSnap(checked)} />}
              label={<Typography variant="body2">{texts.snap}</Typography>}
              sx={{ mr: 0 }}
            />
          </Tooltip>
        </Stack>
        <ActionButton
          size="small"
          startIcon={<RepeatIcon />}
          aria-label={selectionLooping ? texts.stopLoop : texts.loopSelection}
          aria-pressed={selectionLooping}
          color={selectionLooping ? 'primary' : 'inherit'}
          variant={selectionLooping ? 'outlined' : 'text'}
          disabled={interactionDisabled || (!!boundsReason && !selectionLooping)}
          disabledReason={boundsReason}
          onClick={toggleSelectionLoop}
        >
          {texts.loop}
        </ActionButton>
      </Box>
      {pair && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" color={pair.join === null ? 'warning.main' : 'text.secondary'}>
            {pair.join !== null
              ? texts.joinReady({ time: pair.join.toFixed(2) })
              : pair.gap > 0
                ? texts.gap({ seconds: pair.gap.toFixed(2) })
                : texts.overlap({ seconds: Math.abs(pair.gap).toFixed(2) })}
          </Typography>
          {pair.join !== null && (
            <>
              {selectionPreview === 'join' && (
                <ActionButton
                  size="small"
                  startIcon={<SelectAllIcon />}
                  title={texts.wholeSelectionHint}
                  disabled={interactionDisabled}
                  disabledReason={texts.operationPending}
                  onClick={() => setSelectionPreview('selection')}
                >
                  {texts.wholeSelection}
                </ActionButton>
              )}
              <ActionButton size="small" startIcon={<HeadphonesIcon />} disabled={!!boundsReason} disabledReason={boundsReason} onClick={playJoin}>
                {texts.listenJoin}
              </ActionButton>
              <TextField
                size="small"
                label={texts.joinPadding}
                type="number"
                value={joinPadding}
                disabled={interactionDisabled}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value > 0) setJoinPadding(value);
                }}
                inputProps={{ min: 0.1, max: 10, step: 0.1 }}
                sx={{ width: 142 }}
              />
            </>
          )}
          {pair.join === null && (
            <ActionButton
              size="small"
              startIcon={<JoinInnerIcon />}
              title={texts.joinAtPlayheadHint}
              onClick={joinAtPlayhead}
              disabled={!!blockedReason || pair.locked}
              disabledReason={blockedReason ?? texts.unlockPair}
            >
              {texts.joinAtPlayhead}
            </ActionButton>
          )}
          {selectionPlaying && selectionPreview === 'join' && (
            <Typography variant="caption" color="primary.main">
              {texts.joinPreview}
            </Typography>
          )}
        </Box>
      )}
      {pair?.locked && (
        <Alert severity="info" sx={{ py: 0, '& .MuiAlert-message': { py: 0.5 }, '& .MuiAlert-icon': { py: 0.5 } }}>
          {texts.lockedPair}
        </Alert>
      )}
      {selectionError && <Alert severity="warning">{selectionError}</Alert>}
    </Stack>
  );
}
