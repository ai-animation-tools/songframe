import { productionTexts } from '@shared/texts/production';
/** Принятое видео плана на шаге «Результат»; у приёмки с обработкой рядом показывается оригинал. */
import type { ReactElement } from 'react';
import { Alert, Box, Chip, Typography } from '@mui/material';
import type { ShotProduction } from '@shared/types';
import { VideoPlayer } from './VideoPlayer';

/** Подпись нужна, только когда видео два: иначе различать нечего. */
function LabeledVideo({ path, label, color }: { path: string; label: string | null; color: 'success' | 'info' }): ReactElement {
  return (
    <Box sx={{ minWidth: 0 }}>
      {label ? <Chip size="small" color={color} label={label} sx={{ mb: 1 }} /> : null}
      <VideoPlayer path={path} />
    </Box>
  );
}

/** title — заголовок блока; null, когда блок вложен в «Принятый комплект» с собственным заголовком. */
export function AcceptedAsset({
  asset,
  title = productionTexts.productionShotCard.accepted
}: {
  asset: NonNullable<ShotProduction['asset']>;
  title?: string | null;
}): ReactElement {
  const original = asset.original && asset.original !== asset.video ? asset.original : null;
  return (
    <Box>
      {title ? (
        <Typography variant="subtitle2" gutterBottom>
          {title}
        </Typography>
      ) : null}
      {!asset.video ? (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {productionTexts.productionShotCard.missingVideo}
        </Alert>
      ) : null}
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        {asset.video ? <LabeledVideo path={asset.video} label={original ? productionTexts.productionShotCard.acceptedVideo : null} color="success" /> : null}
        {original ? <LabeledVideo path={original} label={productionTexts.productionShotCard.originalVideo} color="info" /> : null}
      </Box>
    </Box>
  );
}
