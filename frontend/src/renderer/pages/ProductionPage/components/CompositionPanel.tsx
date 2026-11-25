/**
 * «Схема композиции» в шаге опор плана с точкой съёмки: выключатель снимка вида из камеры и сам снимок, который
 * уйдёт агенту вместе с опорой. Снимок рисует и сохраняет useProductionWorkflow, как только он включён, а свежего
 * нет; здесь видно, готов ли он, и миниатюры открывают общий просмотр изображений. Без onToggle — пройденный шаг
 * опор: только снимок, по которому создавались опоры, для сравнения с ними; выключатель возвращается вместе с шагом,
 * когда опору отправляют на доработку.
 */
import { useState, type ReactElement } from 'react';
import { Box, Chip, FormControlLabel, Paper, Stack, Switch, Typography } from '@mui/material';
import { productionTexts } from '@shared/texts/production';
import type { ProductionComposition } from '@shared/production-workflow';
import { ImageGallery } from '../../../components/ImageGallery';
import { ImageThumbnail } from '../../../components/ImageThumbnail';

const texts = productionTexts.composition;

export function CompositionPanel({
  composition,
  busy,
  onToggle
}: {
  composition: ProductionComposition;
  /** У плана идёт операция: выключатель недоступен. */
  busy?: boolean;
  /** Переключение снимка; без него панель только показывает снимок. */
  onToggle?(enabled: boolean): void;
}): ReactElement {
  const [active, setActive] = useState<number | null>(null);
  const gallery = composition.frames.map((frame) => ({ imagePath: frame.path, label: texts.phases[frame.phase] }));
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }} data-composition={composition.enabled ? 'on' : 'off'}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          {onToggle ? (
            <FormControlLabel
              control={<Switch checked={composition.enabled} disabled={busy} onChange={(_, checked) => onToggle(checked)} />}
              label={texts.label}
            />
          ) : (
            <Typography variant="subtitle2">{texts.label}</Typography>
          )}
          {!onToggle ? null : composition.enabled ? (
            <Chip
              size="small"
              color={gallery.length ? 'success' : 'default'}
              variant="outlined"
              label={gallery.length ? texts.ready : texts.updating}
              data-composition-state={gallery.length ? 'ready' : 'updating'}
            />
          ) : (
            <Typography variant="body2" color="text.secondary">
              {texts.off}
            </Typography>
          )}
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {onToggle ? texts.hint : texts.usedHint}
        </Typography>
        {composition.enabled && gallery.length ? (
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            {gallery.map((image, index) => (
              <Box key={image.imagePath} sx={{ width: 220, minWidth: 0 }}>
                <ImageThumbnail path={image.imagePath} label={image.label} title={image.imagePath} fit="cover" onOpen={() => setActive(index)} />
                <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                  {image.label}
                </Typography>
              </Box>
            ))}
          </Box>
        ) : null}
      </Stack>
      {active !== null && gallery.length ? (
        <ImageGallery kind={texts.galleryKind} images={gallery} initialIndex={active} onClose={() => setActive(null)} />
      ) : null}
    </Paper>
  );
}
