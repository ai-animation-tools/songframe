/**
 * Простой плеер аудиофайла в стиле плеера разметки песни: запуск и пауза, время, позиция и громкость.
 * Заменяет встроенные элементы управления audio: в WebKitGTK они выглядят выключенными и не дают
 * регулировать громкость, только выключать звук.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, Box, Slider, Stack, Typography } from '@mui/material';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { commonTexts } from '@shared/texts/common';
import { ActionIconButton } from './ActionIconButton';
import { VolumeSlider } from './VolumeSlider';
import { formatClock } from '../format';
import { describeError } from '../state';

interface AudioPlayerProps {
  src: string;
  /** Известная длительность, с: показывается до загрузки метаданных файла. */
  duration?: number;
  /**
   * Смена src продолжает с той же позиции и в том же состоянии паузы (сравнение A/B).
   * Без флага новый файл слушается с начала.
   */
  keepPosition?: boolean;
  /** Плеер ставится на паузу и не запускается, пока идёт операция; причина — в подсказке кнопки. */
  disabled?: boolean;
  disabledReason?: string | null;
  /** Доступное имя группы управления; по умолчанию — общее «Управление воспроизведением». */
  label?: string;
  /** Текст ошибки загрузки, если у сценария своя подсказка. */
  errorText?: string;
}

export function AudioPlayer({
  src,
  duration: knownDuration = 0,
  keepPosition = false,
  disabled = false,
  disabledReason = null,
  label,
  errorText
}: AudioPlayerProps): ReactElement {
  const texts = commonTexts.player;
  const audioRef = useRef<HTMLAudioElement>(null);
  // Позиция и состояние, которые переносятся на новый src; пока метаданные не пришли, currentTime уже 0.
  const resume = useRef({ position: 0, playing: false });
  const loading = useRef(false);
  // Номер загрузки отличает ошибку текущего play() от прерванного сменой файла.
  const revision = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(knownDuration);
  const [volume, setVolume] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // Один элемент audio на всё время жизни плеера: при A/B сигналы не накладываются друг на друга.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!keepPosition) resume.current = { position: 0, playing: false };
    else if (!loading.current && audio.currentSrc) resume.current = { position: audio.currentTime, playing: !audio.paused };
    loading.current = true;
    revision.current++;
    audio.pause();
    audio.src = src;
    audio.load();
    setTime(resume.current.position);
    setDuration(knownDuration);
    setError(null);
    // knownDuration — только начальное значение до метаданных, перезагрузку файла он не вызывает.
  }, [src, keepPosition]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      // Освобождаем файл при закрытии: Windows не позволяет удалить открытый аудиофайл.
      audio?.pause();
      audio?.removeAttribute('src');
      audio?.load();
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!disabled) return;
    resume.current.playing = false;
    audioRef.current?.pause();
  }, [disabled]);

  const play = (audio: HTMLAudioElement): void => {
    const current = revision.current;
    setError(null);
    void audio.play().catch((reason: unknown) => {
      if (revision.current !== current || (reason instanceof DOMException && reason.name === 'AbortError')) return;
      setError(texts.playbackFailed({ reason: describeError(reason) }));
    });
  };

  const toggle = (): void => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) play(audio);
    else audio.pause();
  };

  const seek = (value: number): void => {
    const audio = audioRef.current;
    setTime(value);
    if (!audio) return;
    if (loading.current) resume.current.position = value;
    else audio.currentTime = value;
  };

  const playLabel = playing ? texts.pause : texts.play;
  return (
    <Stack spacing={0.5}>
      {/* preload="metadata": длительность и позиция доступны сразу, сам файл читается при запуске. */}
      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => {
          if (!loading.current) setTime(event.currentTarget.currentTime);
        }}
        onLoadedMetadata={(event) => {
          const audio = event.currentTarget;
          if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
          const { position, playing: wasPlaying } = resume.current;
          if (position > 0) audio.currentTime = Number.isFinite(audio.duration) ? Math.min(position, audio.duration) : position;
          loading.current = false;
          if (wasPlaying && !disabled) play(audio);
        }}
        onError={() => {
          // Сброс src при закрытии тоже вызывает error: это не ошибка прослушивания.
          if (!audioRef.current?.getAttribute('src')) return;
          loading.current = false;
          setError(errorText ?? texts.loadFailed);
        }}
      />
      <Box role="group" aria-label={label ?? texts.controls} sx={{ display: 'flex', alignItems: 'center', columnGap: 1.5 }}>
        <ActionIconButton
          size="small"
          color="primary"
          aria-label={playLabel}
          disabled={disabled}
          disabledReason={disabledReason}
          onClick={toggle}
          sx={{ border: 1, borderColor: 'divider' }}
        >
          {playing ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
        </ActionIconButton>
        <Typography variant="body2" sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
          {texts.clock({ time: formatClock(time), duration: formatClock(duration) })}
        </Typography>
        <Slider
          aria-label={texts.position}
          size="small"
          min={0}
          max={duration || 1}
          step={0.01}
          value={Math.min(time, duration || 1)}
          disabled={!duration}
          onChange={(_event, value) => seek(value as number)}
          getAriaValueText={(value) => formatClock(value)}
          sx={{ flex: 1, mx: 1 }}
        />
        <VolumeSlider volume={volume} onChange={setVolume} />
      </Box>
      {error ? <Alert severity="warning">{error}</Alert> : null}
    </Stack>
  );
}
