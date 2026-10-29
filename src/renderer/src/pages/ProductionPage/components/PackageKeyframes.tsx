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

const ROLE_LABELS: Record<PackageKeyframe['role'], string> = { first: 'первый кадр', middle: 'промежуточный', last: 'последний кадр' };
/** Этапы пакета, на которых инструмент принимает возврат утверждённой опоры (shot_workflow reopen). */
const REOPEN_STAGES = ['keyframes_review', 'prompt_review', 'image_request_choice', 'needs_revision'];

type FrameState = 'missing' | 'candidate' | 'asked' | 'approved';

function frameState(frame: PackageKeyframe, asked: string | undefined): FrameState {
  if (frame.approved) return 'approved';
  if (!frame.imagePath) return 'missing';
  return asked === frame.id ? 'asked' : 'candidate';
}

const STATE_CHIPS: Record<FrameState, { label: string; color: 'default' | 'warning' | 'primary' | 'success'; icon: ReactElement }> = {
  missing: { label: 'не создана', color: 'default', icon: <RadioButtonUncheckedIcon /> },
  candidate: { label: 'кандидат ждёт решения', color: 'warning', icon: <HourglassEmptyIcon /> },
  asked: { label: 'вопрос ниже: утвердить?', color: 'primary', icon: <HelpOutlineIcon /> },
  approved: { label: 'утверждена', color: 'success', icon: <CheckCircleIcon /> }
};

/** Почему утверждённую опору нельзя вернуть: видеопромпт или запрос видео уже строятся на ней. */
function reopenFrameReason(pkg: PackageView): string | null {
  if (pkg.prompt?.approved) return 'Видеопромпт уже утверждён по этим опорам: исправленную опору создайте в новой попытке («Подготовить повтор»).';
  if (pkg.request && pkg.request.kind !== 'image') return 'Запрос видео уже подготовлен по этим опорам: исправленную опору создайте в новой попытке.';
  if (!REOPEN_STAGES.includes(pkg.stage)) return 'Сначала завершите отправку изображения и выберите её результат.';
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
      label: `${k.id} · ${ROLE_LABELS[k.role] ?? k.role} · ${k.time_seconds} с · ${k.approved ? 'утверждена' : 'кандидат, не принят'}`
    }));
  const blocked = reopenFrameReason(pkg);
  if (!pkg.keyframes.length) return null;
  const approved = pkg.keyframes.filter((k) => k.approved).length;
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2">
        Опоры · утверждено {approved} из {pkg.keyframes.length}
        {pkg.timing?.request_seconds ? ` · запрос ${pkg.timing.request_seconds} с на окно ${pkg.timing.window_seconds} с` : ''}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        Опоры создаются и утверждаются по одной; утверждённые передаются агенту референсами следующих. Щелчок по миниатюре открывает её крупно.
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
                  <Typography variant="caption">{k.approved ? 'файла нет' : 'ещё не создана'}</Typography>
                </Box>
              )}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', mt: 0.5 }}>
                <Typography variant="body2" fontWeight={600}>
                  {k.id}
                </Typography>
                <Chip size="small" variant={state === 'asked' ? 'filled' : 'outlined'} color={chip.color} icon={chip.icon} label={chip.label} />
              </Box>
              <Typography variant="caption" color="text.secondary" display="block">
                {ROLE_LABELS[k.role] ?? k.role} · {k.time_seconds} с
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
                  title={`Снять утверждение ${k.id} и создать опору заново с замечанием`}
                  disabled={busy || !!blocked}
                  disabledReason={busy ? busyReason : blocked}
                  onClick={() => setReopening(k.id)}
                >
                  Вернуть на доработку
                </ActionButton>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <KeyframeNotes notes={pkg.keyframeNotes} busy={busy} busyReason={busyReason} onDeactivate={(id) => onSetNote(id, false)} />
      {activeIndex !== null && images.length ? (
        <ImageGallery kind="Опора" images={images} initialIndex={activeIndex} onClose={() => setActiveIndex(null)} />
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
