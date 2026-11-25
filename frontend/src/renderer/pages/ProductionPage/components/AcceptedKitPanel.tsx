/**
 * Принятый план без рабочей попытки: вместо пути шагов — один блок «Принятый комплект». Приёмка удаляет пакет
 * попытки, и шаги пути считались бы по пустоте («опор 0»), поэтому показывается то, что сохранено в комплекте
 * assets/shots/Mxx: принятое видео, как оно получено (сервис или ручная генерация с источником и примечанием),
 * опоры в порядке входов генерации с ролью по позиции (как роли по умолчанию у своего видео), видеопромпт
 * (с переводом — оба варианта переключателем, «Скопировать» копирует показанный) и срез речи. Сведения читает Go
 * (production.acceptedKit) при показе; новая попытка возвращает обычный путь шагов. У своего видео опоры и промпт есть, только если их указали при загрузке; тогда они
 * показываются так же, как у генерации, а пустой промпт не показывается. «Открыть папку» показывает папку комплекта
 * в файловом менеджере ОС. «Изменить участок» открывает окно приёмки с прежним участком: тот же оригинал
 * комплекта принимается заново с другими границами, скоростью и удержаниями. «Взять текущий кадр» рядом с «На весь экран»
 * плеера «Принятый участок» сохраняет кадр, на котором стоит этот плеер, в PNG полного размера вне клипа
 * (production.takeFrame): кадр берётся из видео без эффектов; после сохранения — путь и «Открыть папку» с кадрами клипа.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { commonTexts } from '@shared/texts/common';
import { productionTexts } from '@shared/texts/production';
import { mediaProviderInfo } from '@shared/media-providers';
import type { AcceptedFrame, AcceptedKit, PromptVariant, ShotProduction } from '@shared/types';
import { useApp } from '../../../state';
import { ActionButton } from '../../../components/ActionButton';
import { AudioPlayer } from '../../../components/AudioPlayer';
import { ImageGallery } from '../../../components/ImageGallery';
import { ImageThumbnail } from '../../../components/ImageThumbnail';
import { AcceptedAsset } from './AcceptedAsset';
import { ManualGenerationInfo } from './ManualGeneration';
import { PromptVariantsText, promptVariantText } from './PromptVariantsText';
import { SpeechSlice } from './ProductionSpeechPanel';
import { defaultRole } from '../ownVideoGeneration';

const texts = productionTexts.acceptedKit;

/** Строка источника: ручная генерация со своими сведениями, иначе сервис провайдера и номер генерации. */
function KitSource({ kit }: { kit: AcceptedKit }): ReactElement {
  if (kit.manualGeneration) return <ManualGenerationInfo record={kit.manualGeneration} />;
  const provider = mediaProviderInfo(kit.provider, 'video')?.title ?? kit.provider;
  return <Typography variant="body2">{provider ? texts.provider({ provider, id: kit.generationId }) : texts.noSource}</Typography>;
}

export function AcceptedKitPanel({
  project,
  shot,
  busy = false,
  busyReason,
  onRecut
}: {
  project: string;
  shot: ShotProduction;
  /** У плана идёт операция: участок менять нельзя. */
  busy?: boolean;
  busyReason?: string;
  onRecut?(): void;
}): ReactElement | null {
  const { notify, describeError } = useApp();
  const [kit, setKit] = useState<AcceptedKit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  // Показанный вариант видеопромпта: сначала отправленный в генерацию.
  const [shownPrompt, setShownPrompt] = useState<{ shot: string; variant: PromptVariant } | null>(null);
  const [player, setPlayer] = useState<HTMLVideoElement | null>(null);
  // Сохранённый кадр относится к своему плану: при смене плана сообщение не переносится.
  const [taken, setTaken] = useState<{ shot: string; frame: AcceptedFrame; seconds: number } | null>(null);
  const [taking, setTaking] = useState(false);

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
  const kitDir = shot.asset.dir;
  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      notify(commonTexts.copied, 'success');
    } catch (reason) {
      notify(describeError(reason), 'error');
    }
  };
  const speech = kit?.speech ?? null;
  const variants = kit?.promptVariants;
  const promptShown: PromptVariant = shownPrompt?.shot === shot.id ? shownPrompt.variant : (variants?.selected ?? 'original');
  const visiblePrompt = kit?.prompt ? promptVariantText(kit.prompt, variants, promptShown) : '';
  // Роль опоры — как записана в комплекте (у своего видео её выбирал пользователь); без записи она следует
  // из позиции: одна опора — первый кадр, у нескольких последняя — последний.
  const images = kit?.images ?? [];
  const gallery = images.map((image, index) => ({
    imagePath: image.path,
    label: texts.image({ index: index + 1, role: image.role ?? productionTexts.inputRoles[defaultRole(index, images.length)] })
  }));
  const openFolder = (dir: string): void => {
    window.api.shell.openPath(dir).catch((reason: unknown) => notify(describeError(reason), 'error'));
  };
  const edit = shot.asset.edit;
  const takeFrame = async (): Promise<void> => {
    if (!edit || !player) return;
    // Показанный кадр — тот, в чьём интервале стоит плеер; малый запас против погрешности currentTime.
    const frame = Math.min(edit.frames - 1, Math.max(0, Math.floor(player.currentTime * edit.fps + 1e-3)));
    setTaking(true);
    try {
      const result = await window.api.production.takeFrame(project, shot.id, frame);
      setTaken({ shot: shot.id, frame: result, seconds: frame / edit.fps });
    } catch (reason) {
      notify(describeError(reason), 'error');
    } finally {
      setTaking(false);
    }
  };
  const shownFrame = taken?.shot === shot.id ? taken : null;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="subtitle1" fontWeight={600}>
          {texts.heading}
        </Typography>
        <AcceptedAsset
          asset={shot.asset}
          title={null}
          onAcceptedVideo={setPlayer}
          acceptedActions={
            <ActionButton
              size="small"
              startIcon={<PhotoCameraIcon />}
              title={texts.takeFrameHint}
              disabled={!edit || !shot.asset.video || !player || taking}
              disabledReason={taking ? texts.takeFrameBusy : texts.takeFrameNoVideo}
              onClick={() => void takeFrame()}
            >
              {texts.takeFrame}
            </ActionButton>
          }
        />
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {onRecut ? (
            <ActionButton
              size="small"
              variant="outlined"
              startIcon={<ContentCutIcon />}
              title={texts.recutHint}
              disabled={busy || !shot.asset.edit?.sourceInterval || !shot.asset.original}
              disabledReason={busy ? (busyReason ?? null) : texts.recutUnavailable}
              onClick={onRecut}
            >
              {texts.recut}
            </ActionButton>
          ) : null}
        </Stack>
        {shownFrame ? (
          <Alert
            severity="success"
            onClose={() => setTaken(null)}
            action={
              <Button
                color="inherit"
                size="small"
                startIcon={<FolderOpenIcon />}
                title={texts.frameFolderHint}
                onClick={() => openFolder(shownFrame.frame.folder)}
              >
                {texts.openFolder}
              </Button>
            }
          >
            {texts.frameTaken({ frame: shownFrame.frame.frame, seconds: shownFrame.seconds.toFixed(2).replace('.', ','), path: shownFrame.frame.path })}
          </Alert>
        ) : null}
        {error ? <Alert severity="error">{error}</Alert> : null}
        {kit ? (
          <>
            <Stack spacing={0.5}>
              <Typography variant="subtitle2">{texts.source}</Typography>
              {/* Своё видео показывает опоры и промпт, как обычная генерация, только если их указали при загрузке. */}
              {kit.ownVideo ? <Typography variant="body2">{kit.images.length || kit.prompt ? texts.ownVideoGenerated : texts.ownVideo}</Typography> : null}
              <KitSource kit={kit} />
            </Stack>
            {kit.images.length ? (
              <Stack spacing={1}>
                <Typography variant="subtitle2">{texts.images}</Typography>
                {/* Как опоры в пакете попытки: миниатюра открывает общий просмотр изображений. */}
                <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                  {gallery.map((image, index) => (
                    <Box key={`${index}:${image.imagePath}`} sx={{ width: 220, minWidth: 0 }}>
                      <ImageThumbnail path={image.imagePath} label={image.label} title={image.imagePath} fit="cover" onOpen={() => setActive(index)} />
                      <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                        {image.label}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </Stack>
            ) : null}
            {kit.prompt ? (
              <PromptVariantsText
                text={kit.prompt}
                variants={variants}
                title={() => texts.prompt}
                status={variants ? productionTexts.promptVariants.sent({ translation: variants.selected === 'translation' }) : undefined}
                shown={promptShown}
                onShownChange={(variant) => setShownPrompt({ shot: shot.id, variant })}
                maxHeight={220}
              >
                <Button size="small" startIcon={<ContentCopyIcon />} title={texts.copyHint} onClick={() => void copy(visiblePrompt)} sx={{ mt: -1 }}>
                  {texts.copy}
                </Button>
              </PromptVariantsText>
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
        {/* Действие блока — после содержимого: папка комплекта с видео, оригиналом, опорами и промптом. */}
        <Box>
          <Button size="small" startIcon={<FolderOpenIcon />} title={texts.openFolderHint} onClick={() => openFolder(kitDir)}>
            {texts.openFolder}
          </Button>
        </Box>
      </Stack>
      {active !== null && gallery.length ? (
        <ImageGallery kind={productionTexts.packageKeyframes.galleryKind} images={gallery} initialIndex={active} onClose={() => setActive(null)} />
      ) : null}
    </Paper>
  );
}
