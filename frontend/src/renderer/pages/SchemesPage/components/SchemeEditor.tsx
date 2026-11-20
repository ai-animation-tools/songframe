import { schemesTexts } from '@shared/texts/schemes';
import { commonTexts } from '@shared/texts/common';
import { useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import { Alert, AlertTitle, Box, Paper, Stack, Tab, Tabs, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CropSquareIcon from '@mui/icons-material/CropSquare';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import NearMeIcon from '@mui/icons-material/NearMe';
import PentagonOutlinedIcon from '@mui/icons-material/PentagonOutlined';
import PlaceIcon from '@mui/icons-material/Place';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import { SCHEME_VIEWS, type Scheme, type SchemeLocation, type SchemeViewKind } from '@shared/schemes';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { ObjectProperties } from './ObjectProperties';
import { MIN_CANVAS_HEIGHT, SchemeCanvas, type SchemeTool } from './SchemeCanvas';
import { SchemeVolumeView } from '../../../components/SchemeVolumeView';

const TOOL_ICONS: Record<SchemeTool, ReactElement> = {
  select: <NearMeIcon fontSize="small" />,
  rect: <CropSquareIcon fontSize="small" />,
  ellipse: <RadioButtonUncheckedIcon fontSize="small" />,
  polygon: <PentagonOutlinedIcon fontSize="small" />,
  line: <ShowChartIcon fontSize="small" />,
  point: <PlaceIcon fontSize="small" />
};
const TOOLS = Object.keys(TOOL_ICONS) as SchemeTool[];

/** Ширина редактора, с которой свойства объекта встают справа от холста, а не под ним, px. */
const SIDE_PANEL_FROM = 1020;
/** Ширина боковой панели свойств, px. */
const SIDE_PANEL_WIDTH = 360;
/** Зазор под холстом до края окна, px: столько же оставляет закреплённая карточка ListDetailLayout. */
const BOTTOM_GAP = 20;
/** Ширина рабочей области, с которой ListDetailLayout прокручивает карточку внутри себя (его контейнерный запрос). */
const DETAIL_SCROLLS = '@container workspace (min-width: 1100px)';

/**
 * Размеры редактора: ширина области (место свойств — справа или под холстом) и высота холста. Холст забирает
 * всю высоту окна под закреплённой карточкой страницы, считая от своего верха: вкладки, панель инструментов
 * и холст помещаются в окно без прокрутки. Следит за окном и содержимым: перенос кнопок меняет высоту панели.
 */
function useEditorLayout(
  stickyTop: number,
  hasCanvas: boolean
): {
  rootRef: RefObject<HTMLDivElement | null>;
  toolbarRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLDivElement | null>;
  wide: boolean;
  canvasHeight: number;
} {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, offset: 0, window: typeof window === 'undefined' ? 860 : window.innerHeight });
  useLayoutEffect(() => {
    const update = (): void => {
      const root = rootRef.current?.getBoundingClientRect();
      const canvas = canvasRef.current?.getBoundingClientRect();
      const toolbar = toolbarRef.current?.getBoundingClientRect();
      // Карточка прокручивается сама (широкая область): в окно должно войти всё от верха редактора до холста.
      // Иначе прокручивается страница, вкладки уходят вверх, и над холстом остаётся только закреплённая панель.
      const parent = rootRef.current?.parentElement;
      const ownScroll = !!parent && getComputedStyle(parent).overflowY === 'auto';
      const next = {
        width: Math.round(root?.width ?? 0),
        offset: Math.round(ownScroll ? (root && canvas ? canvas.top - root.top : 0) : (toolbar?.height ?? 0) + 12),
        window: window.innerHeight
      };
      setSize((current) => (current.width === next.width && current.offset === next.offset && current.window === next.window ? current : next));
    };
    const observer = new ResizeObserver(update);
    if (rootRef.current) {
      observer.observe(rootRef.current);
      for (const child of Array.from(rootRef.current.children)) observer.observe(child);
    }
    window.addEventListener('resize', update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
    // Холст и панель появляются вместе со схемой: наблюдение подключается заново.
  }, [hasCanvas]);
  return {
    rootRef,
    toolbarRef,
    canvasRef,
    wide: size.width >= SIDE_PANEL_FROM,
    canvasHeight: Math.max(MIN_CANVAS_HEIGHT, size.window - stickyTop - size.offset - BOTTOM_GAP)
  };
}

/**
 * Схемы одной локации: вкладки видов, создание недостающей схемы, название, удаление, холст с инструментами
 * и свойства выбранного объекта. Все правки — в черновике страницы; запись — общей кнопкой «Сохранить».
 * На странице редактор предлагает открыться во весь экран (onFullscreen); в окне (inDialog) панель инструментов
 * липнет к верху прокрутки окна, а stickyTop — высота шапки окна над ней.
 */
export function SchemeEditor({
  location,
  locations,
  schemes,
  view,
  onView,
  onCreate,
  onChange,
  onDelete,
  onFullscreen,
  inDialog = false,
  viewStorage,
  stickyTop
}: {
  location: SchemeLocation;
  locations: readonly SchemeLocation[];
  /** Схемы этой локации. */
  schemes: readonly Scheme[];
  view: SchemeViewKind;
  onView(view: SchemeViewKind): void;
  onCreate(view: SchemeViewKind, title: string): void;
  onChange(scheme: Scheme): void;
  onDelete(scheme: Scheme): void;
  /** Открыть редактор во весь экран; нет — кнопки нет (редактор уже в окне). */
  onFullscreen?(): void;
  inDialog?: boolean;
  /** Префикс ключа localStorage, под которым холст запоминает вид каждой схемы. */
  viewStorage?: string;
  /** Отступ закреплённой панели инструментов под шапкой и панелью действий страницы. */
  stickyTop: number;
}): ReactElement {
  const scheme = schemes.find((item) => item.view === view) ?? null;
  const [title, setTitle] = useState('');
  const [tool, setTool] = useState<SchemeTool>('select');
  const [selected, setSelected] = useState<string | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Вид сверху показывается планом для правки или объёмом в 3D; свойства объекта доступны в обоих.
  const [volume, setVolume] = useState(false);
  const showVolume = volume && view === 'top';
  const object = scheme?.objects.find((item) => item.id === selected) ?? null;
  const name = location.name || location.id;
  const { rootRef, toolbarRef, canvasRef, wide, canvasHeight } = useEditorLayout(stickyTop, !!scheme);

  return (
    <Stack ref={rootRef} spacing={1.5} sx={{ minWidth: 0 }}>
      <Typography variant="h6">{name}</Typography>
      <Tabs
        value={view}
        onChange={(_, next: SchemeViewKind) => (setSelected(null), setTool('select'), onView(next))}
        variant="scrollable"
        allowScrollButtonsMobile
      >
        {SCHEME_VIEWS.map((item) => {
          const exists = schemes.some((candidate) => candidate.view === item);
          return (
            <Tab
              key={item}
              value={item}
              label={schemesTexts.views[item]}
              // Вида ещё нет: значок «добавить» вместо приглушённого цвета, который не проходит по контрасту.
              icon={exists ? undefined : <AddIcon fontSize="small" />}
              iconPosition="end"
            />
          );
        })}
      </Tabs>
      <Typography variant="body2" color="text.secondary">
        {schemesTexts.viewHints[view]}
      </Typography>
      {!scheme ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1.5} sx={{ maxWidth: 520 }}>
            <Typography variant="subtitle1">{schemesTexts.createTitle({ view: schemesTexts.views[view] })}</Typography>
            <TextField size="small" label={schemesTexts.createName} value={title} onChange={(event) => setTitle(event.target.value)} />
            <Box>
              <ActionButton
                variant="contained"
                color="success"
                startIcon={<AddIcon />}
                disabled={!title.trim()}
                disabledReason={title.trim() ? null : schemesTexts.createName}
                onClick={() => {
                  onCreate(view, title);
                  setTitle('');
                }}
              >
                {schemesTexts.create}
              </ActionButton>
            </Box>
          </Stack>
        </Paper>
      ) : (
        <>
          {/* Панель инструментов закреплена под панелью действий страницы, как шкала на «Таймингах». */}
          <Paper
            ref={toolbarRef}
            variant="outlined"
            sx={{
              p: 1,
              position: 'sticky',
              top: inDialog ? 0 : stickyTop,
              zIndex: (theme) => theme.zIndex.appBar - 2,
              bgcolor: 'background.paper',
              // В широкой области карточка прокручивается сама: панель липнет к её верху.
              [DETAIL_SCROLLS]: { top: 0 }
            }}
          >
            <Stack spacing={1}>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                <TextField
                  size="small"
                  label={schemesTexts.schemeTitle}
                  value={scheme.title}
                  error={!scheme.title.trim()}
                  onChange={(event) => onChange({ ...scheme, title: event.target.value })}
                  sx={{ minWidth: 280 }}
                />
                {view === 'top' ? (
                  <ToggleButtonGroup
                    size="small"
                    exclusive
                    value={showVolume ? 'volume' : 'plan'}
                    onChange={(_, next: 'plan' | 'volume' | null) => next && setVolume(next === 'volume')}
                    aria-label={schemesTexts.display}
                  >
                    <ToggleButton value="plan">{schemesTexts.displayPlan}</ToggleButton>
                    <ToggleButton value="volume" data-volume-toggle="">
                      {schemesTexts.displayVolume}
                    </ToggleButton>
                  </ToggleButtonGroup>
                ) : null}
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  disabled={showVolume}
                  value={tool}
                  onChange={(_, next: SchemeTool | null) => next && setTool(next)}
                  aria-label={schemesTexts.tools.select}
                >
                  {TOOLS.map((item) => (
                    <Tooltip key={item} title={schemesTexts.tools[item]}>
                      <ToggleButton value={item} aria-label={schemesTexts.tools[item]}>
                        {TOOL_ICONS[item]}
                      </ToggleButton>
                    </Tooltip>
                  ))}
                </ToggleButtonGroup>
                <ActionButton
                  startIcon={<FitScreenIcon />}
                  disabled={showVolume}
                  disabledReason={showVolume ? schemesTexts.volumeView.noFit : null}
                  onClick={() => setFitSignal((value) => value + 1)}
                >
                  {schemesTexts.fit}
                </ActionButton>
                {onFullscreen ? (
                  <ActionButton startIcon={<OpenInFullIcon />} onClick={onFullscreen}>
                    {commonTexts.fullscreen.open}
                  </ActionButton>
                ) : null}
                <Box sx={{ flex: 1 }} />
                <ActionButton color="error" startIcon={<DeleteOutlineIcon />} onClick={() => setConfirmDelete(true)}>
                  {schemesTexts.deleteScheme}
                </ActionButton>
              </Stack>
              <Alert severity="info" variant="outlined" sx={{ py: 0 }}>
                <AlertTitle sx={{ mb: 0 }}>{showVolume ? schemesTexts.displayVolume : schemesTexts.tools[tool]}</AlertTitle>
                {showVolume ? schemesTexts.volumeView.modeHint : schemesTexts.toolHints[tool]}
              </Alert>
            </Stack>
          </Paper>
          <Box
            ref={canvasRef}
            sx={
              wide
                ? { display: 'grid', gridTemplateColumns: `minmax(0, 1fr) ${SIDE_PANEL_WIDTH}px`, gap: 1.5, alignItems: 'start' }
                : { display: 'grid', gap: 1.5 }
            }
          >
            {showVolume ? (
              <SchemeVolumeView
                scheme={scheme}
                label={schemesTexts.volumeView.label({ title: scheme.title })}
                height={canvasHeight}
                selected={selected}
                onSelect={setSelected}
                viewKey={viewStorage ? `${viewStorage}.${scheme.id}.volume` : undefined}
              />
            ) : (
              <SchemeCanvas
                scheme={scheme}
                tool={tool}
                selected={selected}
                fitSignal={fitSignal}
                viewKey={viewStorage ? `${viewStorage}.${scheme.id}` : undefined}
                height={canvasHeight}
                onSelect={setSelected}
                onChange={onChange}
                onToolCancel={() => setTool('select')}
              />
            )}
            {/* Справа от холста свойства прокручиваются сами в его высоту: страница не уезжает под закреплённую панель. */}
            <Box sx={wide ? { maxHeight: canvasHeight, overflowY: 'auto' } : undefined} data-object-properties="">
              <ObjectProperties
                object={object}
                volume={view === 'top'}
                locations={locations.filter((item) => item.id !== location.id)}
                onChange={(next) => onChange({ ...scheme, objects: scheme.objects.map((item) => (item.id === next.id ? next : item)) })}
                onDelete={() => {
                  onChange({ ...scheme, objects: scheme.objects.filter((item) => item.id !== selected) });
                  setSelected(null);
                }}
              />
            </Box>
          </Box>
          <ConfirmationDialog
            open={confirmDelete}
            title={schemesTexts.deleteSchemeTitle({ title: scheme.title || schemesTexts.views[view] })}
            description={schemesTexts.deleteSchemeText}
            confirmLabel={schemesTexts.deleteScheme}
            confirmIcon={<DeleteOutlineIcon />}
            confirmColor="error"
            onClose={() => setConfirmDelete(false)}
            onConfirm={() => {
              setConfirmDelete(false);
              setSelected(null);
              onDelete(scheme);
            }}
          />
        </>
      )}
    </Stack>
  );
}
