import { commonTexts } from '@shared/texts/common';
import { montageTexts } from '@shared/texts/montage';
import { Check } from '@mui/icons-material';
import type { ReactElement } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import type { MontageDraft, MontageView } from '@shared/montage';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { clipLength, frameLabel } from '../model';

/** Применение отделено от черновика и экспорта: пользователь видит новые границы перед изменением сцен. */
export function MontageApplyDialog({
  open,
  draft,
  view,
  busy,
  onClose,
  onApply
}: {
  open: boolean;
  draft: MontageDraft;
  view: MontageView;
  busy: boolean;
  onClose: () => void;
  onApply: () => void;
}): ReactElement {
  let cursor = draft.audio.start_frame;
  return (
    <ConfirmationDialog
      open={open}
      onClose={onClose}
      title={montageTexts.applyTitle}
      onConfirm={onApply}
      confirmLabel={montageTexts.applyToScenes}
      confirmIcon={<Check />}
      confirmColor="error"
      confirmDisabled={busy}
      confirmDisabledReason={commonTexts.operationPending}
      cancelDisabled={busy}
      cancelDisabledReason={commonTexts.operationPending}
      closeDisabled={busy}
    >
      <Stack spacing={1.5}>
        <Alert severity="warning">{montageTexts.applyConsequences}</Alert>
        <Typography variant="body2">{montageTexts.applyRequirements}</Typography>
        {draft.clips.map((clip) => {
          const start = cursor;
          cursor += clipLength(clip);
          const canonical = view.scenes.find((scene) => scene.id === clip.scene);
          const changed = canonical && (canonical.startFrame !== start || canonical.endFrame !== cursor);
          return (
            <Typography key={clip.id} variant="body2" color={changed ? 'warning.main' : 'text.primary'}>
              {montageTexts.applyRange({
                scene: clip.scene,
                start: frameLabel(start),
                end: frameLabel(cursor),
                previous: changed ? { start: frameLabel(canonical.startFrame), end: frameLabel(canonical.endFrame) } : undefined
              })}
            </Typography>
          );
        })}
      </Stack>
    </ConfirmationDialog>
  );
}
