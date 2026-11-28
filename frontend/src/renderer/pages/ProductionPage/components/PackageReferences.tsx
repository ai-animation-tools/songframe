import { productionTexts } from '@shared/texts/production';
/**
 * Референсы попытки «По референсам»: картинки, по которым сервис построит видео, вместо опор Codex. Агент
 * предложил их в описании (кадр принятого предшественника и изображения героев и места); пользователь утверждает
 * их все разом, убирает лишние или заменяет своим файлом либо кадром принятого плана («Взять кадр»). Замена
 * сразу утверждена. Состояние и файлы принадлежат Go, компонент только показывает карточки и вызывает обработчики.
 */
import { useState, type ReactElement } from 'react';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import { Box, Chip, Stack, Typography } from '@mui/material';
import type { PackageReference, PackageView } from '@shared/types';
import { useApp } from '../../../state';
import { ActionButton } from '../../../components/ActionButton';
import { ImageGallery } from '../../../components/ImageGallery';
import { ImageThumbnail } from '../../../components/ImageThumbnail';
import { BUSY_REASON } from '../constants';
import { ShotFrameButton, type ShotFrameSource } from './ShotFrameDialog';

const texts = productionTexts.packageReferences;

/** Название референса: роль start — «Начало», роль entity — имя сущности кастинга (нет в кастинге — её код). */
export function referenceName(reference: PackageReference, entityNames: Record<string, string>): string {
  if (reference.role === 'start') return texts.start;
  return (reference.entity ? entityNames[reference.entity] : undefined) ?? reference.entity ?? reference.id;
}

export function PackageReferences({
  pkg,
  entityNames,
  busy,
  busyReason = BUSY_REASON,
  editReason,
  shotFrames,
  onApprove,
  onRemove,
  onReplace
}: {
  pkg: PackageView;
  /** Имена сущностей кастинга по их кодам; без имени показывается код. */
  entityNames: Record<string, string>;
  busy: boolean;
  busyReason?: string;
  /** Почему референсы сейчас не меняются (reasons.references или ожидание вида); null — можно менять. */
  editReason: string | null;
  /** Принятые планы для «Взять кадр»; без них кнопки нет. */
  shotFrames?: ShotFrameSource;
  onApprove(): void;
  onRemove(id: string): void;
  /** Файл path вместо референса id; false — замена не удалась. */
  onReplace(id: string, path: string): Promise<boolean>;
}): ReactElement | null {
  const { notify, describeError } = useApp();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const references = pkg.references ?? [];
  if (!references.length) return null;
  const approved = references.filter((reference) => reference.approved).length;
  const reason = busy ? busyReason : editReason;
  const images = references
    .filter((reference) => reference.imagePath)
    .map((reference) => ({
      imagePath: reference.imagePath!,
      label: texts.title({ id: reference.id, name: referenceName(reference, entityNames) })
    }));
  const choose = async (id: string): Promise<void> => {
    try {
      const files = await window.api.dialog.pickFiles({
        title: texts.pickTitle({ id }),
        multiple: false,
        filters: [{ name: productionTexts.frameActions.images, extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
      });
      if (files[0]) await onReplace(id, files[0]);
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };
  return (
    <Box>
      <Typography variant="subtitle2">{texts.heading({ approved, references: references.length })}</Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        {texts.hint}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
        {references.map((reference) => {
          const index = images.findIndex((image) => image.imagePath === reference.imagePath);
          const title = texts.title({ id: reference.id, name: referenceName(reference, entityNames) });
          return (
            <Box key={reference.id} sx={{ width: 220, minWidth: 0 }}>
              {reference.imagePath ? (
                <ImageThumbnail
                  path={reference.imagePath}
                  label={title}
                  title={reference.imagePath}
                  fit="cover"
                  highlight={reference.approved ? 'success' : 'warning'}
                  dashed={!reference.approved}
                  onOpen={() => setActiveIndex(index)}
                />
              ) : (
                <Box sx={{ width: '100%', aspectRatio: '16 / 9', bgcolor: 'action.hover', borderRadius: 1.5, display: 'grid', placeItems: 'center' }}>
                  <Typography variant="caption" color="text.secondary">
                    {texts.fileMissing}
                  </Typography>
                </Box>
              )}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', mt: 0.5 }}>
                <Typography variant="body2" fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
                  {title}
                </Typography>
              </Box>
              <Chip
                size="small"
                variant="outlined"
                color={reference.approved ? 'success' : 'warning'}
                icon={reference.approved ? <CheckCircleIcon /> : <HourglassEmptyIcon />}
                label={reference.approved ? texts.approved : texts.candidate}
                sx={{ mt: 0.5 }}
              />
              <Stack spacing={0.5} sx={{ mt: 0.5, alignItems: 'flex-start' }}>
                <ActionButton
                  size="small"
                  startIcon={<FolderOpenIcon />}
                  title={texts.ownHint({ id: reference.id })}
                  disabled={!!reason}
                  disabledReason={reason}
                  onClick={() => void choose(reference.id)}
                >
                  {texts.own}
                </ActionButton>
                {shotFrames ? (
                  <ShotFrameButton
                    frame={reference.id}
                    source={shotFrames}
                    disabled={!!reason}
                    disabledReason={reason}
                    onPicked={(path) => onReplace(reference.id, path)}
                  />
                ) : null}
                <ActionButton
                  size="small"
                  startIcon={<DeleteOutlineIcon />}
                  title={texts.removeHint({ id: reference.id })}
                  disabled={!!reason || references.length <= 1}
                  disabledReason={reason ?? texts.lastReason}
                  onClick={() => onRemove(reference.id)}
                >
                  {texts.remove}
                </ActionButton>
              </Stack>
            </Box>
          );
        })}
      </Box>
      {approved < references.length ? (
        <ActionButton
          variant="contained"
          startIcon={<CheckCircleIcon />}
          sx={{ mt: 1.5 }}
          title={texts.approveHint}
          disabled={!!reason}
          disabledReason={reason}
          onClick={onApprove}
        >
          {texts.approve}
        </ActionButton>
      ) : null}
      {activeIndex !== null && images.length ? (
        <ImageGallery kind={texts.galleryKind} images={images} initialIndex={activeIndex} onClose={() => setActiveIndex(null)} />
      ) : null}
    </Box>
  );
}
