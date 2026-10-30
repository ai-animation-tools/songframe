import { montageTexts } from '@shared/texts/montage';
import { useEffect, useRef, useState, type DragEvent, type PointerEvent, type ReactElement } from 'react';
import { Alert, Box, Checkbox, FormControlLabel, Slider, Stack, Typography, useTheme } from '@mui/material';
import { FPS } from '@shared/video';
import type { MontageClip, MontageDraft, MontageLyricLine } from '@shared/montage';
import { decodePeaks, type Peaks } from '../../TimingPage/waveform';
import { clipLength, frameLabel, montageLength, rollCut, slipClip, trimClip } from '../model';
import { snapCutDelta } from '../snapCut';
import { LinkedText } from '../../../components/LinkedText';

interface Props {
  draft: MontageDraft;
  duration: number;
  trackUrl: string | null;
  lyricLines: MontageLyricLine[];
  lyricProblem: string | null;
  frame: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onSeek: (frame: number) => void;
  onChange: (draft: MontageDraft) => void;
  onDropSource: (id: string, before: string | null) => void;
  onMove: (id: string, before: string | null) => void;
}
type Gesture = {
  mode: 'range' | 'audio-start' | 'audio-end' | 'start' | 'end' | 'roll' | 'slip';
  x: number;
  id?: string;
  base: MontageDraft;
  next: MontageDraft;
};

/** Обе дорожки разделяют масштаб, прокрутку и абсолютную ось песни. Один жест создаёт одну запись undo. */
export function MontageTimeline({
  draft,
  duration,
  trackUrl,
  lyricLines,
  lyricProblem,
  frame,
  selected,
  onSelect,
  onSeek,
  onChange,
  onDropSource,
  onMove
}: Props): ReactElement {
  const theme = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pps, setPps] = useState(60);
  const [snapToLyrics, setSnapToLyrics] = useState(true);
  const [scroll, setScroll] = useState(0);
  const [width, setWidth] = useState(800);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [waveError, setWaveError] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const active = gesture?.next ?? draft;
  const maxFrames = Math.max(
    Math.ceil((peaks?.duration ?? duration) * FPS),
    active.audio.end_frame_exclusive,
    active.audio.start_frame + montageLength(active.clips),
    1
  );
  const timelineWidth = Math.max(width, (maxFrames / FPS) * pps + 40);
  const xFor = (value: number): number => (value / FPS) * pps;
  const absoluteFrame = (clientX: number): number =>
    Math.max(0, Math.min(maxFrames, Math.round(((clientX - scrollRef.current!.getBoundingClientRect().left + scrollRef.current!.scrollLeft) / pps) * FPS)));

  useEffect(() => {
    setPeaks(null);
    setWaveError(null);
    if (!trackUrl) return;
    let cancelled = false;
    void decodePeaks(trackUrl)
      .then((value) => {
        if (!cancelled) setPeaks(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) setWaveError(montageTexts.waveFailed(String(error)));
      });
    return () => {
      cancelled = true;
    };
  }, [trackUrl]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.ceil(width * dpr);
    canvas.height = 140 * dpr;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(dpr, dpr);
    context.fillStyle = theme.palette.background.default;
    context.fillRect(0, 0, width, 140);
    context.strokeStyle = theme.palette.divider;
    context.beginPath();
    context.moveTo(0, 75);
    context.lineTo(width, 75);
    context.stroke();
    context.fillStyle = theme.palette.info.main;
    if (peaks)
      for (let x = 0; x < width; x += 1) {
        const from = Math.floor(((scroll + x) / pps) * 100);
        const to = Math.min(peaks.min.length, Math.max(from + 1, Math.ceil(((scroll + x + 1) / pps) * 100)));
        let low = 0;
        let high = 0;
        for (let bin = from; bin < to; bin += 1) {
          low = Math.min(low, peaks.min[bin]);
          high = Math.max(high, peaks.max[bin]);
        }
        context.fillRect(x, 75 - high * 45, 1, Math.max(1, (high - low) * 45));
      }
    const start = (active.audio.start_frame / FPS) * pps - scroll;
    const end = (active.audio.end_frame_exclusive / FPS) * pps - scroll;
    context.fillStyle = 'rgba(76,175,80,0.22)';
    context.fillRect(start, 22, end - start, 100);
    context.fillStyle = theme.palette.success.main;
    context.fillRect(start, 22, 3, 100);
    context.fillRect(end - 3, 22, 3, 100);
    const secondsStep = pps >= 100 ? 1 : pps >= 30 ? 5 : 10;
    context.fillStyle = theme.palette.text.secondary;
    context.font = '11px sans-serif';
    for (let second = Math.ceil(scroll / pps / secondsStep) * secondsStep; second * pps < scroll + width; second += secondsStep) {
      const x = second * pps - scroll;
      context.fillText(frameLabel(second * FPS), x + 3, 14);
      context.fillRect(x, 17, 1, 5);
    }
    // Курсор расположен отдельным слоем: движение плеера не пересоздаёт canvas и звуковую волну.
  }, [active.audio, peaks, pps, scroll, theme, width]);

  const begin = (event: PointerEvent, mode: Gesture['mode'], id?: string): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    contentRef.current?.setPointerCapture(event.pointerId);
    setGesture({ mode, x: absoluteFrame(event.clientX), id, base: draft, next: draft });
    if (id) onSelect(id);
  };
  const update = (event: PointerEvent): void => {
    if (!gesture) return;
    const value = absoluteFrame(event.clientX);
    const delta = value - gesture.x;
    const base = gesture.base;
    let next = base;
    if (gesture.mode === 'range')
      next = { ...base, audio: { ...base.audio, start_frame: Math.min(gesture.x, value), end_frame_exclusive: Math.max(gesture.x + 1, value) } };
    else if (gesture.mode === 'audio-start') next = { ...base, audio: { ...base.audio, start_frame: Math.min(base.audio.end_frame_exclusive - 1, value) } };
    else if (gesture.mode === 'audio-end') next = { ...base, audio: { ...base.audio, end_frame_exclusive: Math.max(base.audio.start_frame + 1, value) } };
    else if (gesture.id)
      next = {
        ...base,
        clips:
          gesture.mode === 'roll'
            ? rollCut(
                base.clips,
                gesture.id,
                snapToLyrics
                  ? snapCutDelta(
                      base,
                      gesture.id,
                      delta,
                      lyricLines.map((line) => line.startFrame),
                      pps
                    )
                  : delta
              )
            : gesture.mode === 'slip'
              ? slipClip(base.clips, gesture.id, delta)
              : trimClip(base.clips, gesture.id, gesture.mode, delta)
      };
    setGesture({ ...gesture, next });
  };
  const finish = (event: PointerEvent): void => {
    if (!gesture) return;
    if (gesture.mode === 'range' && Math.abs(absoluteFrame(event.clientX) - gesture.x) < 2) onSeek(Math.max(0, gesture.x - draft.audio.start_frame));
    else onChange(gesture.next);
    setGesture(null);
    if (contentRef.current?.hasPointerCapture(event.pointerId)) contentRef.current.releasePointerCapture(event.pointerId);
  };
  const drop = (event: DragEvent): void => {
    event.preventDefault();
    const at = absoluteFrame(event.clientX) - draft.audio.start_frame;
    let offset = 0;
    const before =
      draft.clips.find((clip) => {
        const midpoint = offset + clipLength(clip) / 2;
        offset += clipLength(clip);
        return at < midpoint;
      })?.id ?? null;
    const source = event.dataTransfer.getData('application/x-songframe-montage-source');
    const moving = event.dataTransfer.getData('application/x-songframe-montage-clip');
    if (source) onDropSource(source, before);
    else if (moving) onMove(moving, before);
  };
  let cursor = active.audio.start_frame;
  const clipBlocks = active.clips.map((clip: MontageClip, index) => {
    const left = xFor(cursor);
    cursor += clipLength(clip);
    return (
      <Box
        key={clip.id}
        draggable={!gesture}
        onDragStart={(event) => {
          event.dataTransfer.setData('application/x-songframe-montage-clip', clip.id);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(clip.id);
        }}
        onPointerDown={(event) => {
          if (event.altKey) begin(event, 'slip', clip.id);
        }}
        sx={{
          position: 'absolute',
          left,
          width: xFor(clipLength(clip)),
          minWidth: 2,
          top: 0,
          height: 74,
          bgcolor: selected === clip.id ? 'primary.main' : 'primary.dark',
          color: '#fff',
          border: '1px solid',
          borderColor: 'background.paper',
          borderRadius: 1,
          cursor: 'grab',
          userSelect: 'none',
          overflow: 'visible'
        }}
      >
        <Box
          title={montageTexts.trimStart}
          onPointerDown={(event) => begin(event, 'start', clip.id)}
          sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 8, bgcolor: 'rgba(255,255,255,.25)', cursor: 'ew-resize', zIndex: 2 }}
        />
        <Box sx={{ p: 1, overflow: 'hidden', height: '100%', pointerEvents: 'none' }}>
          <Typography noWrap variant="body2">
            {clip.scene}
          </Typography>
          <Typography noWrap variant="caption">
            {clip.kind === 'card' ? montageTexts.cardClipLength(clipLength(clip)) : montageTexts.videoClipLength(clipLength(clip))}
          </Typography>
        </Box>
        <Box
          title={montageTexts.trimEnd}
          onPointerDown={(event) => begin(event, 'end', clip.id)}
          sx={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 8, bgcolor: 'rgba(255,255,255,.25)', cursor: 'ew-resize', zIndex: 2 }}
        />
        {index < active.clips.length - 1 ? (
          <Box
            title={montageTexts.rollCut}
            onPointerDown={(event) => begin(event, 'roll', clip.id)}
            sx={{
              position: 'absolute',
              right: -8,
              bottom: -22,
              width: 16,
              height: 22,
              textAlign: 'center',
              bgcolor: 'warning.main',
              color: 'warning.contrastText',
              cursor: 'ew-resize',
              zIndex: 3
            }}
          >
            ↔
          </Box>
        ) : null}
      </Box>
    );
  });

  return (
    // Ручки и курсор шкалы остаются в её слое и не рисуются поверх закреплённого плеера при прокрутке.
    <Stack spacing={1} sx={{ isolation: 'isolate' }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2">{montageTexts.timelineTitle}</Typography>
        <Typography variant="caption">{montageTexts.scale}</Typography>
        <Slider
          aria-label={montageTexts.scaleAccessible}
          value={pps}
          min={10}
          max={300}
          onChange={(_event, value) => setPps(value as number)}
          sx={{ maxWidth: 230 }}
        />
        <Typography variant="caption">{montageTexts.scaleValue(pps)}</Typography>
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={snapToLyrics && lyricLines.length > 0}
              disabled={!lyricLines.length}
              onChange={(_event, checked) => setSnapToLyrics(checked)}
            />
          }
          label={montageTexts.snapLyrics}
        />
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {montageTexts.timelineHint}
      </Typography>
      {waveError ? <Alert severity="warning">{montageTexts.waveWarning(waveError)}</Alert> : null}
      {lyricProblem ? (
        <Alert severity="info">
          <LinkedText text={lyricProblem} />
        </Alert>
      ) : null}
      <Box
        ref={scrollRef}
        onScroll={(event) => setScroll(event.currentTarget.scrollLeft)}
        sx={{ overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}
      >
        <Box
          ref={contentRef}
          onPointerMove={update}
          onPointerUp={finish}
          onPointerCancel={() => setGesture(null)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={drop}
          sx={{ width: timelineWidth, minHeight: 260, position: 'relative', touchAction: 'none' }}
        >
          <canvas
            ref={canvasRef}
            style={{ display: 'block', position: 'sticky', left: 0, width, height: 140, cursor: 'crosshair' }}
            onPointerDown={(event) => {
              const at = absoluteFrame(event.clientX);
              const tolerance = (8 / pps) * FPS;
              begin(
                event,
                Math.abs(at - draft.audio.start_frame) < tolerance
                  ? 'audio-start'
                  : Math.abs(at - draft.audio.end_frame_exclusive) < tolerance
                    ? 'audio-end'
                    : 'range'
              );
            }}
          />
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              left: xFor(active.audio.start_frame + frame),
              top: 0,
              height: 140,
              borderLeft: 2,
              borderColor: 'error.main',
              pointerEvents: 'none'
            }}
          />
          {/* Строки размещены на общей оси песни; длинный текст доступен в подсказке. */}
          <Box aria-label={montageTexts.lyricLines} sx={{ position: 'relative', height: 32, width: timelineWidth, bgcolor: 'background.paper' }}>
            {lyricLines.map((line) => (
              <Box
                key={line.id}
                title={montageTexts.lyricTitle({ time: frameLabel(line.startFrame), text: line.text })}
                sx={{
                  position: 'absolute',
                  left: xFor(line.startFrame),
                  width: Math.max(1, xFor(line.endFrame - line.startFrame)),
                  height: '100%',
                  borderLeft: 2,
                  borderColor: 'info.main',
                  px: 0.5,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  color: 'text.primary',
                  typography: 'caption'
                }}
              >
                {line.text}
              </Box>
            ))}
          </Box>
          <Box
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) onSeek(absoluteFrame(event.clientX) - draft.audio.start_frame);
            }}
            sx={{ position: 'relative', height: 110, width: timelineWidth, bgcolor: 'action.hover' }}
          >
            {clipBlocks}
            <Box
              sx={{
                position: 'absolute',
                left: xFor(active.audio.start_frame + frame),
                top: 0,
                bottom: 0,
                borderLeft: 2,
                borderColor: 'error.main',
                pointerEvents: 'none'
              }}
            />
          </Box>
        </Box>
      </Box>
    </Stack>
  );
}
