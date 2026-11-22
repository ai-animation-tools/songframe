/**
 * Страница «Эффекты»: принятые планы слева, выбранный план справа — превью кадра «до» и «после»,
 * цепочка эффектов (дождь, свет, зерно) с параметрами, применение заданием и снятие эффекта.
 * Принятое видео и платный оригинал не меняются: ролик с эффектом и рецепт пишет Go в
 * assets/effects/Mxx/, монтаж берёт ролик, пока он свеж.
 */
import type { ReactElement } from 'react';
import { Alert, Box, Button, Chip, List, ListItem, ListItemButton, ListItemText, Paper, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { commonTexts } from '@shared/texts/common';
import { effectsTexts as texts } from '@shared/texts/effects';
import type { EffectShot } from '@shared/effects';
import { LinkedText } from '../../components/LinkedText';
import { ListDetailLayout } from '../../components/ListDetailLayout';
import { usePageLoading } from '../../components/PageLoader';
import { formatClock } from '../../format';
import { useStickyTop } from '../../hooks/useStickyTop';
import { EffectShotPanel } from './components/EffectShotPanel';
import { useEffectsPage } from './useEffectsPage';

/** Отметка плана в списке: эффекта нет, свеж, устарел, комплект недоступен. */
function ShotChip({ shot }: { shot: EffectShot }): ReactElement {
  if (shot.problem) return <Chip size="small" color="error" label={texts.problem} />;
  if (shot.jobId) return <Chip size="small" color="info" label={texts.rendering} />;
  if (!shot.applied) return <Chip size="small" variant="outlined" label={texts.noEffect} />;
  return shot.stale ? <Chip size="small" color="warning" label={texts.stale} /> : <Chip size="small" color="success" label={texts.fresh} />;
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
            <Paper variant="outlined">
              <List dense aria-label={texts.listLabel} disablePadding>
                {shots.map((shot) => (
                  <ListItem key={shot.shot} disablePadding>
                    <ListItemButton selected={shot.shot === selected?.shot} onClick={() => page.select(shot.shot)}>
                      <ListItemText
                        primary={`${shot.shot} · ${shot.title}`}
                        secondary={`${formatClock(shot.start)}–${formatClock(shot.end)}`}
                        slotProps={{ primary: { noWrap: true } }}
                        sx={{ minWidth: 0, mr: 1 }}
                      />
                      <ShotChip shot={shot} />
                    </ListItemButton>
                  </ListItem>
                ))}
              </List>
            </Paper>
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
                preview={page.preview}
                busy={page.busy}
                job={page.job}
                actionError={page.actionError}
                releasing={page.releasing}
                reasons={page.reasons}
                onChange={page.change}
                onFrame={page.setFrame}
                onMode={page.setMode}
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
