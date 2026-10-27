import { PlayArrow, Pause, ArrowBack, ArrowForward, SkipPrevious, MovieFilterOutlined } from '@mui/icons-material';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Alert, Box, Button, Checkbox, FormControlLabel, IconButton, Slider, Stack, Tooltip, Typography } from '@mui/material';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { secondsToFrames, FPS } from '@shared/video';
import type { MontageDraft } from '@shared/montage';
import { clipLength, frameLabel, projectMediaUrl } from '../model';
import { createMontagePlayback, cutPreviewWindow, type MontagePlayback } from '../montagePlayback';

interface Props {
  project: string;
  draft: MontageDraft;
  trackUrl: string | null;
  frame: number;
  seekVersion: number;
  selectedClipId: string | null;
  loop: boolean;
  volume: number;
  onPreferences: (loop: boolean, volume: number) => void;
  command?: { id: number; action: 'toggle' | 'previousFrame' | 'nextFrame' } | null;
  onFrame: (frame: number) => void;
  onMetadata: (path: string, frames: number) => void;
  onTrackFrames: (frames: number) => void;
  suspended: boolean;
  videoMaxWidth?: string;
}

/** Музыка задаёт единые часы. Второй video заранее загружает следующий план без промежуточной сборки. */
export function MontagePreview({
  project,
  draft,
  trackUrl,
  frame,
  seekVersion,
  selectedClipId,
  loop,
  volume,
  onPreferences,
  command,
  onFrame,
  onMetadata,
  onTrackFrames,
  suspended,
  videoMaxWidth
}: Props): ReactElement {
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRefs = useRef<Array<HTMLVideoElement | null>>([null, null]);
  const videoStarts = useRef(new WeakSet<HTMLVideoElement>());
  const playbackRef = useRef<MontagePlayback | null>(null);
  const previewWindow = useRef<{ start: number; end: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = Math.max(0, draft.audio.end_frame_exclusive - draft.audio.start_frame);
  const position = Math.max(0, Math.min(frame, Math.max(0, length - 1)));
  const selectedIndex = draft.clips.findIndex((item) => item.id === selectedClipId);
  const cut =
    selectedIndex >= 0 && selectedIndex < draft.clips.length - 1
      ? draft.clips.slice(0, selectedIndex + 1).reduce((sum, item) => sum + clipLength(item), 0)
      : null;
  const cutWindow = cut === null ? null : cutPreviewWindow(cut, length);
  let offset = 0;
  const index = draft.clips.findIndex((clip) => {
    const end = offset + clipLength(clip);
    if (position < end) return true;
    offset = end;
    return false;
  });
  const clip = draft.clips[index];
  const active = index < 0 ? 0 : index % 2;
  const next = draft.clips[index + 1];
  const slots = useMemo(() => (active === 0 ? [clip, next] : [next, clip]), [active, clip, next]);
  const latest = useRef({ draft, loop, onFrame, length, position, slots });
  latest.current = { draft, loop, onFrame, length, position, slots };

  const syncVideos = (): void => {
    const current = latest.current;
    const audio = audioRef.current;
    const running = !!playbackRef.current?.isPlaying() && !!audio && !audio.paused;
    const livePosition = running ? Math.max(0, Math.min(current.length - 1, audio.currentTime * FPS - current.draft.audio.start_frame)) : current.position;
    let liveOffset = 0;
    const liveClip = current.draft.clips.find((source) => {
      if (livePosition < liveOffset + clipLength(source)) return true;
      liveOffset += clipLength(source);
      return false;
    });
    videoRefs.current.forEach((video, slot) => {
      if (!video) return;
      const source = current.slots[slot];
      const selected = !!source && source.id === liveClip?.id;
      if (!source || source.kind !== 'video') {
        if (!video.paused || videoStarts.current.has(video)) video.pause();
        return;
      }
      const target = (source.source_start_frame + (selected ? livePosition - liveOffset : 0)) / FPS;
      const tolerance = selected && running ? 0.12 : 0.001;
      // Часы читаются прямо из audio: задержавшийся рендер React не перематывает видео назад.
      // Пока предыдущий seek декодируется, не запускаем новый на каждом animation frame.
      if (video.readyState >= 1 && !video.seeking && Math.abs(video.currentTime - target) > tolerance) video.currentTime = Math.max(0, target);
      if (selected && running) {
        if (video.readyState >= 2 && !video.seeking && video.paused && !videoStarts.current.has(video)) {
          videoStarts.current.add(video);
          void video
            .play()
            .catch(() => undefined)
            .finally(() => videoStarts.current.delete(video));
        }
      } else if (!video.paused || videoStarts.current.has(video)) video.pause();
    });
  };
  const syncVideosRef = useRef(syncVideos);
  syncVideosRef.current = syncVideos;

  const seek = (target: number): void => {
    // Явная перемотка возвращает обычное воспроизведение вместо старой проверки стыка.
    previewWindow.current = null;
    const value = Math.max(0, Math.min(Math.max(0, length - 1), target));
    if (playbackRef.current) playbackRef.current.seek(value);
    else onFrame(value);
  };
  const toggle = (): void => {
    const playback = playbackRef.current;
    if (!playback || !length || suspended) return;
    if (!playback.isPlaying()) {
      if (frame >= length - 1) seek(0);
      setError(null);
      playback.play();
    } else playback.pause();
  };

  const previewCut = (): void => {
    const playback = playbackRef.current;
    if (!playback || !cutWindow || suspended) return;
    playback.pause();
    previewWindow.current = cutWindow;
    setError(null);
    playback.seek(cutWindow.start);
    playback.play();
  };

  // Команды из другого окна выполняются один раз и используют актуальное состояние плеера.
  const runCommand = useRef<(action: 'toggle' | 'previousFrame' | 'nextFrame') => void>(() => undefined);
  runCommand.current = (action) => {
    if (suspended) return;
    if (action === 'toggle') toggle();
    else {
      playbackRef.current?.pause();
      seek(frame + (action === 'previousFrame' ? -1 : 1));
    }
  };
  useEffect(() => {
    if (command) runCommand.current(command.action);
  }, [command]);

  useLayoutEffect(() => {
    const audio = audioRef.current;
    setPlaying(false);
    if (!audio || !trackUrl) return;
    const videos = videoRefs.current;
    const playback = createMontagePlayback(audio, {
      range: () => ({ start: latest.current.draft.audio.start_frame, end: latest.current.draft.audio.end_frame_exclusive, loop: latest.current.loop }),
      previewWindow: () => previewWindow.current,
      onFrame: (next) => latest.current.onFrame(next),
      onPlaying: (value) => {
        if (!value) previewWindow.current = null;
        setPlaying(value);
      },
      onError: (cause) => setError(String(cause))
    });
    playbackRef.current = playback;
    let request = 0;
    const tick = (): void => {
      playback.tick();
      syncVideosRef.current();
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => {
      // Отмена выполняется в том же commit, что смена src или unmount, до отклонения старого play().
      cancelAnimationFrame(request);
      playback.dispose();
      if (playbackRef.current === playback) playbackRef.current = null;
      videos.forEach((video) => video?.pause());
    };
  }, [trackUrl]);

  useEffect(() => {
    if (suspended) playbackRef.current?.pause();
  }, [suspended, trackUrl]);

  useEffect(() => {
    // Громкость относится только к предпросмотру и не меняет монтаж или экспорт.
    // Новая дорожка получает выбранный уровень без перемотки и остановки воспроизведения.
    if (audioRef.current) audioRef.current.volume = volume / 100;
  }, [volume, trackUrl]);

  useEffect(() => {
    if (previewWindow.current) playbackRef.current?.pause();
    playbackRef.current?.seek(latest.current.position);
    // Обычный frame приходит от самих часов и не должен писать currentTime обратно.
    // Перематываем только по явному действию, новому источнику или изменению музыкального участка.
  }, [seekVersion, draft.audio.start_frame, draft.audio.end_frame_exclusive, trackUrl]);

  useEffect(() => {
    // Выбор другого фрагмента или правка монтажа отменяют проверку устаревшего стыка.
    if (previewWindow.current) playbackRef.current?.pause();
  }, [draft.clips, selectedClipId]);

  useEffect(() => {
    syncVideosRef.current();
  }, [active, position, offset, playing, slots]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (suspended || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if ((event.target as HTMLElement)?.closest('input, textarea, select, button, [role="dialog"], [role="slider"], [contenteditable="true"]')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        toggle();
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        playbackRef.current?.pause();
        seek(frame + (event.key === 'ArrowLeft' ? -1 : 1));
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  });

  return (
    <Stack spacing={1} sx={{ width: '100%', minWidth: 0 }}>
      {/* Плеер занимает ширину рабочей области и сохраняет пропорции кадра. */}
      <Box sx={{ position: 'relative', width: '100%', maxWidth: videoMaxWidth, aspectRatio: '16 / 9', bgcolor: '#000', overflow: 'hidden', borderRadius: 1 }}>
        {slots.map((source, slot) => (
          <video
            key={slot}
            ref={(element) => {
              videoRefs.current[slot] = element;
            }}
            muted
            playsInline
            preload="auto"
            src={source?.kind === 'video' ? projectMediaUrl(project, source.path) : undefined}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (source && Number.isFinite(video.duration) && video.duration > 0) onMetadata(source.path, Math.max(1, secondsToFrames(video.duration)));
              syncVideosRef.current();
            }}
            onLoadedData={() => syncVideosRef.current()}
            onError={() => {
              if (source?.kind === 'video') setError(`Не удалось открыть видео ${source.scene}: ${source.path}`);
            }}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              visibility: slot === active && clip?.kind === 'video' ? 'visible' : 'hidden'
            }}
          />
        ))}
        {clip?.kind === 'card' ? (
          <img
            src={projectMediaUrl(project, clip.path)}
            alt={clip.scene}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : null}
        {!clip ? (
          <Typography sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff' }}>На этой позиции нет видео</Typography>
        ) : null}
      </Box>
      {trackUrl ? (
        <audio
          ref={audioRef}
          src={trackUrl}
          preload="auto"
          onLoadedMetadata={(event) => {
            event.currentTarget.volume = volume / 100;
            const duration = event.currentTarget.duration;
            if (Number.isFinite(duration) && duration > 0) onTrackFrames(secondsToFrames(duration));
            playbackRef.current?.seek(latest.current.position);
          }}
          onPause={(event) => {
            playbackRef.current?.onPause();
            if (event.currentTarget.paused) videoRefs.current.forEach((video) => video?.pause());
          }}
          onEnded={() => playbackRef.current?.onEnded()}
          onError={() => {
            playbackRef.current?.pause();
            setError('Не удалось открыть музыкальную дорожку.');
          }}
        />
      ) : null}
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Tooltip title={playing ? 'Пауза' : 'Воспроизвести'}>
          <span>
            <IconButton
              aria-label={playing ? 'Пауза' : 'Воспроизвести'}
              disabled={!trackUrl || !length || suspended}
              onClick={toggle}
              sx={{
                color: 'primary.contrastText',
                bgcolor: 'primary.main',
                '&:hover': { bgcolor: 'primary.dark' },
                '&.Mui-disabled': { bgcolor: 'action.disabledBackground' }
              }}
            >
              {playing ? <Pause /> : <PlayArrow />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="В начало">
          <span>
            <IconButton aria-label="В начало" disabled={!length || suspended} onClick={() => seek(0)}>
              <SkipPrevious />
            </IconButton>
          </span>
        </Tooltip>
        <Button
          startIcon={<ArrowBack />}
          size="small"
          onClick={() => {
            playbackRef.current?.pause();
            seek(frame - 1);
          }}
        >
          −1 кадр
        </Button>
        <Button
          startIcon={<ArrowForward />}
          size="small"
          onClick={() => {
            playbackRef.current?.pause();
            seek(frame + 1);
          }}
        >
          +1 кадр
        </Button>
        <Tooltip title={cutWindow ? 'Две секунды до и после стыка выбранного фрагмента' : 'Выберите фрагмент со следующей сценой внутри музыкального участка'}>
          <span>
            <Button startIcon={<MovieFilterOutlined />} size="small" disabled={!trackUrl || !cutWindow || suspended} onClick={previewCut}>
              Проверить склейку
            </Button>
          </span>
        </Tooltip>
        <FormControlLabel control={<Checkbox checked={loop} onChange={(event) => onPreferences(event.target.checked, volume)} />} label="Повторять" />
        <Stack direction="row" spacing={1} alignItems="center" sx={{ width: 220, maxWidth: '100%' }}>
          {volume === 0 ? <VolumeOffIcon fontSize="small" color="action" /> : <VolumeUpIcon fontSize="small" color="action" />}
          <Typography variant="caption" color="text.secondary">
            Громкость
          </Typography>
          <Slider
            aria-label="Громкость"
            value={volume}
            min={0}
            max={100}
            onChange={(_, value) => onPreferences(loop, value as number)}
            valueLabelDisplay="auto"
            valueLabelFormat={(value) => `${value}%`}
            getAriaValueText={(value) => `${value}%`}
            size="small"
          />
        </Stack>
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {frameLabel(position)} / {frameLabel(length)} · {clip?.scene ?? '—'}
        </Typography>
      </Stack>
      {error ? (
        <Alert severity="warning" onClose={() => setError(null)}>
          {error}
        </Alert>
      ) : null}
    </Stack>
  );
}
