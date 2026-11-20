import { scenarioTexts } from '@shared/texts/scenario';
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
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
  cameraHeight,
  createViewpoint,
  heightMoves,
  distance,
  footprintView,
  inFrame,
  linkedShapes,
  lookHeading,
  moves,
  pathPoint,
  removePoint,
  setFocus,
  setCameraHeight,
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
import { CameraFrames } from '../../../components/CameraFrames';
import { ActionIconButton } from '../../../components/ActionIconButton';
import { useApp } from '../../../state';
import { useThemeMode } from '../../../theme';
import { useDetachedCamera } from '../useDetachedCamera';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CallReceivedIcon from '@mui/icons-material/CallReceived';
import { FIGURE_HEIGHT, type FigureHeights } from '@shared/viewpoint-camera';
import { castEntityRoute } from '../../../components/castRoutes';

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
 * Числовое поле точки съёмки: своя строка ввода, число применяется по уходу из поля или Enter, чтобы промежуточные
 * «1» и «0» не обрезались до границы. Внешняя смена значения (крупность, край сектора, кнопка высоты) переписывает
 * строку. optional — пустая строка применяется как «нет значения» (onCommit(undefined)); иначе пустая возвращает прежнее.
 */
function CommitNumberField({
  label,
  value,
  disabled,
  helperText,
  optional = false,
  step = 1,
  width = 190,
  onCommit
}: {
  label: string;
  value: number | undefined;
  disabled: boolean;
  helperText: string;
  optional?: boolean;
  step?: number;
  width?: number;
  onCommit(value: number | undefined): void;
}): ReactElement {
  const shown = value === undefined ? '' : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = (): void => {
    const number = Number(text);
    if (!text.trim() && optional) onCommit(undefined);
    else if (text.trim() && Number.isFinite(number)) onCommit(number);
    else setText(shown);
  };
  return (
    <TextField
      size="small"
      type="number"
      label={label}
      value={text}
      disabled={disabled}
      helperText={helperText}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
      sx={{ width }}
      // Подсказка читается и у закрытого поля: приглушённый цвет disabled не проходит по контрасту.
      slotProps={{ htmlInput: { step }, formHelperText: { sx: { '&.Mui-disabled': { color: 'text.secondary' } } } }}
    />
  );
}

/** Подсказки высоты камеры, м: типовые точки съёмки в порядке подъёма. */
const HEIGHT_PRESETS = [
  { key: 'ground', metres: 0.3 },
  { key: 'waist', metres: 1 },
  { key: 'eyes', metres: 1.6 },
  { key: 'overhead', metres: 2.5 },
  { key: 'drone', metres: 10 }
] as const;

/**
 * Вид из камеры: перспективные кадры объёма схемы из точки камеры — первый и, если камера движется или
 * поворачивается либо герои движутся, последний. Без камеры или у камеры сверху — пояснение вместо кадра.
 */
function CameraView({
  viewpoint,
  scheme,
  heights,
  title,
  editable,
  update
}: {
  viewpoint: SceneViewpoint;
  scheme: Scheme;
  /** Заголовок отдельного окна вида: план и локация. */
  title: string;
  /** Рост героев из кастинга. */
  heights: FigureHeights;
  editable: boolean;
  update(next: SceneViewpoint): void;
}): ReactElement {
  const fov = viewpointFov(viewpoint);
  const { notify, describeError } = useApp();
  const { mode: theme } = useThemeMode();
  const windowState = useMemo(() => ({ title, scheme, viewpoint, heights, theme }), [title, scheme, viewpoint, heights, theme]);
  const separate = useDetachedCamera(windowState, (error) => notify(describeError(error), 'error'));
  const eye = heightMoves(viewpoint)
    ? `${metres(cameraHeight(viewpoint, 'start'))} → ${metres(cameraHeight(viewpoint, 'end'))}`
    : metres(cameraHeight(viewpoint, 'start'));
  const unavailable = viewpoint.side === 'top' ? texts.cameraViewTop : !viewpoint.camera ? texts.cameraViewNoCamera : null;
  return (
    <Stack spacing={1} data-camera-view="">
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        <Typography variant="subtitle2">{texts.cameraView}</Typography>
        {separate.detached ? null : (
          <ActionIconButton aria-label={texts.cameraDetach} size="small" onClick={separate.open}>
            <OpenInNewIcon fontSize="small" />
          </ActionIconButton>
        )}
      </Stack>
      {separate.detached ? (
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }} data-camera-detached="">
          <Typography variant="body2" color="text.secondary">
            {texts.cameraDetached}
          </Typography>
          <ActionButton startIcon={<CallReceivedIcon />} onClick={separate.close}>
            {texts.cameraReturn}
          </ActionButton>
        </Stack>
      ) : unavailable ? (
        <Typography variant="body2" color="text.secondary">
          {unavailable}
        </Typography>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary">
            {texts.cameraViewHint({ eye, figure: metres(FIGURE_HEIGHT) })}
          </Typography>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'stretch' }}>
            <CameraFrames viewpoint={viewpoint} scheme={scheme} heights={heights} />
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
  heights,
  title,
  editable,
  height,
  update
}: {
  viewpoint: SceneViewpoint;
  scheme: Scheme;
  heroes: readonly CastEntity[];
  /** Рост сущностей кастинга: фигуры вида из камеры и отметка «рост не задан». */
  heights: FigureHeights;
  /** Заголовок отдельного окна вида из камеры. */
  title: string;
  /** Референсы плана, нарисованные на схеме объектами: только строки состояния. */
  linked: readonly LinkedReference[];
  nameOf(id: string): string;
  editable: boolean;
  height: number;
  update(next: SceneViewpoint): void;
}): ReactElement {
  const navigate = useNavigate();
  const [target, setTarget] = useState<ViewpointTarget>('camera');
  const [phase, setPhase] = useState<ViewpointPhase>('start');
  const camera = viewpoint.camera;
  const fov = viewpointFov(viewpoint);

  const pathRow = (key: string, name: string, path: ViewpointPath | undefined, focus: boolean | null): ReactElement => {
    const rowTarget = targetOf(key);
    const fromCamera = path && camera && key !== 'camera' ? texts.fromCamera({ metres: metres(distance(camera.start, path.start)) }) : null;
    // Герой вне угла обзора на первом кадре или, если кто-то движется, на последнем.
    const lastDiffers = moves(camera) || moves(path) || viewpoint.heading?.end !== undefined;
    // Герой без роста в кастинге: фигура условная — заметная отметка со ссылкой на сущность.
    const unmeasured = key !== 'camera' && !!path && heights[key] === undefined;
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
          {unmeasured ? (
            <Tooltip title={texts.heightUnknownHint}>
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                label={texts.heightUnknown}
                onClick={() => navigate(castEntityRoute(key))}
                data-height-unknown={key}
              />
            </Tooltip>
          ) : null}
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
        onMove={(moved, movedPhase, point) =>
          // На последнем кадре неподвижная точка не сдвигается целиком: перетаскивание задаёт, куда она переместится.
          update(setPoint(viewpoint, moved, phase === 'end' && !targetPath(viewpoint, moved)?.end ? 'end' : movedPhase, point))
        }
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
      <CameraView viewpoint={viewpoint} scheme={scheme} heights={heights} title={title} editable={editable} update={update} />
    </Stack>
  );
}

/**
 * Блок «Точка съёмки» редактора плана: свёрнут, в заголовке заметный бейдж. Внутри только кнопка «Открыть карту»:
 * локация, сторона, крупность, угол обзора, расстановка камеры и героев на мини-схеме и вид из камеры
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
  const heights = useMemo<FigureHeights>(
    () => Object.fromEntries(entities.flatMap((entity) => (entity.height === undefined ? [] : [[entity.id, entity.height]]))),
    [entities]
  );
  const editable = !locked || unlocked;
  const locationScheme = viewpoint ? (schemes?.schemes.find((scheme) => scheme.location === viewpoint.location) ?? null) : null;
  // Референс, нарисованный на схеме объектом, точкой не ставят: место и размер берутся из схемы. Уже поставленный
  // раньше остаётся среди героев, чтобы его можно было убрать.
  const placed = (id: string): boolean => !!viewpoint?.subjects?.some((subject) => subject.entity === id);
  const linked: LinkedReference[] = heroes
    .filter((entity) => !placed(entity.id))
    .map((entity) => ({ id: entity.id, name: entity.name || entity.id, shapes: linkedShapes(locationScheme, entity.id) }))
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
        <CommitNumberField
          label={texts.fov}
          value={fov}
          disabled={!editable || current.side === 'top'}
          helperText={current.fov === undefined ? texts.fovDefault({ fov: SIZE_FOV[current.size] }) : texts.fovOwn({ fov: SIZE_FOV[current.size] })}
          onCommit={(value) => value !== undefined && onChange(withFov(current, value))}
        />
        {current.fov !== undefined && editable ? (
          <Button size="small" startIcon={<RestartAltIcon />} onClick={() => onChange(withFov(current, undefined))} sx={{ mt: 0.5 }}>
            {texts.fovReset}
          </Button>
        ) : null}
      </Stack>
      {current.side === 'top' ? null : (
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }} data-camera-height="">
          <CommitNumberField
            label={texts.cameraHeight}
            value={cameraHeight(current, 'start')}
            disabled={!editable}
            step={0.1}
            helperText={current.camera_height ? texts.cameraHeightOwn : texts.cameraHeightDefault}
            onCommit={(value) => value !== undefined && onChange(setCameraHeight(current, 'start', value))}
          />
          <CommitNumberField
            label={texts.cameraHeightEnd}
            value={current.camera_height?.end}
            disabled={!editable}
            optional
            step={0.1}
            helperText={texts.cameraHeightEndHint}
            onCommit={(value) =>
              onChange(value === undefined ? setCameraHeight(current, 'end', cameraHeight(current, 'start')) : setCameraHeight(current, 'end', value))
            }
          />
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.5 }} aria-label={texts.cameraHeightPresets}>
            {HEIGHT_PRESETS.map((preset) => (
              <Chip
                key={preset.key}
                size="small"
                variant={cameraHeight(current, 'start') === preset.metres ? 'filled' : 'outlined'}
                color={cameraHeight(current, 'start') === preset.metres ? 'primary' : 'default'}
                label={texts.cameraHeightPreset({ name: texts.heightPresets[preset.key], metres: metres(preset.metres) })}
                disabled={!editable}
                onClick={() => onChange(setCameraHeight(current, 'start', preset.metres))}
              />
            ))}
          </Stack>
        </Stack>
      )}
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
                    ) : locationScheme ? (
                      <ViewpointPlacement
                        viewpoint={viewpoint}
                        scheme={locationScheme}
                        heroes={placeable}
                        linked={linked}
                        nameOf={nameOf}
                        heights={heights}
                        title={texts.cameraWindowTitle({ shot, location: nameOf(viewpoint.location) })}
                        editable={editable}
                        height={Math.max(MIN_MAP_HEIGHT, window.innerHeight - 330)}
                        update={update}
                      />
                    ) : schemes ? (
                      <Alert severity="info">
                        <LinkedText text={texts.noScheme} />
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
