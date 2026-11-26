import { commonTexts } from '@shared/texts/common';
import { componentsTexts } from '@shared/texts/components';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import CloseIcon from '@mui/icons-material/Close';
import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Slider,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material';
import { ActionButton } from './ActionButton';

const texts = componentsTexts.gallery;

/** Изображение просмотра. version — метка содержимого (например токен результата): файл по тому же пути пересобран, и WebView не покажет прежний. */
export interface GalleryImage {
  imagePath: string;
  label: string;
  version?: string;
}

interface ImageGalleryProps {
  images: GalleryImage[];
  initialIndex: number;
  /** Подпись вида изображений в заголовке, например «Входное изображение» или «Опора». */
  kind?: string;
  /**
   * Сравнение наложением: true — с другими изображениями этой галереи, массив — ещё и с этими (например снимками
   * схемы композиции к опорам). Без него выбора «Сравнить с» нет.
   */
  compare?: boolean | GalleryImage[];
  onClose(): void;
}

/** Ступени увеличения в процентах исходного размера; первая ступень ползунка — «вписать» в окно. */
const ZOOM_STEPS = [25, 50, 75, 100, 150, 200, 250, 300];
/** Ступень ближе этого к вписанному масштабу не показывается: две отметки слились бы. */
const ZOOM_STEP_GAP = 5;
/** Пропорции, различающиеся меньше этой доли, считаются одинаковыми (округление размеров при генерации). */
const ASPECT_TOLERANCE = 0.01;

interface NaturalSize {
  src: string;
  width: number;
  height: number;
}

function imageUrl(image: GalleryImage): string {
  const url = window.api.shell.fileUrl(image.imagePath);
  return image.version ? `${url}?v=${encodeURIComponent(image.version)}` : url;
}

/** Ползунок, поле и выпадающий список сами обрабатывают стрелки: листать изображения в них нельзя. */
function ownsArrows(target: EventTarget): boolean {
  return target instanceof Element && target.closest('input, textarea, [role="slider"], [role="combobox"], [role="listbox"], [role="menu"]') !== null;
}

/** Буквы забирают только текстовые поля и открытый список (поиск по первой букве); выключатель и ползунок — нет. */
function ownsLetters(target: EventTarget): boolean {
  return target instanceof Element && target.closest('textarea, input[type="text"], input:not([type]), [role="listbox"], [role="menu"]') !== null;
}

/**
 * Общий просмотр изображений без обрезки. Вертикальный ползунок справа увеличивает от «вписать» до 300 % исходного
 * размера (100 % — пиксель в пиксель); увеличенную картинку двигают перетаскиванием и прокруткой, колесо прокручивает.
 * Масштаб и место прокрутки сохраняются при листании, чтобы одно место разных изображений сравнивалось подряд;
 * закрытие сбрасывает их. С compare поверх текущего изображения кладётся выбранный слой той же рамки: прозрачность,
 * мигание клавишей С и режим «Разница» показывают сдвиг; оценивает его пользователь.
 */
export function ImageGallery({ images, initialIndex, kind = texts.image, compare, onClose }: ImageGalleryProps): ReactElement {
  const [index, setIndex] = useState(Math.min(initialIndex, images.length - 1));
  /** Выбранный масштаб в процентах; null — вписать. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [natural, setNatural] = useState<NaturalSize | null>(null);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  /** Точка изображения (доли ширины и высоты) в центре окна до смены масштаба: после неё окно возвращается к ней. */
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [compareKey, setCompareKey] = useState('');
  const [opacity, setOpacity] = useState(50);
  const [difference, setDifference] = useState(false);
  const [overlayNatural, setOverlayNatural] = useState<NaturalSize | null>(null);
  const titleId = useId();
  const opacityId = useId();
  const image = images[index];
  const src = imageUrl(image);

  const options = compare
    ? [
        ...images.map((item, position) => ({ key: `image-${position}`, image: item, current: position === index })),
        ...(Array.isArray(compare) ? compare : []).map((item, position) => ({ key: `extra-${position}`, image: item, current: false }))
      ]
    : [];
  const overlay = options.find((option) => option.key === compareKey && !option.current)?.image ?? null;
  const overlaySrc = overlay ? imageUrl(overlay) : null;

  useEffect(() => {
    if (!viewport) return;
    const update = (): void => setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);

  const size = natural?.src === src ? natural : null;
  const fit =
    size && viewportSize.width && viewportSize.height ? Math.min(100, (100 * viewportSize.width) / size.width, (100 * viewportSize.height) / size.height) : 100;
  const steps = [fit, ...ZOOM_STEPS.filter((step) => step > fit + ZOOM_STEP_GAP)];
  const stepIndex = zoom === null ? 0 : Math.max(0, steps.indexOf(zoom));
  const percent = steps[stepIndex];
  const display = size ? { width: (size.width * percent) / 100, height: (size.height * percent) / 100 } : null;
  const pannable = display !== null && (display.width > viewportSize.width + 1 || display.height > viewportSize.height + 1);
  const overlaySize = overlaySrc && overlayNatural?.src === overlaySrc ? overlayNatural : null;
  const aspectMismatch =
    size && overlaySize ? Math.abs(size.width / size.height - overlaySize.width / overlaySize.height) > ASPECT_TOLERANCE * (size.width / size.height) : false;

  useLayoutEffect(() => {
    const point = anchor.current;
    const box = boxRef.current;
    if (!point || !box || !viewport || !display) return;
    anchor.current = null;
    viewport.scrollLeft = box.offsetLeft + point.x * display.width - viewport.clientWidth / 2;
    viewport.scrollTop = box.offsetTop + point.y * display.height - viewport.clientHeight / 2;
  }, [display?.width, display?.height, viewport]);

  const changeZoom = (next: number): void => {
    const box = boxRef.current;
    if (viewport && box && box.offsetWidth && box.offsetHeight) {
      anchor.current = {
        x: (viewport.scrollLeft + viewport.clientWidth / 2 - box.offsetLeft) / box.offsetWidth,
        y: (viewport.scrollTop + viewport.clientHeight / 2 - box.offsetTop) / box.offsetHeight
      };
    }
    setZoom(next === 0 ? null : steps[next]);
  };

  const navigate = (nextIndex: number): void => {
    if (nextIndex < 0 || nextIndex >= images.length) return;
    setIndex(nextIndex);
    if (compareKey === `image-${nextIndex}`) setCompareKey('');
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !pannable || !viewport) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    if (!start || !viewport) return;
    viewport.scrollLeft = start.left - (event.clientX - start.x);
    viewport.scrollTop = start.top - (event.clientY - start.y);
  };
  const endDrag = (): void => {
    drag.current = null;
    setDragging(false);
  };

  const zoomLabel = (position: number): string =>
    position === 0 ? texts.zoomFit({ percent: Math.round(steps[0]) }) : texts.zoomValue({ percent: steps[position] });

  return (
    <Dialog
      open
      onClose={onClose}
      aria-labelledby={titleId}
      maxWidth={false}
      fullWidth
      slotProps={{ paper: { sx: { width: 'calc(100% - 32px)', height: 'calc(100% - 32px)', maxHeight: 'calc(100% - 32px)', m: 2 } } }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !ownsArrows(event.target)) {
          event.preventDefault();
          navigate(index + (event.key === 'ArrowLeft' ? -1 : 1));
        } else if (event.code === 'KeyC' && overlay && !ownsLetters(event.target)) {
          // Мигание: слой сравнения целиком или его нет — сдвиг виден лучше всего.
          event.preventDefault();
          setOpacity((value) => (value < 100 ? 100 : 0));
        }
      }}
    >
      <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
        <Typography component="span" variant="overline" display="block" color="text.secondary">
          {texts.position({ kind, position: index + 1, total: images.length })}
        </Typography>
        {image.label}
      </DialogTitle>
      {aspectMismatch ? (
        <Alert severity="warning" sx={{ mx: 2, mb: 1 }} data-gallery-aspect="">
          {texts.compareAspect}
        </Alert>
      ) : null}
      <DialogContent sx={{ p: 0, mx: 2, minHeight: 0, flex: 1, display: 'flex', gap: 1, overflow: 'hidden' }}>
        <Box
          ref={setViewport}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          data-gallery-viewport={pannable ? 'pannable' : 'fit'}
          sx={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
            overflow: 'auto',
            bgcolor: 'background.default',
            cursor: pannable ? (dragging ? 'grabbing' : 'grab') : 'default',
            userSelect: 'none'
          }}
        >
          <Box
            sx={{
              width: display ? 'max-content' : '100%',
              height: display ? 'max-content' : '100%',
              minWidth: '100%',
              minHeight: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <Box
              ref={boxRef}
              sx={{
                position: 'relative',
                flexShrink: 0,
                ...(display ? { width: display.width, height: display.height } : { maxWidth: '100%', maxHeight: '100%' })
              }}
            >
              <Box
                component="img"
                src={src}
                alt={image.label}
                draggable={false}
                onLoad={(event) => {
                  const element = event.currentTarget as HTMLImageElement;
                  if (element.naturalWidth && element.naturalHeight) setNatural({ src, width: element.naturalWidth, height: element.naturalHeight });
                }}
                sx={{ display: 'block', ...(display ? { width: '100%', height: '100%' } : { maxWidth: '100%', maxHeight: '100%' }) }}
              />
              {overlay && overlaySrc && display ? (
                <Box
                  component="img"
                  src={overlaySrc}
                  alt={texts.compareLayer({ label: overlay.label })}
                  draggable={false}
                  data-gallery-overlay={difference ? 'difference' : 'normal'}
                  onLoad={(event) => {
                    const element = event.currentTarget as HTMLImageElement;
                    if (element.naturalWidth && element.naturalHeight)
                      setOverlayNatural({ src: overlaySrc, width: element.naturalWidth, height: element.naturalHeight });
                  }}
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    opacity: opacity / 100,
                    mixBlendMode: difference ? 'difference' : 'normal',
                    pointerEvents: 'none'
                  }}
                />
              ) : null}
            </Box>
          </Box>
        </Box>
        <Stack spacing={1} sx={{ width: 104, flexShrink: 0, alignItems: 'flex-start', py: 1, pl: 1 }} data-gallery-zoom="">
          <Typography variant="body2" fontWeight={600} title={percent > 100 ? texts.zoomUpscaleHint : undefined} data-gallery-zoom-value={Math.round(percent)}>
            {texts.zoomValue({ percent: Math.round(percent) })}
          </Typography>
          <Slider
            orientation="vertical"
            size="small"
            min={0}
            max={steps.length - 1}
            step={1}
            value={stepIndex}
            marks={steps.map((step, position) => ({
              value: position,
              label:
                position === 0
                  ? texts.zoomFitMark
                  : step === 100
                    ? texts.zoomOriginal
                    : position === steps.length - 1
                      ? texts.zoomValue({ percent: step })
                      : undefined
            }))}
            disabled={!size || steps.length < 2}
            aria-label={texts.zoom}
            getAriaValueText={zoomLabel}
            valueLabelDisplay="auto"
            valueLabelFormat={zoomLabel}
            onChange={(_, value) => changeZoom(value as number)}
            sx={{ flex: 1, minHeight: 120, '& .MuiSlider-markLabel': { fontSize: 11 } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        {options.length > 1 ? (
          <Stack direction="row" spacing={2} useFlexGap sx={{ mr: 'auto', alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }} data-gallery-compare="">
            <TextField
              select
              size="small"
              label={texts.compareWith}
              value={overlay ? compareKey : ''}
              onChange={(event) => setCompareKey(event.target.value)}
              slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
              sx={{ width: 260 }}
            >
              <MenuItem value="">{texts.compareNone}</MenuItem>
              {options
                .filter((option) => !option.current)
                .map((option) => (
                  <MenuItem key={option.key} value={option.key}>
                    {option.image.label}
                  </MenuItem>
                ))}
            </TextField>
            {overlay ? (
              <>
                <Box sx={{ width: 160 }}>
                  <Typography id={opacityId} variant="caption" color="text.secondary" display="block">
                    {texts.compareOpacity({ percent: opacity })}
                  </Typography>
                  <Slider
                    size="small"
                    min={0}
                    max={100}
                    step={5}
                    value={opacity}
                    aria-labelledby={opacityId}
                    getAriaValueText={(value) => texts.zoomValue({ percent: value })}
                    onChange={(_, value) => setOpacity(value as number)}
                  />
                </Box>
                <FormControlLabel
                  control={
                    <Switch
                      checked={difference}
                      onChange={(_, checked) => {
                        setDifference(checked);
                        // Разница видна только непрозрачным слоем: полупрозрачный смешивает её с исходником.
                        if (checked) setOpacity(100);
                      }}
                    />
                  }
                  label={texts.compareDifference}
                  title={texts.compareDifferenceHint}
                />
                <Typography variant="caption" color="text.secondary" title={texts.compareFlickerHint}>
                  {texts.compareFlickerKey}
                </Typography>
              </>
            ) : null}
          </Stack>
        ) : null}
        <ActionButton
          startIcon={<NavigateBeforeIcon />}
          onClick={() => navigate(index - 1)}
          disabled={index === 0}
          disabledReason={texts.firstImage}
          aria-label={texts.previousImage}
        >
          {commonTexts.back}
        </ActionButton>
        <ActionButton
          startIcon={<NavigateNextIcon />}
          onClick={() => navigate(index + 1)}
          disabled={index === images.length - 1}
          disabledReason={texts.lastImage}
          aria-label={texts.nextImage}
        >
          {commonTexts.next}
        </ActionButton>
        <Button startIcon={<CloseIcon />} onClick={onClose}>
          {commonTexts.close}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
