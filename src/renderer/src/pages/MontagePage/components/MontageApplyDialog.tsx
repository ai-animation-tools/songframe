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
      title="Применить монтаж к принятым сценам?"
      onConfirm={onApply}
      confirmLabel="Применить к сценам"
      confirmIcon={<Check />}
      confirmColor="error"
      confirmDisabled={busy}
      cancelDisabled={busy}
      closeDisabled={busy}
    >
      <Stack spacing={1.5}>
        <Alert severity="warning">
          Это действие изменит принятые монтажные версии сцен и внутренние границы в реестре. Оригиналы и прежние версии сохранятся. Исходная песня и её
          разметка не меняются.
        </Alert>
        <Typography variant="body2">
          Нужны принятые комплекты соседних сцен в исходном порядке и сохранение внешних границ участка. Сдвиг стыка изменит оба соседних комплекта. Приложение
          проверит эти условия и актуальность материалов перед применением.
        </Typography>
        {draft.clips.map((clip) => {
          const start = cursor;
          cursor += clipLength(clip);
          const canonical = view.scenes.find((scene) => scene.id === clip.scene);
          const changed = canonical && (canonical.startFrame !== start || canonical.endFrame !== cursor);
          return (
            <Typography key={clip.id} variant="body2" color={changed ? 'warning.main' : 'text.primary'}>
              {clip.scene}: {frameLabel(start)} — {frameLabel(cursor)}
              {changed ? ` (было ${frameLabel(canonical.startFrame)} — ${frameLabel(canonical.endFrame)})` : ''}
            </Typography>
          );
        })}
      </Stack>
    </ConfirmationDialog>
  );
}
