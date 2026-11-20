import { scenarioTexts } from '@shared/texts/scenario';
import { useEffect, useState, type ReactElement } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import type { CameraWindowState } from '@shared/camera-window';
import { CameraFrames } from '../../components/CameraFrames';
import { useThemeMode } from '../../theme';

const texts = scenarioTexts.viewpoint;

/**
 * Отдельное окно вида из камеры: кадры точки съёмки, присланные картой плана из основного окна. Окно только показывает
 * — правится всё в карте, а каждое её изменение приходит сюда сразу. Тема окна следует теме основного окна.
 */
export function CameraViewPage(): ReactElement {
  const [state, setState] = useState<CameraWindowState | null>(null);
  const { setMode } = useThemeMode();

  useEffect(() => {
    const unsubscribe = window.api.cameraWindow.onMessage(({ message }) => {
      if (message.type !== 'state') return;
      setState(message.state);
      setMode(message.state.theme);
    });
    window.api.cameraWindow.send({ type: 'ready' });
    return unsubscribe;
  }, [setMode]);

  if (!state) return <Typography sx={{ p: 2 }}>{texts.cameraWindowWaiting}</Typography>;
  const unavailable = state.viewpoint.side === 'top' ? texts.cameraViewTop : !state.viewpoint.camera ? texts.cameraViewNoCamera : null;
  return (
    <Stack spacing={1} sx={{ p: 1.5, minWidth: 0 }} data-camera-window="">
      <Typography variant="subtitle1" fontWeight={600}>
        {state.title}
      </Typography>
      {unavailable ? (
        <Typography color="text.secondary">{unavailable}</Typography>
      ) : (
        <Box sx={{ minWidth: 0 }}>
          <CameraFrames viewpoint={state.viewpoint} scheme={state.scheme} heights={state.heights} minFrameWidth={420} />
        </Box>
      )}
    </Stack>
  );
}
