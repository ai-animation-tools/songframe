import { timingTexts } from '@shared/texts/timing';
import type { ReactElement } from 'react';
import { Alert, Box, Button, Paper, Slider, Stack, Typography } from '@mui/material';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import type { TimingLine } from '@shared/types';
import { formatClock } from '../../../format';
import type { TimingPlayerController } from '../useTimingPlayer';
import { CANVAS_H } from '../waveform';

interface TimingPlayerProps {
  player: TimingPlayerController;
  lines: TimingLine[];
  stickyTop: number;
}

/** Прослушивание и волновая форма связаны со строками разметки. */
export function TimingPlayer({ player, lines, stickyTop }: TimingPlayerProps): ReactElement {
  const {
    trackUrl,
    audioRef,
    canvasRef,
    scrollRef,
    playing,
    time,
    duration,
    volume,
    pps,
    peaks,
    peaksError,
    setPlaying,
    setVolume,
    setPps,
    setScrollLeft,
    togglePlay,
    timeAt,
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
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1.5, mb: 1 }}>
        <Button onClick={togglePlay} color="primary" startIcon={playing ? <PauseIcon /> : <PlayArrowIcon />}>
          {playing ? timingTexts.pause : timingTexts.play}
        </Button>
        <Typography sx={{ fontFamily: 'monospace', minWidth: 72 }}>{formatClock(time)}</Typography>
        <Typography variant="caption" color="text.secondary">
          {timingTexts.totalDuration({ duration: formatClock(duration) })}
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <VolumeUpIcon fontSize="small" color="action" />
          <Typography variant="caption" color="text.secondary">
            {timingTexts.volume}
          </Typography>
          <Slider
            aria-label={timingTexts.volume}
            size="small"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(_event, value) => setVolume((value as number) / 100)}
            valueLabelDisplay="auto"
            valueLabelFormat={(value) => timingTexts.volumePercent({ value })}
            getAriaValueText={(value) => timingTexts.volumePercent({ value })}
            sx={{ width: 110 }}
          />
          <Typography variant="caption" sx={{ minWidth: 32 }}>
            {timingTexts.volumePercent({ value: Math.round(volume * 100) })}
          </Typography>
        </Stack>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {timingTexts.scale}
        </Typography>
        <Slider
          aria-label={timingTexts.timelineScale}
          size="small"
          min={8}
          max={400}
          value={pps}
          onChange={(_e, v) => setPps(v as number)}
          sx={{ width: 160 }}
        />
      </Box>
      <Box
        ref={scrollRef}
        onScroll={(e) => setScrollLeft((e.target as HTMLDivElement).scrollLeft)}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
        onDoubleClick={(e) => {
          const t = timeAt(e.clientX);
          const line = lines.find((l) => t >= l.start && t <= l.end);
          if (line) playLine(line);
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
        <canvas ref={canvasRef} style={{ position: 'sticky', left: 0, top: 0, display: 'block', height: CANVAS_H, width: '100%', marginTop: -1 }} />
      </Box>
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
