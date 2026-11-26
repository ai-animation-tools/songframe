import { commonTexts } from '@shared/texts/common';
import { componentsTexts } from '@shared/texts/components';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import CloseIcon from '@mui/icons-material/Close';
import { useId, useState, type ReactElement } from 'react';
import {
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
import { ZoomableImage } from './ZoomableImage';

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
 * Общий просмотр изображений без обрезки с увеличением ZoomableImage. Масштаб и место прокрутки сохраняются при
 * листании, чтобы одно место разных изображений сравнивалось подряд; закрытие сбрасывает их. С compare поверх
 * текущего изображения кладётся выбранный слой той же рамки: прозрачность, мигание клавишей С и режим «Разница»
 * показывают сдвиг; оценивает его пользователь.
 */
export function ImageGallery({ images, initialIndex, kind = texts.image, compare, onClose }: ImageGalleryProps): ReactElement {
  const [index, setIndex] = useState(Math.min(initialIndex, images.length - 1));
  /** Выбранный масштаб в процентах; null — вписать. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [compareKey, setCompareKey] = useState('');
  const [opacity, setOpacity] = useState(50);
  const [difference, setDifference] = useState(false);
  const titleId = useId();
  const opacityId = useId();
  const image = images[index];

  const options = compare
    ? [
        ...images.map((item, position) => ({ key: `image-${position}`, image: item, current: position === index })),
        ...(Array.isArray(compare) ? compare : []).map((item, position) => ({ key: `extra-${position}`, image: item, current: false }))
      ]
    : [];
  const overlay = options.find((option) => option.key === compareKey && !option.current)?.image ?? null;

  const navigate = (nextIndex: number): void => {
    if (nextIndex < 0 || nextIndex >= images.length) return;
    setIndex(nextIndex);
    if (compareKey === `image-${nextIndex}`) setCompareKey('');
  };

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
          // Мигание: слой сравнения целиком или его нет — сдвиг виден лучше всего. Одно нажатие — одно переключение:
          // автоповтор зажатой клавиши шлёт десятки keydown в секунду, перерисовка увеличенного слоя за ними не
          // успевает, и окно продолжало бы мигать по накопленной очереди уже после отпускания.
          event.preventDefault();
          if (event.repeat) return;
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
      <DialogContent sx={{ p: 0, mx: 2, minHeight: 0, flex: 1, display: 'flex', overflow: 'hidden' }}>
        <ZoomableImage
          src={imageUrl(image)}
          alt={image.label}
          zoom={zoom}
          onZoomChange={setZoom}
          overlay={overlay ? { src: imageUrl(overlay), alt: texts.compareLayer({ label: overlay.label }), opacity, difference } : null}
        />
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
                    getAriaValueText={(value) => componentsTexts.imageZoom.value({ percent: value })}
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
