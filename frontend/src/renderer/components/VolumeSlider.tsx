/** Регулятор громкости плееров: одинаковый вид в разметке песни и прослушивании трека. */
import type { ReactElement } from 'react';
import { Slider, Stack } from '@mui/material';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { commonTexts } from '@shared/texts/common';

interface VolumeSliderProps {
  /** Громкость элемента audio, 0–1. */
  volume: number;
  onChange: (volume: number) => void;
}

export function VolumeSlider({ volume, onChange }: VolumeSliderProps): ReactElement {
  const texts = commonTexts.player;
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      {volume === 0 ? <VolumeOffIcon fontSize="small" color="action" /> : <VolumeUpIcon fontSize="small" color="action" />}
      <Slider
        aria-label={texts.volume}
        size="small"
        min={0}
        max={100}
        value={Math.round(volume * 100)}
        onChange={(_event, value) => onChange((value as number) / 100)}
        valueLabelDisplay="auto"
        valueLabelFormat={(value) => texts.volumePercent({ value })}
        getAriaValueText={(value) => texts.volumePercent({ value })}
        sx={{ width: 72 }}
      />
    </Stack>
  );
}
