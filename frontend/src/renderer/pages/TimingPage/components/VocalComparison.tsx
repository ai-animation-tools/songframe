import { useState, type ReactElement } from 'react';
import { Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { GraphicEq, MusicNote } from '@mui/icons-material';
import { songTimingTexts as texts } from '@shared/texts/song-timing';
import { AudioPlayer } from '../../../components/AudioPlayer';

interface Props {
  sourcePath: string;
  vocalPath: string;
  /** Пока идёт операция диалога, прослушивание останавливается и не запускается. */
  disabled?: boolean;
  disabledReason?: string | null;
}

/** Общий плеер с одним audio исключает наложение сигналов: при A/B он переносит позицию и состояние паузы. */
export function VocalComparison({ sourcePath, vocalPath, disabled = false, disabledReason = null }: Props): ReactElement {
  const [signal, setSignal] = useState<'original' | 'vocal'>('vocal');
  const url = window.api.shell.fileUrl(signal === 'original' ? sourcePath : vocalPath);
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
      <AudioPlayer src={url} keepPosition errorText={texts.audioError} disabled={disabled} disabledReason={disabledReason} />
    </Stack>
  );
}
