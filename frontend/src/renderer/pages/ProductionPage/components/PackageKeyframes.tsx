import { productionTexts } from '@shared/texts/production';
/**
 * Опоры пакета создаются и согласуются по одной: у каждой видно состояние, утверждённую можно вернуть на доработку.
 * Заменённые доработкой или своим файлом варианты опоры хранятся в попытке: «Прежние варианты» открывает их и
 * возвращает выбранный кандидатом.
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import HistoryIcon from '@mui/icons-material/History';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ReplayIcon from '@mui/icons-material/Replay';
import { Box, Button, Chip, Typography } from '@mui/material';
import type { KeyframeNoteScope, PackageKeyframe, PackageView } from '@shared/types';
import { copyShotFrame, type ProductionComposition } from '@shared/production-workflow';
import { ImageGallery } from '../../../components/ImageGallery';
import { ImageThumbnail } from '../../../components/ImageThumbnail';
import { ActionButton } from '../../../components/ActionButton';
import { BUSY_REASON } from '../constants';
import { FRAME_REOPEN_STAGES } from '../planPath';
import { KeyframeNotes } from './KeyframeNotes';
import { KeyframeReopenDialog } from './KeyframeReopenDialog';
import { FrameVariantsDialog } from './FrameVariantsDialog';

const ROLE_LABELS: Record<string, string> = productionTexts.frameRoleLabels;

type FrameState = 'missing' | 'candidate' | 'asked' | 'approved';

function frameState(frame: PackageKeyframe, asked: string | undefined): FrameState {
  if (frame.approved) return 'approved';
  if (!frame.imagePath) return 'missing';
  return asked === frame.id ? 'asked' : 'candidate';
}

const STATE_CHIPS: Record<FrameState, { label: string; color: 'default' | 'warning' | 'primary' | 'success'; icon: ReactElement }> = {
  missing: { label: productionTexts.packageKeyframes.missing, color: 'default', icon: <RadioButtonUncheckedIcon /> },
  candidate: { label: productionTexts.packageKeyframes.candidate, color: 'warning', icon: <HourglassEmptyIcon /> },
  asked: { label: productionTexts.packageKeyframes.pending, color: 'primary', icon: <HelpOutlineIcon /> },
  approved: { label: productionTexts.packageKeyframes.approved, color: 'success', icon: <CheckCircleIcon /> }
};

/** Почему утверждённую опору нельзя вернуть: видеопромпт или запрос видео уже строятся на ней. */
/** Подпись копии: «Копия K02» или кадр принятого плана, из которого взята опора. */
function copyLabel(source: string): string {
  const frame = copyShotFrame(source);
  return frame ? productionTexts.packageKeyframes.shotFrame(frame) : productionTexts.packageKeyframes.copyOf({ source });
}

/** Почему копию не вернуть на доработку отдельно: через источник или, для кадра другого плана, через описание. */
function copyReopenReason(id: string, source: string): string {
  return copyShotFrame(source) ? productionTexts.packageKeyframes.shotFrameReopen({ id }) : productionTexts.packageKeyframes.copyReopen({ id, source });
}

function reopenFrameReason(pkg: PackageView): string | null {
  if (pkg.prompt?.approved) return productionTexts.packageKeyframes.promptApproved;
  if (pkg.request && pkg.request.kind !== 'image') return productionTexts.packageKeyframes.requestPrepared;
  if (!FRAME_REOPEN_STAGES.includes(pkg.stage)) return productionTexts.packageKeyframes.imagePending;
  return null;
}

export function PackageKeyframes({
  pkg,
  busy,
  busyReason = BUSY_REASON,
  onReopen,
  onRestore,
  onReplace,
  onSetNote,
  renderActions,
  copies = {},
  composition = []
}: {
  pkg: PackageView;
  busy: boolean;
  busyReason?: string;
  onReopen(frame: string, note: string, scope: KeyframeNoteScope): void;
  /** Вернуть прежний вариант опоры кандидатом; без обработчика прежние варианты не показываются. */
  onRestore?(frame: string, variant: string): void;
  /** Свой файл вместо утверждённой опоры без замечания (файл выбирает обработчик); без обработчика кнопки нет. */
  onReplace?(frame: string): void;
  onSetNote(id: number, active: boolean): void;
  /** Действия неутверждённой опоры на её карточке: создать или поставить свой файл. */
  renderActions?(frame: PackageKeyframe): ReactNode;
  /** Копии других опор плана (copyOf): ID копии → ID источника. Их возвращают на доработку через источник. */
  copies?: Record<string, string>;
  /** Свежие снимки схемы композиции попытки: в просмотре опору можно сравнить с ними наложением. */
  composition?: ProductionComposition['frames'];
}): ReactElement | null {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [reopening, setReopening] = useState<string | null>(null);
  const [variantsOf, setVariantsOf] = useState<string | null>(null);
  const asked = pkg.pendingDecision?.frame;
  const images = pkg.keyframes
    .filter((k) => k.imagePath)
    .map((k) => ({
      imagePath: k.imagePath!,
      label: productionTexts.packageKeyframes.candidateLabel({
        id: k.id,
        role: ROLE_LABELS[k.role] ?? k.role,
        timeSeconds: k.time_seconds,
        approved: k.approved
      })
    }));
  const blocked = reopenFrameReason(pkg);
  if (!pkg.keyframes.length) return null;
  const approved = pkg.keyframes.filter((k) => k.approved).length;
  return (
    <Box>
      <Typography variant="subtitle2">
        {productionTexts.packageKeyframes.heading({
          approved,
          frames: pkg.keyframes.length,
          requestSeconds: pkg.timing?.request_seconds,
          windowSeconds: pkg.timing?.window_seconds
        })}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        {productionTexts.packageKeyframes.hint}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
        {pkg.keyframes.map((k) => {
          const state = frameState(k, asked);
          const chip = STATE_CHIPS[state];
          const index = images.findIndex((image) => image.imagePath === k.imagePath);
          return (
            <Box key={k.id} sx={{ width: 220, minWidth: 0 }}>
              {k.imagePath ? (
                <ImageThumbnail
                  path={k.imagePath}
                  label={images[index].label}
                  title={k.imagePath}
                  fit="cover"
                  highlight={state === 'approved' ? 'success' : state === 'asked' ? 'primary' : 'warning'}
                  dashed={!k.approved}
                  onOpen={() => setActiveIndex(index)}
                />
              ) : (
                <Box
                  sx={{
                    width: '100%',
                    aspectRatio: '16 / 9',
                    bgcolor: 'action.hover',
                    borderRadius: 1.5,
                    display: 'grid',
                    placeItems: 'center',
                    color: 'text.secondary'
                  }}
                >
                  <Typography variant="caption">
                    {k.approved
                      ? productionTexts.packageKeyframes.fileMissing
                      : copies[k.id]
                        ? copyShotFrame(copies[k.id])
                          ? productionTexts.packageKeyframes.shotFramePending
                          : productionTexts.packageKeyframes.copyPending({ source: copies[k.id] })
                        : productionTexts.packageKeyframes.notCreated}
                  </Typography>
                </Box>
              )}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', mt: 0.5 }}>
                <Typography variant="body2" fontWeight={600}>
                  {k.id}
                </Typography>
                <Chip size="small" variant={state === 'asked' ? 'filled' : 'outlined'} color={chip.color} icon={chip.icon} label={chip.label} />
              </Box>
              <Typography variant="caption" color="text.secondary" display="block">
                {productionTexts.packageKeyframes.frameCaption({ role: ROLE_LABELS[k.role] ?? k.role, timeSeconds: k.time_seconds })}
              </Typography>
              {copies[k.id] ? (
                <Typography variant="caption" color="text.secondary" display="block">
                  {copyLabel(copies[k.id])}
                </Typography>
              ) : null}
              {k.note ? (
                <Typography variant="caption" color="text.secondary" display="block">
                  {k.note}
                </Typography>
              ) : null}
              {k.approved ? (
                <ActionButton
                  size="small"
                  startIcon={<ReplayIcon />}
                  sx={{ mt: 0.5 }}
                  title={productionTexts.packageKeyframes.reopenHint({ id: k.id })}
                  disabled={busy || !!blocked || !!copies[k.id]}
                  disabledReason={busy ? busyReason : (blocked ?? (copies[k.id] ? copyReopenReason(k.id, copies[k.id]) : null))}
                  onClick={() => setReopening(k.id)}
                >
                  {productionTexts.packageKeyframes.reopen}
                </ActionButton>
              ) : null}
              {k.approved && onReplace ? (
                <ActionButton
                  size="small"
                  startIcon={<FolderOpenIcon />}
                  sx={{ mt: 0.5 }}
                  title={productionTexts.packageKeyframes.replaceHint({ id: k.id })}
                  disabled={busy || !!blocked || !!copies[k.id]}
                  disabledReason={busy ? busyReason : (blocked ?? (copies[k.id] ? copyReopenReason(k.id, copies[k.id]) : null))}
                  onClick={() => onReplace(k.id)}
                >
                  {productionTexts.packageKeyframes.replace}
                </ActionButton>
              ) : null}
              {onRestore && k.variants?.length ? (
                <Button
                  size="small"
                  startIcon={<HistoryIcon />}
                  sx={{ mt: 0.5 }}
                  title={productionTexts.packageKeyframes.variantsHint({ id: k.id })}
                  onClick={() => setVariantsOf(k.id)}
                >
                  {productionTexts.packageKeyframes.variants({ count: k.variants.length })}
                </Button>
              ) : null}
              {renderActions?.(k)}
            </Box>
          );
        })}
      </Box>
      <KeyframeNotes notes={pkg.keyframeNotes} busy={busy} busyReason={busyReason} onDeactivate={(id) => onSetNote(id, false)} />
      {activeIndex !== null && images.length ? (
        <ImageGallery
          kind={productionTexts.packageKeyframes.galleryKind}
          images={images}
          initialIndex={activeIndex}
          compare={composition.map((frame) => ({
            imagePath: frame.path,
            label: productionTexts.composition.compareLabel({ phase: productionTexts.composition.phases[frame.phase] })
          }))}
          onClose={() => setActiveIndex(null)}
        />
      ) : null}
      {variantsOf && onRestore ? (
        <FrameVariantsDialog
          frame={pkg.keyframes.find((k) => k.id === variantsOf)!}
          disabledReason={
            busy
              ? busyReason
              : (blocked ?? (copies[variantsOf] ? productionTexts.packageKeyframes.copyRestore({ id: variantsOf, source: copies[variantsOf] }) : null))
          }
          onClose={() => setVariantsOf(null)}
          onRestore={(variant) => {
            setVariantsOf(null);
            onRestore(variantsOf, variant);
          }}
        />
      ) : null}
      {reopening ? (
        <KeyframeReopenDialog
          frame={reopening}
          onClose={() => setReopening(null)}
          onConfirm={(note, scope) => {
            setReopening(null);
            onReopen(reopening, note, scope);
          }}
        />
      ) : null}
    </Box>
  );
}
