import { scenarioTexts } from '@shared/texts/scenario';
import { useMemo, type ReactElement } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import type { Scheme } from '@shared/schemes';
import { heightMoves, moves, tiltMoves, type SceneViewpoint, type ViewpointPhase } from '@shared/viewpoint';
import { subjectFigures, viewpointCamera, type FigureHeights, type FigureVehicles } from '@shared/viewpoint-camera';
import { SchemeVolumeView, type VolumeExtra } from './SchemeVolumeView';

const texts = scenarioTexts.viewpoint;
/** Пропорция кадра вида из камеры. */
const FRAME_ASPECT = 16 / 9;
/** Цвета фигур героев: главного и остальных. */
const LEAD_COLOR = '#ef6c00';
const SUBJECT_COLOR = '#7b1fa2';
/** Пустой список машин: один на все отрисовки, чтобы кадры не пересчитывались. */
const NO_VEHICLES: FigureVehicles = {};

/** Фигуры героев кадра phase для объёма: главный — оранжевый, остальные — фиолетовые; машины — коробкой. */
export function figureExtras(viewpoint: SceneViewpoint, phase: ViewpointPhase, heights: FigureHeights, vehicles: FigureVehicles): VolumeExtra[] {
  return subjectFigures(viewpoint, phase, heights, vehicles).map((figure) => ({
    id: figure.entity,
    triangles: figure.triangles,
    color: figure.lead ? LEAD_COLOR : SUBJECT_COLOR
  }));
}

/**
 * Кадры вида из камеры точки съёмки: перспектива объёма схемы из точки камеры — первый кадр и, если камера движется,
 * поворачивается или меняет высоту либо герои движутся, последний. Общие для карты точки съёмки и отдельного окна вида
 * из камеры. Кадры пересчитываются только при смене точки, схемы или роста: новый массив фигур перестраивал бы сцену
 * при каждой отрисовке. minFrameWidth — ширина, от которой кадры встают рядом, а не друг под другом. vehicles — машины
 * среди героев с длиной и шириной: они рисуются коробкой, а не цилиндром.
 */
export function CameraFrames({
  viewpoint,
  scheme,
  heights,
  vehicles = NO_VEHICLES,
  minFrameWidth = 360
}: {
  viewpoint: SceneViewpoint;
  scheme: Scheme;
  heights: FigureHeights;
  vehicles?: FigureVehicles;
  minFrameWidth?: number;
}): ReactElement {
  const frames = useMemo(() => {
    const phases: ViewpointPhase[] =
      moves(viewpoint.camera) ||
      viewpoint.heading?.end !== undefined ||
      heightMoves(viewpoint) ||
      tiltMoves(viewpoint) ||
      (viewpoint.subjects ?? []).some(moves)
        ? ['start', 'end']
        : ['start'];
    return phases.map((phase) => ({
      phase,
      camera: viewpointCamera(viewpoint, phase, heights, vehicles),
      extras: figureExtras(viewpoint, phase, heights, vehicles)
    }));
  }, [viewpoint, heights, vehicles]);
  return (
    <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
      {frames.map((frame) =>
        frame.camera ? (
          <Box key={frame.phase} sx={{ flex: `1 1 ${minFrameWidth}px`, minWidth: 0 }} data-camera-frame={frame.phase}>
            <Typography variant="caption" color="text.secondary">
              {frames.length === 1 ? texts.phaseWhole : texts.phases[frame.phase]}
            </Typography>
            <SchemeVolumeView
              scheme={scheme}
              label={texts.cameraFrame({ phase: texts.phases[frame.phase] })}
              camera={frame.camera}
              extras={frame.extras}
              aspect={FRAME_ASPECT}
            />
          </Box>
        ) : null
      )}
    </Stack>
  );
}
