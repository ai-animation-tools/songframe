import { scenarioTexts } from '@shared/texts/scenario';
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  MenuItem,
  Paper,
  Slider,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong';
import ClearIcon from '@mui/icons-material/Clear';
import CropFreeIcon from '@mui/icons-material/CropFree';
import EditIcon from '@mui/icons-material/Edit';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MapIcon from '@mui/icons-material/Map';
import LocationOffIcon from '@mui/icons-material/LocationOff';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import StarIcon from '@mui/icons-material/Star';
import VideocamIcon from '@mui/icons-material/Videocam';
import type { CastEntity, CastFile } from '@shared/types';
import type { Scheme, SchemeShape, SchemesFile } from '@shared/schemes';
import { formatMetres } from '@shared/scheme-canvas';
import {
  MAX_FOV,
  MIN_FOV,
  SIZE_FOV,
  VIEWPOINT_SIDES,
  VIEWPOINT_SIZES,
  createViewpoint,
  distance,
  footprintView,
  inFrame,
  linkedShapes,
  lookHeading,
  moves,
  pathPoint,
  removePoint,
  setFocus,
  setHeading,
  setPoint,
  sideFromPoints,
  syncSide,
  targetPath,
  viewpointFov,
  withFov,
  withoutHeading,
  withoutPoints,
  type SceneViewpoint,
  type ViewpointPath,
  type ViewpointPhase,
  type ViewpointSide,
  type ViewpointSize,
  type ViewpointTarget
} from '@shared/viewpoint';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { FullscreenEditorDialog } from '../../../components/FullscreenEditorDialog';
import { LinkedText } from '../../../components/LinkedText';
import { SchemePreview } from '../../../components/SchemePreview';
import { SchemeVolumeView, type VolumeExtra } from '../../../components/SchemeVolumeView';
import { EYE_HEIGHT, FIGURE_HEIGHT, subjectFigures, viewpointCamera } from '@shared/viewpoint-camera';

const texts = scenarioTexts.viewpoint;

/** Наименьшая высота мини-схемы в окне карты, px. */
const MIN_MAP_HEIGHT = 320;

/** Референс плана, нарисованный на схеме локации объектами: имя и фигуры. */
interface LinkedReference {
  id: string;
  name: string;
  shapes: SchemeShape[];
}
/** Ширина колонок строки камеры или героя: имя и состояние, px. */
const ROW_NAME_WIDTH = 120;
const ROW_STATE_WIDTH = 420;
/** Пропорция кадра вида из камеры. */
const FRAME_ASPECT = 16 / 9;
/** Цвета фигур героев: в фокусе и остальные. */
const FOCUS_COLOR = '#ef6c00';
const SUBJECT_COLOR = '#7b1fa2';

/** Бейдж заголовка: «С юга · Общий · на схеме» или «не задана». */
export function viewpointBadge(viewpoint: SceneViewpoint | undefined): string {
  if (!viewpoint) return texts.badgeUnset;
  return texts.badge({ side: texts.sides[viewpoint.side], size: texts.sizes[viewpoint.size], placed: !!viewpoint.camera || !!viewpoint.subjects?.length });
}

/** Ключ цели для переключателя: «camera» или ID сущности. */
const targetKey = (target: ViewpointTarget): string => (target === 'camera' ? 'camera' : target.entity);
const targetOf = (key: string): ViewpointTarget => (key === 'camera' ? 'camera' : { entity: key });

/** Метры с одним знаком для подписей. */
const metres = (value: number): string => formatMetres(Math.round(value * 10) / 10);

/** Состояние пути под мини-схемой: не на схеме, стоит или на сколько движется. */
const pathState = (path: ViewpointPath | undefined): string =>
  !path ? texts.notPlaced : moves(path) ? texts.movesBy({ metres: metres(distance(path.start, path.end!)) }) : texts.still;

/**
 * Поле угла обзора: своя строка ввода, угол применяется по уходу из поля или Enter, чтобы промежуточные «1» и «12»
 * не обрезались до наименьшего угла. Внешняя смена угла (крупность, край сектора) переписывает строку.
 */
function FovField({
  value,
  disabled,
  helperText,
  onCommit
}: {
  value: number;
  disabled: boolean;
  helperText: string;
  onCommit(value: number): void;
}): ReactElement {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const number = Number(text);
    if (text.trim() && Number.isFinite(number)) onCommit(number);
    else setText(String(value));
  };
  return (
    <TextField
      size="small"
      type="number"
      label={texts.fov}
      value={text}
      disabled={disabled}
      helperText={helperText}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
      sx={{ width: 190 }}
      // Подсказка читается и у закрытого поля: приглушённый цвет disabled не проходит по контрасту.
      slotProps={{ htmlInput: { step: 1 }, formHelperText: { sx: { '&.Mui-disabled': { color: 'text.secondary' } } } }}
    />
  );
}

/**
 * Вид из камеры: перспективные кадры объёма схемы из точки камеры — первый и, если камера движется или
 * поворачивается либо герои движутся, последний. Без камеры или у камеры сверху — пояснение вместо кадра.
 */
function CameraView({
  viewpoint,
  scheme,
  editable,
  update
}: {
  viewpoint: SceneViewpoint;
  scheme: Scheme;
  editable: boolean;
  update(next: SceneViewpoint): void;
}): ReactElement {
  const fov = viewpointFov(viewpoint);
  // Кадры пересчитываются только при смене точки съёмки: новый массив фигур перестраивал бы сцену при каждой отрисовке.
  const frames = useMemo(() => {
    const phases: ViewpointPhase[] =
      moves(viewpoint.camera) || viewpoint.heading?.end !== undefined || (viewpoint.subjects ?? []).some(moves) ? ['start', 'end'] : ['start'];
    return phases.map((phase) => ({
      phase,
      camera: viewpointCamera(viewpoint, phase),
      extras: subjectFigures(viewpoint, phase).map((figure): VolumeExtra => ({
        id: figure.entity,
        triangles: figure.triangles,
        color: figure.focus ? FOCUS_COLOR : SUBJECT_COLOR
      }))
    }));
  }, [viewpoint]);
  const unavailable = viewpoint.side === 'top' ? texts.cameraViewTop : !viewpoint.camera ? texts.cameraViewNoCamera : null;
  return (
    <Stack spacing={1} data-camera-view="">
      <Typography variant="subtitle2">{texts.cameraView}</Typography>
      {unavailable ? (
        <Typography variant="body2" color="text.secondary">
          {unavailable}
        </Typography>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary">
            {texts.cameraViewHint({ eye: metres(EYE_HEIGHT), figure: metres(FIGURE_HEIGHT) })}
          </Typography>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'stretch' }}>
            <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
              {frames.map((frame) =>
                frame.camera ? (
                  <Box key={frame.phase} sx={{ flex: '1 1 360px', minWidth: 0 }} data-camera-frame={frame.phase}>
                    <Typography variant="caption" color="text.secondary">
                      {texts.phases[frame.phase]}
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
            {/* Зум объектива: вверх — уже угол и крупнее кадр. Тот же угол, что в поле «Угол обзора» и у сектора на схеме. */}
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', pt: 3, pb: 1 }} data-camera-zoom="">
              <Slider
                orientation="vertical"
                size="small"
                min={MIN_FOV}
                max={MAX_FOV}
                step={1}
                value={MIN_FOV + MAX_FOV - fov}
                disabled={!editable}
                aria-label={texts.cameraZoom}
                getAriaValueText={(value) => texts.cameraZoomValue({ fov: MIN_FOV + MAX_FOV - value })}
                valueLabelDisplay="auto"
                valueLabelFormat={(value) => texts.cameraZoomValue({ fov: MIN_FOV + MAX_FOV - value })}
                onChange={(_, value) => update(withFov(viewpoint, MIN_FOV + MAX_FOV - (value as number)))}
                sx={{ flex: 1, minHeight: 120 }}
              />
            </Box>
          </Stack>
        </>
      )}
    </Stack>
  );
}

/**
 * Расстановка на схеме: что ставить щелчком (камера или герой, первый или последний кадр), мини-схема, строки
 * состояния камеры, героев и нарисованных на схеме референсов и вид из камеры. Живёт в окне карты во весь экран.
 */
function ViewpointPlacement({
  viewpoint,
  scheme,
  heroes,
  linked,
  nameOf,
  editable,
  height,
  update
}: {
  viewpoint: SceneViewpoint;
  scheme: Scheme;
  heroes: readonly CastEntity[];
  /** Референсы плана, нарисованные на схеме объектами: только строки состояния. */
  linked: readonly LinkedReference[];
  nameOf(id: string): string;
  editable: boolean;
  height: number;
  update(next: SceneViewpoint): void;
}): ReactElement {
  const [target, setTarget] = useState<ViewpointTarget>('camera');
  const [phase, setPhase] = useState<ViewpointPhase>('start');
  const camera = viewpoint.camera;
  const fov = viewpointFov(viewpoint);

  const pathRow = (key: string, name: string, path: ViewpointPath | undefined, focus: boolean | null): ReactElement => {
    const rowTarget = targetOf(key);
    const fromCamera = path && camera && key !== 'camera' ? texts.fromCamera({ metres: metres(distance(camera.start, path.start)) }) : null;
    // Герой вне угла обзора на первом кадре или, если кто-то движется, на последнем.
    const lastDiffers = moves(camera) || moves(path) || viewpoint.heading?.end !== undefined;
    const outOf =
      key === 'camera' || !path
        ? null
        : inFrame(viewpoint, 'start', path.start) === false
          ? 'start'
          : lastDiffers && inFrame(viewpoint, 'end', pathPoint(path, 'end')!) === false
            ? 'end'
            : null;
    return (
      // Сетка с колонкой состояния ограниченной ширины: кнопки строки стоят рядом с её текстом, а не у дальнего края
      // широкого окна, и у всех строк начинаются с одной линии.
      <Box
        key={key}
        sx={{ display: 'grid', gridTemplateColumns: `${ROW_NAME_WIDTH}px minmax(0, ${ROW_STATE_WIDTH}px) auto`, columnGap: 1.5, alignItems: 'center' }}
        data-viewpoint-row={key}
      >
        <Typography variant="body2" fontWeight={600} noWrap>
          {name}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          {focus ? <Chip size="small" variant="outlined" icon={<StarIcon color="secondary" />} label={texts.focus} /> : null}
          {outOf ? (
            <Tooltip title={texts.outOfFrameHint}>
              <Chip size="small" color="warning" icon={<CropFreeIcon />} label={texts.outOfFrame({ end: outOf === 'end' })} data-out-of-frame={outOf} />
            </Tooltip>
          ) : null}
          <Typography variant="body2" color="text.secondary">
            {[pathState(path), fromCamera, key === 'camera' && path && viewpoint.heading ? texts.headingOwn : null].filter(Boolean).join(' · ')}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {editable && path ? (
            <>
              {focus === false ? (
                <Button size="small" startIcon={<StarIcon />} onClick={() => update(setFocus(viewpoint, key))}>
                  {texts.makeFocus}
                </Button>
              ) : null}
              {key === 'camera' && viewpoint.heading ? (
                <Button size="small" startIcon={<CenterFocusStrongIcon />} onClick={() => update(withoutHeading(viewpoint))}>
                  {texts.headingAuto}
                </Button>
              ) : null}
              {path.end ? (
                <Button size="small" onClick={() => update(removePoint(viewpoint, rowTarget, 'end'))}>
                  {texts.removeEnd}
                </Button>
              ) : null}
              <Button size="small" color="error" startIcon={<LocationOffIcon />} onClick={() => update(removePoint(viewpoint, rowTarget, 'start'))}>
                {texts.removeTarget}
              </Button>
            </>
          ) : null}
        </Stack>
      </Box>
    );
  };

  // Референс на схеме объектом: расстояние до ближайшего края и попадает ли в кадр хоть часть контура.
  const linkedRow = (item: LinkedReference): ReactElement => {
    const start = footprintView(viewpoint, 'start', item.shapes);
    const lastDiffers = moves(camera) || viewpoint.heading?.end !== undefined;
    const end = lastDiffers ? footprintView(viewpoint, 'end', item.shapes) : null;
    const outOf = start?.inFrame === false ? 'start' : end?.inFrame === false ? 'end' : null;
    return (
      <Box
        key={item.id}
        sx={{ display: 'grid', gridTemplateColumns: `${ROW_NAME_WIDTH}px minmax(0, ${ROW_STATE_WIDTH}px) auto`, columnGap: 1.5, alignItems: 'center' }}
        data-viewpoint-linked={item.id}
      >
        <Typography variant="body2" fontWeight={600} noWrap>
          {item.name}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <Tooltip title={texts.linkedHint}>
            <Chip size="small" variant="outlined" icon={<MapIcon />} label={texts.linked} />
          </Tooltip>
          {outOf ? (
            <Tooltip title={texts.outOfFrameHint}>
              <Chip size="small" color="warning" icon={<CropFreeIcon />} label={texts.outOfFrame({ end: outOf === 'end' })} data-out-of-frame={outOf} />
            </Tooltip>
          ) : null}
          {start ? (
            <Typography variant="body2" color="text.secondary">
              {texts.nearestFromCamera({ metres: metres(start.distance) })}
            </Typography>
          ) : null}
        </Stack>
        <Box />
      </Box>
    );
  };

  return (
    <Stack spacing={1.5}>
      {editable ? (
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography variant="body2">{texts.target}</Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={targetKey(target)}
            aria-label={texts.target}
            onChange={(_, next: string | null) => next && setTarget(targetOf(next))}
          >
            <ToggleButton value="camera">
              <VideocamIcon fontSize="small" sx={{ mr: 0.5 }} />
              {texts.camera}
            </ToggleButton>
            {heroes.map((entity) => (
              <ToggleButton key={entity.id} value={entity.id}>
                {entity.name || entity.id}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={phase}
            aria-label={texts.phase}
            onChange={(_, next: ViewpointPhase | null) => next && setPhase(next)}
          >
            <ToggleButton value="start">{texts.phases.start}</ToggleButton>
            <ToggleButton value="end">{texts.phases.end}</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      ) : null}
      <Typography variant="body2" color="text.secondary">
        {viewpoint.side === 'top' ? texts.pickTopHint : texts.pickHint}
      </Typography>
      <SchemePreview
        scheme={scheme}
        label={texts.preview({ title: scheme.title })}
        disabled={!editable}
        height={height}
        camera={
          camera
            ? {
                start: camera.start,
                end: camera.end,
                startHeading: lookHeading(viewpoint, 'start'),
                endHeading: camera.end || viewpoint.heading?.end !== undefined ? lookHeading(viewpoint, 'end') : null,
                fov
              }
            : null
        }
        subjects={(viewpoint.subjects ?? []).map((subject, index) => ({
          entity: subject.entity,
          label: texts.subjectLabel({ name: nameOf(subject.entity), metres: camera ? metres(distance(camera.start, subject.start)) : null }),
          start: subject.start,
          end: subject.end,
          focus: index === 0
        }))}
        onPick={(point) => update(setPoint(viewpoint, target, phase, point))}
        onFov={(value) => update(withFov(viewpoint, value))}
        headingPhase={phase}
        onHeading={(degrees) => update(setHeading(viewpoint, phase, degrees))}
        onMove={(moved, movedPhase, point) => update(setPoint(viewpoint, moved, movedPhase, point))}
        ghost={
          target === 'camera'
            ? (point) => {
                // Куда смотрела бы камера, поставленная сюда щелчком: тот же расчёт, что после установки.
                const next = setPoint(viewpoint, 'camera', phase, point);
                return { heading: lookHeading(next, phase), fov: viewpointFov(next) };
              }
            : undefined
        }
      />
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack spacing={0.75}>
          {pathRow('camera', texts.camera, camera, null)}
          {heroes.map((entity) => {
            const path = targetPath(viewpoint, { entity: entity.id });
            return pathRow(entity.id, entity.name || entity.id, path, path ? viewpoint.subjects?.[0]?.entity === entity.id : null);
          })}
          {linked.map((item) => linkedRow(item))}
        </Stack>
      </Paper>
      <CameraView viewpoint={viewpoint} scheme={scheme} editable={editable} update={update} />
    </Stack>
  );
}

/**
 * Блок «Точка съёмки» редактора плана: свёрнут, в заголовке заметный бейдж. Внутри только кнопка «Открыть карту»:
 * локация, сторона, крупность, угол обзора, расстановка камеры и героев на мини-схеме вида сверху и вид из камеры
 * живут в окне во весь экран, чтобы не раздувать сценарий плана. Камера целится в героев или по своему направлению;
 * сторона по точкам считается сама.
 * У принятого плана блок закрыт: правка открывается после подтверждения с описанием риска, дальше — обычное окно
 * сохранения. Схемы читаются при первом раскрытии (requestSchemes).
 */
export function ViewpointBlock({
  shot,
  viewpoint,
  references,
  locked,
  dirty,
  saveButton,
  cast,
  schemes,
  schemesError,
  requestSchemes,
  onChange
}: {
  /** Код плана: для текста подтверждения. */
  shot: string;
  viewpoint: SceneViewpoint | undefined;
  /** Референсы плана: из них берутся герои на схеме. */
  references: readonly string[];
  /** План принят в производстве. */
  locked: boolean;
  /** В сценарии есть несохранённые правки: отметка в шапке окна во весь экран. */
  dirty: boolean;
  /** Кнопка «Сохранить» сценария в шапке окна во весь экран. */
  saveButton?: ReactNode;
  cast: CastFile | null;
  schemes: SchemesFile | null;
  schemesError: string | null;
  requestSchemes(): void;
  onChange(viewpoint: SceneViewpoint | undefined): void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (expanded || fullscreen) requestSchemes();
  }, [expanded, fullscreen, requestSchemes]);

  const entities = cast?.entities ?? [];
  const locations = entities.filter((entity) => entity.kind === 'location');
  // Герои для схемы: референсы плана, кроме локаций и мира.
  const heroes = references
    .map((id) => entities.find((entity) => entity.id === id))
    .filter((entity): entity is CastEntity => !!entity && entity.kind !== 'location' && entity.kind !== 'world');
  const nameOf = (id: string): string => entities.find((entity) => entity.id === id)?.name || id;
  const editable = !locked || unlocked;
  const top = viewpoint ? (schemes?.schemes.find((scheme) => scheme.location === viewpoint.location && scheme.view === 'top') ?? null) : null;
  // Референс, нарисованный на схеме объектом, точкой не ставят: место и размер берутся из схемы. Уже поставленный
  // раньше остаётся среди героев, чтобы его можно было убрать.
  const placed = (id: string): boolean => !!viewpoint?.subjects?.some((subject) => subject.entity === id);
  const linked: LinkedReference[] = heroes
    .filter((entity) => !placed(entity.id))
    .map((entity) => ({ id: entity.id, name: entity.name || entity.id, shapes: linkedShapes(top, entity.id) }))
    .filter((item) => item.shapes.length > 0);
  const placeable = heroes.filter((entity) => !linked.some((item) => item.id === entity.id));
  const fov = viewpoint ? viewpointFov(viewpoint) : 0;
  const derivedSide = !!viewpoint && sideFromPoints(viewpoint);
  const update = (next: SceneViewpoint): void => onChange(syncSide(withFov(next, next.fov)));

  // Поля точки съёмки: локация, сторона, крупность и угол — те же в блоке и в окне во весь экран.
  const fields = (current: SceneViewpoint): ReactElement => (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <TextField
          select
          size="small"
          label={texts.location}
          value={current.location}
          disabled={!editable}
          onChange={(event) => update(withoutPoints({ ...current, location: event.target.value }))}
          sx={{ minWidth: 220 }}
        >
          {locations.map((entity) => (
            <MenuItem key={entity.id} value={entity.id}>
              {entity.name || entity.id}
            </MenuItem>
          ))}
          {locations.some((entity) => entity.id === current.location) ? null : <MenuItem value={current.location}>{current.location}</MenuItem>}
        </TextField>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={current.side}
          disabled={!editable}
          aria-label={texts.side}
          onChange={(_, next: ViewpointSide | null) => next && update({ ...current, side: next })}
        >
          {VIEWPOINT_SIDES.map((side) => (
            // Сторона по точкам считается сама: вручную доступен только вид сверху.
            <ToggleButton key={side} value={side} disabled={!editable || (derivedSide && side !== 'top')} sx={{ px: 1.25 }}>
              {texts.sides[side]}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <TextField
          select
          size="small"
          label={texts.size}
          value={current.size}
          disabled={!editable}
          onChange={(event) => update({ ...current, size: event.target.value as ViewpointSize })}
          sx={{ minWidth: 140 }}
        >
          {VIEWPOINT_SIZES.map((size) => (
            <MenuItem key={size} value={size}>
              {texts.sizes[size]}
            </MenuItem>
          ))}
        </TextField>
        <FovField
          value={fov}
          disabled={!editable || current.side === 'top'}
          helperText={current.fov === undefined ? texts.fovDefault({ fov: SIZE_FOV[current.size] }) : texts.fovOwn({ fov: SIZE_FOV[current.size] })}
          onCommit={(value) => onChange(withFov(current, value))}
        />
        {current.fov !== undefined && editable ? (
          <Button size="small" startIcon={<RestartAltIcon />} onClick={() => onChange(withFov(current, undefined))} sx={{ mt: 0.5 }}>
            {texts.fovReset}
          </Button>
        ) : null}
      </Stack>
      {derivedSide ? (
        <Typography variant="body2" color="text.secondary">
          {texts.sideFromPoints({ side: texts.sides[current.side] })}
        </Typography>
      ) : null}
    </Stack>
  );

  return (
    <Accordion
      disableGutters
      variant="outlined"
      expanded={expanded}
      onChange={(_, next) => setExpanded(next)}
      sx={{ mt: 1.5, '&::before': { display: 'none' } }}
      data-viewpoint-block=""
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <VideocamIcon fontSize="small" color={viewpoint ? 'primary' : 'action'} />
          <Typography variant="subtitle2">{texts.title}</Typography>
          <Chip size="small" color={viewpoint ? 'primary' : 'default'} variant={viewpoint ? 'filled' : 'outlined'} label={viewpointBadge(viewpoint)} />
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">
            {texts.intro}
          </Typography>
          {locked && !unlocked ? (
            <Alert
              severity="info"
              action={
                <Button color="inherit" size="small" startIcon={<EditIcon />} onClick={() => setConfirm(true)}>
                  {texts.unlock}
                </Button>
              }
            >
              {texts.lockedHint}
            </Alert>
          ) : null}
          {!viewpoint ? (
            locations.length ? (
              <Box>
                <ActionButton
                  variant="outlined"
                  startIcon={<AddIcon />}
                  disabled={!editable}
                  disabledReason={editable ? null : texts.lockedHint}
                  onClick={() => {
                    const created = createViewpoint(
                      locations.map((entity) => entity.id),
                      schemes
                    );
                    onChange(created ?? undefined);
                    // Новую точку сразу расставляют на карте.
                    if (created) setFullscreen(true);
                  }}
                >
                  {texts.create}
                </ActionButton>
              </Box>
            ) : (
              <Alert severity="info">
                <LinkedText text={texts.noLocations} />
              </Alert>
            )
          ) : (
            <>
              <Box>
                <Button variant="outlined" startIcon={<MapIcon />} onClick={() => setFullscreen(true)}>
                  {texts.openMap}
                </Button>
              </Box>
              <FullscreenEditorDialog
                open={fullscreen}
                title={texts.fullscreenTitle({ shot })}
                dirty={dirty}
                actions={saveButton}
                onClose={() => setFullscreen(false)}
              >
                {fullscreen ? (
                  <Stack spacing={1.5}>
                    {fields(viewpoint)}
                    {schemesError ? (
                      <Alert severity="error">{texts.schemesError({ error: schemesError })}</Alert>
                    ) : top ? (
                      <ViewpointPlacement
                        viewpoint={viewpoint}
                        scheme={top}
                        heroes={placeable}
                        linked={linked}
                        nameOf={nameOf}
                        editable={editable}
                        height={Math.max(MIN_MAP_HEIGHT, window.innerHeight - 330)}
                        update={update}
                      />
                    ) : schemes ? (
                      <Alert severity="info">
                        <LinkedText text={texts.noTop} />
                      </Alert>
                    ) : null}
                  </Stack>
                ) : null}
              </FullscreenEditorDialog>
              {editable ? (
                <Box>
                  <Button size="small" color="error" startIcon={<ClearIcon />} onClick={() => onChange(undefined)}>
                    {texts.remove}
                  </Button>
                </Box>
              ) : null}
            </>
          )}
        </Stack>
      </AccordionDetails>
      <ConfirmationDialog
        open={confirm}
        title={texts.unlockTitle({ shot })}
        description={texts.unlockText}
        confirmLabel={texts.unlockConfirm}
        confirmIcon={<EditIcon />}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          setUnlocked(true);
        }}
      />
    </Accordion>
  );
}
