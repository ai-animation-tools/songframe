/**
 * Страница «Эффекты»: принятые планы слева карточками, как на «Производстве», выбранный план справа — превью кадра «до» и «после»,
 * цепочка эффектов (дождь, свет, зерно) с параметрами, применение заданием и снятие эффекта.
 * Принятое видео и платный оригинал не меняются: ролик с эффектом и рецепт пишет Go в
 * assets/effects/Mxx/, монтаж берёт ролик, пока он свеж.
 */
import type { ReactElement } from 'react';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { commonTexts } from '@shared/texts/common';
import { effectsTexts as texts } from '@shared/texts/effects';
import type { EffectKind, EffectShot } from '@shared/effects';
import { LinkedText } from '../../components/LinkedText';
import { ListDetailLayout } from '../../components/ListDetailLayout';
import { ShotCard } from '../../components/ShotCard';
import { usePageLoading } from '../../components/PageLoader';
import { useStickyTop } from '../../hooks/useStickyTop';
import { EffectShotPanel } from './components/EffectShotPanel';
import { useEffectsPage } from './useEffectsPage';

/** Отметка эффекта на карточке плана: идёт рендер, «В монтаже» или «Устарел»; без эффекта — нет отметки. */
function ShotChip({ shot }: { shot: EffectShot }): ReactElement | null {
  const sx = { height: 18 };
  if (shot.problem) return null;
  if (shot.jobId) return <Chip size="small" color="info" label={texts.rendering} sx={sx} />;
  if (!shot.applied) return null;
  return shot.stale ? <Chip size="small" color="warning" label={texts.stale} sx={sx} /> : <Chip size="small" color="success" label={texts.fresh} sx={sx} />;
}

/** Нижняя строка карточки: эффекты плана, «Без эффекта» или почему эффект недоступен. */
function shotCaption(shot: EffectShot, kinds: EffectKind[]): string {
  if (shot.problem) return texts.problem;
  if (!shot.applied || !shot.steps.length) return texts.noEffect;
  return shot.steps.map((step) => kinds.find((kind) => kind.id === step.effect)?.title ?? step.effect).join(' + ');
}

export function EffectsPage(): ReactElement {
  const page = useEffectsPage();
  const { view, loadError, shots, selected } = page;
  const { stickyTop } = useStickyTop([view]);
  usePageLoading(!view && !loadError);
  if (loadError)
    return (
      <Alert
        severity="error"
        action={
          <Button startIcon={<RefreshIcon />} onClick={() => void page.load()}>
            {commonTexts.retry}
          </Button>
        }
      >
        <LinkedText text={loadError} />
      </Alert>
    );
  if (!view) return <></>;
  const others = shots.filter((shot) => shot.shot !== selected?.shot && shot.applied && shot.steps.length > 0);
  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <Box>
        <Typography variant="h5">{texts.heading}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {texts.intro}
        </Typography>
      </Box>
      {!shots.length ? (
        <Alert severity="info">
          <LinkedText text={texts.empty} />
        </Alert>
      ) : (
        <ListDetailLayout
          storageKey="songframe.effects.list-width"
          defaultWidth={300}
          minDetailWidth={640}
          stickyTop={stickyTop}
          list={
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
                      stageLabel: shotCaption(shot, view.kinds)
                    }}
                    imagePath={shot.frame || null}
                    chips={<ShotChip shot={shot} />}
                    selected={shot.shot === selected?.shot}
                    onSelect={page.select}
                  />
                </Box>
              ))}
            </Box>
          }
          detail={
            selected ? (
              <EffectShotPanel
                shot={selected}
                kinds={view.kinds}
                others={others}
                draft={page.draft}
                dirty={page.dirty}
                frame={page.frame}
                mode={page.mode}
                full={page.full}
                preview={page.preview}
                busy={page.busy}
                job={page.job}
                actionError={page.actionError}
                releasing={page.releasing}
                reasons={page.reasons}
                onChange={page.change}
                onFrame={page.setFrame}
                onMode={page.setMode}
                onFull={page.setFull}
                onApply={() => void page.apply()}
                onReset={page.reset}
                onRemove={() => void page.remove()}
                onCopy={page.copyFrom}
              />
            ) : (
              <Typography color="text.secondary">{texts.chooseShot}</Typography>
            )
          }
        />
      )}
    </Stack>
  );
}
