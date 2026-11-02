import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { GraphicEq, MusicNote } from '@mui/icons-material';
import { songTimingTexts as texts } from '@shared/texts/song-timing';

interface Props {
  sourcePath: string;
  vocalPath: string;
  vocalSha256: string;
}

/** Один audio исключает наложение сигналов: при A/B переносим позицию и состояние паузы. */
export function VocalComparison({ sourcePath, vocalPath, vocalSha256 }: Props): ReactElement {
  const audio = useRef<HTMLAudioElement>(null);
  const resume = useRef({ position: 0, playing: false });
  const loading = useRef(false);
  const mediaRevision = useRef(0);
  const [signal, setSignal] = useState<'original' | 'vocal'>('vocal');
  const [error, setError] = useState('');
  const url = window.api.shell.fileUrl(signal === 'original' ? sourcePath : vocalPath);
  useEffect(() => {
    const player = audio.current;
    if (!player) return;
    // Во время загрузки currentTime уже равен нулю: быстрый A/B сохраняет последнюю настоящую позицию.
    if (!loading.current) resume.current = { position: player.currentTime, playing: !player.paused };
    loading.current = true;
    mediaRevision.current++;
    player.pause();
    player.src = url;
    player.load();
    setError('');
  }, [url, vocalSha256]);
  useEffect(() => {
    const player = audio.current;
    return () => {
      // Освобождаем WAV до удаления: Windows не позволяет удалить открытый аудиофайл.
      player?.pause();
      player?.removeAttribute('src');
      player?.load();
    };
  }, []);
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">{texts.compareAudio}</Typography>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={signal}
        aria-label={texts.compareAudio}
        onChange={(_event, next: 'original' | 'vocal' | null) => {
          if (next) setSignal(next);
        }}
      >
        <ToggleButton value="original">
          <MusicNote fontSize="small" sx={{ mr: 1 }} />
          {texts.originalAudio}
        </ToggleButton>
        <ToggleButton value="vocal">
          <GraphicEq fontSize="small" sx={{ mr: 1 }} />
          {texts.vocalAudio}
        </ToggleButton>
      </ToggleButtonGroup>
      <audio
        ref={audio}
        controls
        preload="metadata"
        aria-label={texts.compareAudio}
        style={{ width: '100%' }}
        onLoadedMetadata={() => {
          const player = audio.current;
          if (!player || player.readyState < 1) return;
          player.currentTime = Math.min(resume.current.position, Number.isFinite(player.duration) ? player.duration : resume.current.position);
          loading.current = false;
          const revision = mediaRevision.current;
          if (resume.current.playing)
            void player.play().catch(() => {
              // Смена сигнала прерывает старый play(); это не ошибка нового прослушивания.
              if (mediaRevision.current === revision) setError(texts.audioError);
            });
        }}
        onError={() => setError(texts.audioError)}
      />
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}
