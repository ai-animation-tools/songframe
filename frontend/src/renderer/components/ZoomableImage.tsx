/**
 * Изображение крупного просмотра с увеличением: вписанное в доступную область без обрезки, вертикальный ползунок
 * справа ступенями увеличивает его до 300 % исходного размера (100 % — пиксель в пиксель). Увеличенное двигают
 * перетаскиванием и прокруткой, колесо прокручивает; при смене масштаба точка в центре окна остаётся на месте.
 * Масштаб хранит владелец (ImageGallery, окно материала «Монтажа»): он держит его при листании и сбрасывает при
 * закрытии. Необязательный слой сравнения лежит поверх в той же рамке без растягивания.
 */
import { componentsTexts } from '@shared/texts/components';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import { Alert, Box, Slider, Stack, Typography } from '@mui/material';

const texts = componentsTexts.imageZoom;

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

/** Слой сравнения: прозрачность 0–100 %, difference — режим «Разница» (совпадающее чернеет). */
export interface ZoomOverlay {
  src: string;
  alt: string;
  opacity: number;
  difference: boolean;
}

function naturalOf(src: string, element: HTMLImageElement): NaturalSize | null {
  return element.naturalWidth && element.naturalHeight ? { src, width: element.naturalWidth, height: element.naturalHeight } : null;
}

export function ZoomableImage({
  src,
  alt,
  zoom,
  onZoomChange,
  overlay,
  onError
}: {
  src: string;
  alt: string;
  /** Выбранная ступень в процентах; null — вписать. Ступень ниже вписанного масштаба нового изображения — тоже вписать. */
  zoom: number | null;
  onZoomChange(zoom: number | null): void;
  overlay?: ZoomOverlay | null;
  /** Файл не загрузился: владелец показывает ошибку. */
  onError?(): void;
}): ReactElement {
  const [natural, setNatural] = useState<NaturalSize | null>(null);
  const [overlayNatural, setOverlayNatural] = useState<NaturalSize | null>(null);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  /** Точка изображения (доли ширины и высоты) в центре окна до смены масштаба: после неё окно возвращается к ней. */
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

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
  const overlaySize = overlay && overlayNatural?.src === overlay.src ? overlayNatural : null;
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
    onZoomChange(next === 0 ? null : steps[next]);
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
    position === 0 ? texts.fitValue({ percent: Math.round(steps[0]) }) : texts.value({ percent: steps[position] });

  return (
    <Stack spacing={1} sx={{ flex: 1, minHeight: 0, minWidth: 0, width: '100%' }}>
      {aspectMismatch ? (
        <Alert severity="warning" data-zoom-aspect="">
          {texts.aspect}
        </Alert>
      ) : null}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', gap: 1 }}>
        <Box
          ref={setViewport}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          data-zoom-viewport={pannable ? 'pannable' : 'fit'}
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
                alt={alt}
                draggable={false}
                onLoad={(event) => setNatural(naturalOf(src, event.currentTarget as HTMLImageElement))}
                onError={onError}
                sx={{ display: 'block', ...(display ? { width: '100%', height: '100%' } : { maxWidth: '100%', maxHeight: '100%' }) }}
              />
              {overlay && display ? (
                <Box
                  component="img"
                  src={overlay.src}
                  alt={overlay.alt}
                  draggable={false}
                  data-zoom-overlay={overlay.difference ? 'difference' : 'normal'}
                  onLoad={(event) => setOverlayNatural(naturalOf(overlay.src, event.currentTarget as HTMLImageElement))}
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    opacity: overlay.opacity / 100,
                    mixBlendMode: overlay.difference ? 'difference' : 'normal',
                    pointerEvents: 'none'
                  }}
                />
              ) : null}
            </Box>
          </Box>
        </Box>
        <Stack spacing={1} sx={{ width: 104, flexShrink: 0, alignItems: 'flex-start', py: 1, pl: 1 }} data-zoom="">
          <Typography variant="body2" fontWeight={600} title={percent > 100 ? texts.upscaleHint : undefined} data-zoom-value={Math.round(percent)}>
            {texts.value({ percent: Math.round(percent) })}
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
              label: position === 0 ? texts.fitMark : step === 100 ? texts.original : position === steps.length - 1 ? texts.value({ percent: step }) : undefined
            }))}
            disabled={!size || steps.length < 2}
            aria-label={texts.label}
            getAriaValueText={zoomLabel}
            valueLabelDisplay="auto"
            valueLabelFormat={zoomLabel}
            onChange={(_, value) => changeZoom(value as number)}
            sx={{ flex: 1, minHeight: 120, '& .MuiSlider-markLabel': { fontSize: 11 } }}
          />
        </Stack>
      </Box>
    </Stack>
  );
}
