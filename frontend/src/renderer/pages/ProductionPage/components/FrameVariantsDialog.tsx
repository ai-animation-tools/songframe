import { productionTexts } from '@shared/texts/production';
import { commonTexts } from '@shared/texts/common';
/**
 * Прежние варианты опоры: файлы, которые заменили доработка, свой файл или повторное создание. Миниатюра открывает
 * просмотр с «Сравнить с» текущей опорой, «Вернуть этот вариант» делает его кандидатом опоры через Go
 * (production.restoreFrame): текущий файл при этом сам уходит в прежние варианты, так что возврат обратим.
 */
import { useState, type ReactElement } from 'react';
import RestoreIcon from '@mui/icons-material/Restore';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import type { PackageFrameVariant, PackageKeyframe } from '@shared/types';
import { ActionButton } from '../../../components/ActionButton';
import { ImageGallery } from '../../../components/ImageGallery';
import { ImageThumbnail } from '../../../components/ImageThumbnail';

const texts = productionTexts.packageKeyframes;

/** Время замены варианта для подписи: «26 нояб., 17:20». */
export function variantTime(variant: PackageFrameVariant): string {
  const date = new Date(variant.savedAt);
  if (Number.isNaN(date.getTime())) return variant.savedAt;
  return date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function FrameVariantsDialog({
  frame,
  disabledReason,
  onRestore,
  onClose
}: {
  frame: PackageKeyframe;
  /** Почему вернуть вариант сейчас нельзя (занято, промпт утверждён, копия); null — можно. */
  disabledReason: string | null;
  onRestore(variant: string): void;
  onClose(): void;
}): ReactElement {
  const [viewing, setViewing] = useState<number | null>(null);
  const variants = frame.variants ?? [];
  const titleId = `frame-variants-${frame.id}`;
  return (
    <Dialog open fullWidth maxWidth="md" onClose={onClose} aria-labelledby={titleId}>
      <DialogTitle id={titleId}>{texts.variantsTitle({ id: frame.id })}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {texts.variantsIntro({ id: frame.id })}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          {variants.map((variant, index) => (
            <Box key={variant.name} sx={{ width: 240, minWidth: 0 }} data-frame-variant={variant.name}>
              <ImageThumbnail
                path={variant.imagePath}
                label={texts.variantLabel({ id: frame.id, time: variantTime(variant) })}
                title={variant.imagePath}
                fit="cover"
                dashed
                onOpen={() => setViewing(index)}
              />
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                {texts.variantSaved({ time: variantTime(variant) })}
              </Typography>
              <ActionButton
                size="small"
                startIcon={<RestoreIcon />}
                sx={{ mt: 0.5 }}
                title={texts.restoreHint({ id: frame.id })}
                disabled={!!disabledReason}
                disabledReason={disabledReason}
                onClick={() => onRestore(variant.name)}
              >
                {texts.restore}
              </ActionButton>
            </Box>
          ))}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{commonTexts.close}</Button>
      </DialogActions>
      {viewing !== null ? (
        <ImageGallery
          kind={texts.variantsGalleryKind}
          images={variants.map((variant) => ({ imagePath: variant.imagePath, label: texts.variantLabel({ id: frame.id, time: variantTime(variant) }) }))}
          initialIndex={viewing}
          compare={frame.imagePath ? [{ imagePath: frame.imagePath, label: texts.variantCurrent({ id: frame.id }) }] : undefined}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </Dialog>
  );
}
