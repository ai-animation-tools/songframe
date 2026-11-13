import { productionTexts } from '@shared/texts/production';
/** Принятое видео плана на шаге «Результат»; у приёмки с обработкой рядом показывается оригинал. */
import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Box, Chip, Typography } from '@mui/material';
import type { AssetEdit, ShotProduction } from '@shared/types';
import { VideoPlayer } from './VideoPlayer';

const recipeTexts = productionTexts.productionShotCard.recipe;

/**
 * Параметры принятого участка в том же виде, что у оригинала, и что взято из оригинала:
 * «1920×1080, 30/1 FPS, кадров: 102, 3.40 с · участок оригинала 0.00–3.40 с». Частота, кадры и длина —
 * из манифеста комплекта; размер кадра манифест не хранит, его сообщает само видео (null — ещё не загружено).
 */
export function acceptedCaption(edit: AssetEdit, size: { width: number; height: number } | null): string {
  const source = [
    edit.stillAt !== null
      ? recipeTexts.still({ time: edit.stillAt.toFixed(2) })
      : edit.sourceInterval
        ? recipeTexts.interval({ start: edit.sourceInterval[0].toFixed(2), end: edit.sourceInterval[1].toFixed(2) })
        : recipeTexts.wholeOriginal,
    edit.speed && edit.speed !== '1' ? recipeTexts.speed({ speed: edit.speed }) : null,
    edit.holdFirst ? recipeTexts.holdFirst({ duration: edit.holdFirst }) : null,
    edit.holdLast ? recipeTexts.holdLast({ duration: edit.holdLast }) : null
  ]
    .filter(Boolean)
    .join(', ');
  const media = recipeTexts.media({
    width: size?.width ?? null,
    height: size?.height ?? null,
    fps: edit.fps,
    frames: edit.frames,
    duration: edit.duration.toFixed(2)
  });
  return `${media} · ${source}`;
}

/** Бейдж нужен, только когда видео два: иначе различать нечего. Под плеером — параметры видео. */
function LabeledVideo({
  path,
  label,
  color,
  caption
}: {
  path: string;
  label: string | null;
  color: 'info' | 'success';
  /** Подпись под плеером; функция получает размер кадра, когда видео загрузило метаданные. */
  caption: string | null | ((size: { width: number; height: number } | null) => string);
}): ReactElement {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  // Плеер вызывает ref при каждой отрисовке: узел хранится состоянием (тот же узел не перерисовывает),
  // а размер читается подпиской на метаданные и меняется, только если кадр другой.
  const [node, setNode] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!node) return;
    const update = (): void => {
      const width = node.videoWidth;
      const height = node.videoHeight;
      if (width && height) setSize((current) => (current?.width === width && current.height === height ? current : { width, height }));
    };
    update();
    node.addEventListener('loadedmetadata', update);
    return () => node.removeEventListener('loadedmetadata', update);
  }, [node]);
  const text = typeof caption === 'function' ? caption(size) : caption;
  return (
    <Box sx={{ minWidth: 0 }}>
      {label ? <Chip size="small" color={color} label={label} sx={{ mb: 1 }} /> : null}
      <VideoPlayer path={path} videoRef={typeof caption === 'function' ? setNode : undefined} />
      {text ? (
        <Typography component="p" variant="caption" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
          {text}
        </Typography>
      ) : null}
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
      {/* Оригинал слева, принятый участок справа; при узкой области — друг под другом. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: original && asset.video ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)' },
          gap: 2,
          alignItems: 'start'
        }}
      >
        {original ? (
          <LabeledVideo path={original} label={productionTexts.productionShotCard.originalVideo} color="info" caption={asset.originalMedia ?? null} />
        ) : null}
        {asset.video ? (
          <LabeledVideo
            path={asset.video}
            label={original ? productionTexts.productionShotCard.acceptedVideo : null}
            color="success"
            caption={asset.edit ? (size) => acceptedCaption(asset.edit!, size) : null}
          />
        ) : null}
      </Box>
    </Box>
  );
}
