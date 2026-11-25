/**
 * Выезжающая справа панель принятых планов страницы «Эффекты»: карточки как на «Производстве» —
 * первая опора, эффекты плана, отметки «В монтаже», «Устарел», «Применяется» и «Не применено»
 * (черновик плана не применён). Выбор плана закрывает панель; вопрос о непримененном черновике
 * задаёт страница. Панель не занимает место основного экрана, где превью и шкала.
 */
import type { ReactElement } from 'react';
import { Box, Button, Chip, Drawer, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { EffectKind, EffectShot } from '@shared/effects';
import { effectsTexts as texts } from '@shared/texts/effects';
import { ShotCard } from '../../../components/ShotCard';

/** Отметки эффекта на карточке плана: идёт рендер, «В монтаже» или «Устарел», непримененный черновик. */
function ShotChips({ shot, unapplied }: { shot: EffectShot; unapplied: boolean }): ReactElement | null {
  const sx = { height: 18 };
  const draft = unapplied ? <Chip size="small" color="warning" variant="outlined" label={texts.unapplied} sx={sx} /> : null;
  if (shot.problem) return null;
  if (shot.jobId) return <Chip size="small" color="info" label={texts.rendering} sx={sx} />;
  if (!shot.applied) return draft;
  return (
    <>
      {shot.stale ? <Chip size="small" color="warning" label={texts.stale} sx={sx} /> : <Chip size="small" color="success" label={texts.fresh} sx={sx} />}
      {draft}
    </>
  );
}

/** Нижняя строка карточки: эффекты плана, «Без эффекта» или почему эффект недоступен. */
export function shotCaption(shot: EffectShot, kinds: EffectKind[]): string {
  if (shot.problem) return texts.problem;
  if (!shot.applied || !shot.steps.length) return texts.noEffect;
  return shot.steps.map((step) => kinds.find((kind) => kind.id === step.effect)?.title ?? step.effect).join(' + ');
}

export function EffectShotsDrawer({
  open,
  shots,
  kinds,
  selected,
  dirtyShots,
  onSelect,
  onClose
}: {
  open: boolean;
  shots: EffectShot[];
  kinds: EffectKind[];
  selected: string | null;
  dirtyShots: Set<string>;
  onSelect(shot: string): void;
  onClose(): void;
}): ReactElement {
  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          role: 'dialog',
          'aria-modal': true,
          'aria-labelledby': 'effects-shots-title',
          // Ширина — как у каталога материалов монтажа: несколько колонок карточек.
          sx: { width: 'min(100vw, max(720px, 50vw))', maxWidth: '100vw' }
        }
      }}
    >
      <Stack spacing={2} sx={{ p: 2, minHeight: 0, flex: 1, overflowY: 'auto' }}>
        <Typography id="effects-shots-title" variant="h6">
          {texts.listLabel}
        </Typography>
        <Box
          role="list"
          aria-label={texts.listLabel}
          sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))', gap: 1.5, minWidth: 0 }}
        >
          {shots.map((shot) => (
            <Box role="listitem" key={shot.shot} sx={{ minWidth: 0 }}>
              <ShotCard
                shot={{
                  id: shot.shot,
                  title: shot.title,
                  start: shot.start,
                  end: shot.end,
                  lipsync: shot.lipsync,
                  state: shot.problem ? 'unknown' : 'completed',
                  stageLabel: shotCaption(shot, kinds)
                }}
                imagePath={shot.frame || null}
                chips={<ShotChips shot={shot} unapplied={dirtyShots.has(shot.shot)} />}
                selected={shot.shot === selected}
                onSelect={onSelect}
              />
            </Box>
          ))}
        </Box>
      </Stack>
      <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
        <Button startIcon={<CloseIcon />} onClick={onClose}>
          {texts.closeShots}
        </Button>
      </Box>
    </Drawer>
  );
}
