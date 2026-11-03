import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Checkbox, FormControlLabel, Paper, Stack, Typography } from '@mui/material';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import type { MediaFile } from '@shared/workspace';
import { workspaceTexts as text } from '@shared/texts/workspace';
import type { WorkspaceBridge } from '@platform/workspace';
import { ActionButton } from './ActionButton';

/** Запрос прослушивания относится к конкретному экземпляру плеера; номер исключает потерю повторного выбора. */
export interface SeekRequest {
  mediaIdentity: string;
  start: number;
  end: number;
  sequence: number;
}
/** Общий плеер работает с URL зарегистрированного файла; файл и сохранённые тайминги не изменяются.
 * AudioContext создаётся только по действию построения волны и закрывается после декодирования или unmount.
 */
export function MediaPlayer({
  media,
  bridge,
  seek,
  onMetadata,
  preview = true,
  mediaVersion = ''
}: {
  media: MediaFile;
  bridge: WorkspaceBridge;
  seek?: SeekRequest | null;
  onMetadata?: () => void;
  preview?: boolean;
  /** Версия содержимого позволяет освободить старый декодированный буфер при том же пути и URL. */
  mediaVersion?: string;
}) {
  const element = useRef<HTMLMediaElement | null>(null);
  const segment = useRef<SeekRequest | null>(null);
  const session = useRef(`preview-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [loop, setLoop] = useState(false);
  const [error, setError] = useState('');
  const [position, setPosition] = useState(0);
  const [wave, setWave] = useState<number[]>([]);
  const [waveBusy, setWaveBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const generation = useRef(0);
  const lifetime = useRef(0);
  const download = useRef<AbortController | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  useEffect(() => {
    const owner = session.current;
    const player = element.current;
    lifetime.current++;
    return () => {
      lifetime.current++;
      generation.current++;
      download.current?.abort();
      void audioContext.current?.close().catch(() => undefined);
      if (player) {
        player.pause();
        player.removeAttribute('src');
        player.load();
      }
      if (preview) void bridge.closePreview(owner).catch(() => undefined);
    };
  }, [bridge, media.url, preview]);
  useEffect(
    () =>
      bridge.onPreviewClosed(
        (event) => {
          if (event.session === session.current) setPreviewOpen(false);
        },
        (reason) => setError(String(reason))
      ),
    [bridge]
  );
  useEffect(() => {
    if (!seek || seek.mediaIdentity !== `${media.url}:${mediaVersion}` || !element.current) return;
    segment.current = seek;
    element.current.currentTime = seek.start;
    void element.current.play().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : text.mediaError));
  }, [seek, media.url, mediaVersion]);
  async function waveform() {
    const id = ++generation.current;
    download.current?.abort();
    const controller = new AbortController();
    download.current = controller;
    let context: AudioContext | null = null;
    setWaveBusy(true);
    setError('');
    try {
      context = new AudioContext();
      audioContext.current = context;
      const response = await fetch(media.url, { signal: controller.signal });
      if (!response.ok) throw new Error(text.mediaError);
      const decoded = await context.decodeAudioData(await response.arrayBuffer());
      if (id !== generation.current) return;
      const samples = decoded.getChannelData(0),
        count = 300,
        step = Math.max(1, Math.ceil(samples.length / count));
      const peaks = [];
      for (let start = 0; start < samples.length; start += step) {
        let peak = 0;
        for (let i = start; i < Math.min(start + step, samples.length); i++) peak = Math.max(peak, Math.abs(samples[i]));
        peaks.push(peak);
      }
      setWave(peaks);
    } catch (reason) {
      if (id === generation.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : text.mediaError);
    } finally {
      if (context && context.state !== 'closed')
        await context.close().catch((reason) => {
          if (id === generation.current) setError(reason instanceof Error ? reason.message : text.mediaError);
        });
      if (id === generation.current) setWaveBusy(false);
      if (audioContext.current === context) audioContext.current = null;
    }
  }
  async function openPreview() {
    const owner = session.current,
      id = lifetime.current;
    try {
      await bridge.openPreview({ session: owner, mediaUrl: media.url, title: media.path.split(/[\\/]/).pop() ?? text.previewTitle });
      if (id === lifetime.current) setPreviewOpen(true);
      else await bridge.closePreview(owner);
    } catch (reason) {
      if (id === lifetime.current) setError(reason instanceof Error ? reason.message : text.unknownError);
    }
  }
  function timeChanged() {
    const player = element.current;
    if (!player) return;
    setPosition(player.currentTime);
    const bounds = segment.current;
    if (bounds && player.currentTime >= bounds.end) {
      if (loop) {
        player.currentTime = bounds.start;
      } else {
        player.pause();
        segment.current = null;
      }
    }
  }
  const props = {
    controls: true,
    src: media.url,
    crossOrigin: 'anonymous' as const,
    preload: 'metadata',
    loop: loop && !segment.current,
    onLoadedMetadata: onMetadata,
    onTimeUpdate: timeChanged,
    onError: () => setError(text.mediaError),
    'aria-label': text.player
  };
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6" component="h2">
          {text.media}
        </Typography>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
          {media.path}
        </Typography>
        {media.kind === 'video' ? (
          <Box
            component="video"
            ref={(value: HTMLVideoElement | null) => {
              element.current = value;
            }}
            {...props}
            sx={{ width: '100%', maxHeight: 420, bgcolor: 'common.black' }}
          />
        ) : (
          <Box
            component="audio"
            ref={(value: HTMLAudioElement | null) => {
              element.current = value;
            }}
            {...props}
            sx={{ width: '100%' }}
          />
        )}
        <Stack direction="row" alignItems="center" gap={2}>
          <FormControlLabel control={<Checkbox checked={loop} onChange={(_, value) => setLoop(value)} />} label={text.loop} />
          <Typography variant="body2">{text.trackPosition(position)}</Typography>
        </Stack>
        {error && <Alert severity="error">{error}</Alert>}
        {wave.length > 0 && (
          <Box component="svg" role="img" aria-label={text.waveformLabel} viewBox="0 0 600 100" sx={{ width: '100%', height: 100, color: 'primary.main' }}>
            {wave.map((peak, index) => (
              <line key={index} x1={index * 2 + 1} x2={index * 2 + 1} y1={50 - peak * 48} y2={50 + peak * 48} stroke="currentColor" strokeWidth="1.5" />
            ))}
          </Box>
        )}
        <Stack direction="row" gap={1} useFlexGap flexWrap="wrap">
          <ActionButton
            startIcon={<GraphicEqIcon />}
            disabled={waveBusy || media.kind !== 'audio'}
            disabledReason={media.kind !== 'audio' ? text.waveformUnavailable : null}
            onClick={() => void waveform()}
          >
            {waveBusy ? text.waveformLoading : text.waveform}
          </ActionButton>
          {preview && (
            <ActionButton startIcon={<OpenInNewIcon />} onClick={() => void openPreview()} aria-pressed={previewOpen}>
              {text.preview}
            </ActionButton>
          )}
        </Stack>
      </Stack>
    </Paper>
  );
}
