/**
 * Принятый план без рабочей попытки: вместо пути шагов — один блок «Принятый комплект». Приёмка удаляет пакет
 * попытки, и шаги пути считались бы по пустоте («опор 0»), поэтому показывается то, что сохранено в комплекте
 * assets/shots/Mxx: принятое видео, как оно получено (сервис или ручная генерация с источником и примечанием),
 * опоры, видеопромпт и срез речи. Сведения читает Go (production.acceptedKit) при показе; новая попытка
 * возвращает обычный путь шагов.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { commonTexts } from '@shared/texts/common';
import { productionTexts } from '@shared/texts/production';
import { mediaProviderInfo } from '@shared/media-providers';
import type { AcceptedKit, ShotProduction } from '@shared/types';
import { useApp } from '../../../state';
import { AudioPlayer } from '../../../components/AudioPlayer';
import { ImageGallery } from '../../../components/ImageGallery';
import { ImageThumbnail } from '../../../components/ImageThumbnail';
import { AcceptedAsset } from './AcceptedAsset';
import { ManualGenerationInfo } from './ManualGeneration';
import { PackageTextSection } from './PackageTextSection';
import { SpeechSlice } from './ProductionSpeechPanel';

const texts = productionTexts.acceptedKit;

/** Строка источника: ручная генерация со своими сведениями, иначе сервис провайдера и номер генерации. */
function KitSource({ kit }: { kit: AcceptedKit }): ReactElement {
  if (kit.manualGeneration) return <ManualGenerationInfo record={kit.manualGeneration} />;
  const provider = mediaProviderInfo(kit.provider, 'video')?.title ?? kit.provider;
  return <Typography variant="body2">{provider ? texts.provider({ provider, id: kit.generationId }) : texts.noSource}</Typography>;
}

export function AcceptedKitPanel({ project, shot }: { project: string; shot: ShotProduction }): ReactElement | null {
  const { notify, describeError } = useApp();
  const [kit, setKit] = useState<AcceptedKit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setKit(null);
    setError(null);
    window.api.production
      .acceptedKit(project, shot.id)
      .then((next) => {
        if (active) setKit(next);
      })
      .catch((reason: unknown) => {
        if (active) setError(texts.loadFailed({ reason: describeError(reason) }));
      });
    return () => {
      active = false;
    };
  }, [project, shot.id, describeError]);

  if (!shot.asset) return null;
  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      notify(commonTexts.copied, 'success');
    } catch (reason) {
      notify(describeError(reason), 'error');
    }
  };
  const speech = kit?.speech ?? null;
  const gallery = (kit?.images ?? []).map((imagePath, index) => ({ imagePath, label: texts.image({ index: index + 1 }) }));

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="subtitle1" fontWeight={600}>
          {texts.heading}
        </Typography>
        <AcceptedAsset asset={shot.asset} title={null} />
        {error ? <Alert severity="error">{error}</Alert> : null}
        {kit ? (
          <>
            <Stack spacing={0.5}>
              <Typography variant="subtitle2">{texts.source}</Typography>
              {kit.ownVideo ? <Typography variant="body2">{texts.ownVideo}</Typography> : null}
              <KitSource kit={kit} />
            </Stack>
            {kit.images.length ? (
              <Stack spacing={1}>
                <Typography variant="subtitle2">{texts.images}</Typography>
                {/* Как опоры в пакете попытки: миниатюра открывает общий просмотр изображений. */}
                <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                  {gallery.map((image, index) => (
                    <Box key={image.imagePath} sx={{ width: 220, minWidth: 0 }}>
                      <ImageThumbnail path={image.imagePath} label={image.label} title={image.imagePath} fit="cover" onOpen={() => setActive(index)} />
                    </Box>
                  ))}
                </Box>
              </Stack>
            ) : null}
            {kit.prompt ? (
              <Box>
                <PackageTextSection title={texts.prompt} text={kit.prompt} maxHeight={220} />
                <Button size="small" startIcon={<ContentCopyIcon />} title={texts.copyHint} onClick={() => void copy(kit.prompt!)} sx={{ mt: -1 }}>
                  {texts.copy}
                </Button>
              </Box>
            ) : null}
            {speech ? (
              <Stack spacing={1}>
                <Typography variant="subtitle2">{texts.speech}</Typography>
                {/* Тот же блок среза, что в шагах «Речь» и «Запрос»; без рецепта границ нет — только плеер. */}
                {speech.start !== null && speech.end !== null ? (
                  <SpeechSlice speech={{ path: speech.path, recipe: '', start: speech.start, end: speech.end, lines: [] }} />
                ) : (
                  <Box sx={{ maxWidth: 520 }}>
                    <AudioPlayer src={window.api.shell.fileUrl(speech.path)} />
                  </Box>
                )}
              </Stack>
            ) : null}
          </>
        ) : null}
      </Stack>
      {active !== null && gallery.length ? (
        <ImageGallery kind={productionTexts.packageKeyframes.galleryKind} images={gallery} initialIndex={active} onClose={() => setActive(null)} />
      ) : null}
    </Paper>
  );
}
