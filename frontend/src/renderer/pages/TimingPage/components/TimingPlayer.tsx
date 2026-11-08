import { timingTexts } from '@shared/texts/timing';
import type { ReactElement } from 'react';
import { Alert, Box, Paper, Typography } from '@mui/material';
import type { TimingLine } from '@shared/types';
import { TimingSelectionControls } from './TimingSelectionControls';
import type { TimingPlayerController } from '../useTimingPlayer';

interface TimingPlayerProps {
  player: TimingPlayerController;
  lines: TimingLine[];
  stickyTop: number;
}

/** Прослушивание и волновая форма связаны со строками разметки. */
export function TimingPlayer({ player, stickyTop }: TimingPlayerProps): ReactElement {
  const {
    trackUrl,
    audioRef,
    canvasRef,
    scrollRef,
    duration,
    pps,
    peaks,
    peaksError,
    playbackError,
    setPlaying,
    setScrollLeft,
    hitLine,
    canvasHeight,
    playLine,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onWheel
  } = player;
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.5,
        bgcolor: 'background.paper',
        position: 'sticky',
        top: stickyTop,
        zIndex: (theme) => theme.zIndex.appBar - 2
      }}
    >
      <audio key={trackUrl} ref={audioRef} src={trackUrl ?? undefined} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
      <Box
        ref={scrollRef}
        onScroll={(e) => setScrollLeft((e.target as HTMLDivElement).scrollLeft)}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
        onDoubleClick={(e) => {
          const hit = hitLine(e.clientX, e.clientY);
          if (hit) playLine(hit.line);
        }}
        sx={{
          position: 'relative',
          overflowX: 'auto',
          overflowY: 'hidden',
          // Контейнер сам учитывает высоту системного скроллбара вместо фиксированного запаса.
          // Нижний зазор оставляет подписи видимыми и при наложенном скроллбаре.
          pb: '16px',
          userSelect: 'none',
          borderRadius: 1,
          border: 1,
          borderColor: 'divider'
        }}
      >
        <Box sx={{ width: `${Math.max(1, duration * pps)}px`, height: '1px' }} />
        <canvas ref={canvasRef} style={{ position: 'sticky', left: 0, top: 0, display: 'block', height: canvasHeight, width: '100%', marginTop: -1 }} />
      </Box>
      <TimingSelectionControls player={player} />
      {player.lockedLineId !== null && !player.pair && (
        <Alert severity="info" sx={{ mt: 1 }}>
          {timingTexts.lockedLine({ id: player.lockedLineId })}
        </Alert>
      )}
      {playbackError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {playbackError}
        </Alert>
      )}
      {peaksError ? (
        <Alert severity="error" sx={{ mt: 1 }}>
          {peaksError}
        </Alert>
      ) : !peaks ? (
        <Typography variant="caption" color="text.secondary">
          {timingTexts.loadingWaveform}
        </Typography>
      ) : null}
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
        {timingTexts.waveformHelp}
      </Typography>
    </Paper>
  );
}
