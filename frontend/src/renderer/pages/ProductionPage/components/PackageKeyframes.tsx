import { productionTexts } from '@shared/texts/production';
/** Опоры пакета создаются и согласуются по одной: у каждой видно состояние, утверждённую можно вернуть на доработку. */
import { useState, type ReactElement } from 'react';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import ReplayIcon from '@mui/icons-material/Replay';
import { Box, Chip, Typography } from '@mui/material';
import type { KeyframeNoteScope, PackageKeyframe, PackageView } from '@shared/types';
import { ImageGallery } from '../../../components/ImageGallery';
import { ImageThumbnail } from '../../../components/ImageThumbnail';
import { ActionButton } from '../../../components/ActionButton';
import { BUSY_REASON } from '../constants';
import { KeyframeNotes } from './KeyframeNotes';
import { KeyframeReopenDialog } from './KeyframeReopenDialog';

const ROLE_LABELS: Record<string, string> = productionTexts.frameRoleLabels;
/** Этапы пакета, на которых инструмент принимает возврат утверждённой опоры (shot_workflow reopen). */
const REOPEN_STAGES = ['keyframes_review', 'prompt_review', 'image_request_choice', 'needs_revision'];

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
function reopenFrameReason(pkg: PackageView): string | null {
  if (pkg.prompt?.approved) return productionTexts.packageKeyframes.promptApproved;
  if (pkg.request && pkg.request.kind !== 'image') return productionTexts.packageKeyframes.requestPrepared;
  if (!REOPEN_STAGES.includes(pkg.stage)) return productionTexts.packageKeyframes.imagePending;
  return null;
}

export function PackageKeyframes({
  pkg,
  busy,
  busyReason = BUSY_REASON,
  onReopen,
  onSetNote
}: {
  pkg: PackageView;
  busy: boolean;
  busyReason?: string;
  onReopen(frame: string, note: string, scope: KeyframeNoteScope): void;
  onSetNote(id: number, active: boolean): void;
}): ReactElement | null {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [reopening, setReopening] = useState<string | null>(null);
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
    <Box sx={{ mb: 2 }}>
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
                    {k.approved ? productionTexts.packageKeyframes.fileMissing : productionTexts.packageKeyframes.notCreated}
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
                  disabled={busy || !!blocked}
                  disabledReason={busy ? busyReason : blocked}
                  onClick={() => setReopening(k.id)}
                >
                  {productionTexts.packageKeyframes.reopen}
                </ActionButton>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <KeyframeNotes notes={pkg.keyframeNotes} busy={busy} busyReason={busyReason} onDeactivate={(id) => onSetNote(id, false)} />
      {activeIndex !== null && images.length ? (
        <ImageGallery kind={productionTexts.packageKeyframes.galleryKind} images={images} initialIndex={activeIndex} onClose={() => setActiveIndex(null)} />
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
