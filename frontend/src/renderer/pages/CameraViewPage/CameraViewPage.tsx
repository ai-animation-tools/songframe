import { scenarioTexts } from '@shared/texts/scenario';
import { useEffect, useState, type ReactElement } from 'react';
import { Box, Slider, Stack, Typography } from '@mui/material';
import type { CameraWindowState } from '@shared/camera-window';
import { formatMetres } from '@shared/scheme-canvas';
import { MAX_FOV, MIN_FOV, cameraHeight, heightMoves, viewpointFov } from '@shared/viewpoint';
import { FIGURE_HEIGHT } from '@shared/viewpoint-camera';
import { CameraFrames } from '../../components/CameraFrames';
import { useThemeMode } from '../../theme';

const texts = scenarioTexts.viewpoint;

const metres = (value: number): string => formatMetres(Math.round(value * 10) / 10);

/**
 * Отдельное окно вида из камеры: кадры точки съёмки, присланные картой плана из основного окна, и зум объектива.
 * Точки правятся только в карте, каждое её изменение приходит сюда сразу. Ползунок зума отправляет карте новый угол
 * обзора: карта применяет его и присылает обновлённую точку, поэтому окно не держит своей копии угла. Тема окна
 * следует теме основного окна.
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
  const { viewpoint } = state;
  const fov = viewpointFov(viewpoint);
  const eye = heightMoves(viewpoint)
    ? `${metres(cameraHeight(viewpoint, 'start'))} → ${metres(cameraHeight(viewpoint, 'end'))}`
    : metres(cameraHeight(viewpoint, 'start'));
  const unavailable = viewpoint.side === 'top' ? texts.cameraViewTop : !viewpoint.camera ? texts.cameraViewNoCamera : null;
  return (
    <Stack spacing={1} sx={{ p: 1.5, minWidth: 0 }} data-camera-window="">
      <Typography variant="subtitle1" fontWeight={600}>
        {state.title}
      </Typography>
      {unavailable ? (
        <Typography color="text.secondary">{unavailable}</Typography>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary">
            {texts.cameraViewHint({ eye, figure: metres(FIGURE_HEIGHT) })}
          </Typography>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'stretch', minWidth: 0 }}>
            <CameraFrames viewpoint={viewpoint} scheme={state.scheme} heights={state.heights} vehicles={state.vehicles} minFrameWidth={420} />
            {/* Зум объектива: вверх — уже угол и крупнее кадр. Тот же угол, что в поле «Угол обзора» и у сектора на карте. */}
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', pt: 3, pb: 1 }} data-camera-zoom="">
              <Slider
                orientation="vertical"
                size="small"
                min={MIN_FOV}
                max={MAX_FOV}
                step={1}
                value={MIN_FOV + MAX_FOV - fov}
                disabled={!state.editable}
                aria-label={texts.cameraZoom}
                getAriaValueText={(value) => texts.cameraZoomValue({ fov: MIN_FOV + MAX_FOV - value })}
                valueLabelDisplay="auto"
                valueLabelFormat={(value) => texts.cameraZoomValue({ fov: MIN_FOV + MAX_FOV - value })}
                onChange={(_, value) => window.api.cameraWindow.send({ type: 'fov', fov: MIN_FOV + MAX_FOV - (value as number) })}
                sx={{ flex: 1, minHeight: 120 }}
              />
            </Box>
          </Stack>
        </>
      )}
    </Stack>
  );
}
