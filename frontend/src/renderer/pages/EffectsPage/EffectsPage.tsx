/**
 * Страница «Эффекты» раскладкой как у «Монтажа пробы»: выбранный принятый план занимает экран —
 * закреплённая панель с превью кадра «до» и «после» (или ролика), общей шкалой плана и действиями,
 * под ней цепочка эффектов (дождь, свет, зерно и др.) с параметрами. Планы выбираются в выезжающей
 * панели «Планы» и стрелками соседних планов; смена плана с непримененным черновиком спрашивает
 * подтверждение. Принятое видео и платный оригинал не меняются: ролик с эффектом и рецепт пишет Go
 * в assets/effects/Mxx/, монтаж берёт ролик, пока он свеж.
 */
import { useLayoutEffect, useState, type ReactElement } from 'react';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ViewSidebarOutlinedIcon from '@mui/icons-material/ViewSidebarOutlined';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { commonTexts } from '@shared/texts/common';
import { effectsTexts as texts } from '@shared/texts/effects';
import { shotLabel } from '@shared/effects';
import { ActionIconButton } from '../../components/ActionIconButton';
import { ConfirmationDialog } from '../../components/ConfirmationDialog';
import { LinkedText } from '../../components/LinkedText';
import { usePageLoading } from '../../components/PageLoader';
import { useHeaderHeight } from '../../components/headerHeight';
import { useStoredNumber } from '../../hooks/useStoredNumber';
import { formatClock } from '../../format';
import { EffectShotPanel } from './components/EffectShotPanel';
import { EffectShotsDrawer } from './components/EffectShotsDrawer';
import { useEffectsPage } from './useEffectsPage';

/** Доля доступной высоты под закреплённой панелью превью, запоминается между запусками. */
const SPLIT_KEY = 'effects-preview-split';
const validFraction = (value: number): boolean => value >= 0.2 && value <= 0.95;
/** Высота разделителя под панелью и нижний запас окна, пиксели. */
const DIVIDER_HEIGHT = 20;
/** Сколько высоты оставить карточкам эффектов под панелью при наибольшей панели, пиксели. */
const CARDS_MIN = 120;

export function EffectsPage(): ReactElement {
  const page = useEffectsPage();
  const { view, loadError, shots, selected } = page;
  const [drawer, setDrawer] = useState(false);
  // План, к которому просились, пока черновик открытого плана не применён.
  const [leaving, setLeaving] = useState<string | null>(null);
  const headerHeight = useHeaderHeight();
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const [fraction, setFraction] = useStoredNumber(SPLIT_KEY, 0.7, validFraction);
  useLayoutEffect(() => {
    const resize = (): void => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
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

  // Высота панели: доля доступной высоты окна в пределах, оставляющих место карточкам под ней.
  const top = headerHeight + 8;
  const available = Math.max(360, viewportHeight - top - 16 - DIVIDER_HEIGHT);
  const min = Math.min(320, available / 2);
  const max = Math.max(min, available - CARDS_MIN);
  const height = Math.min(max, Math.max(min, available * fraction));

  /** Смена плана: с непримененным черновиком — через вопрос, иначе сразу. */
  const request = (shot: string): void => {
    setDrawer(false);
    if (!selected || shot === selected.shot) return;
    if (page.dirty) setLeaving(shot);
    else page.select(shot);
  };
  const index = selected ? shots.findIndex((shot) => shot.shot === selected.shot) : -1;
  const previous = index > 0 ? shots[index - 1] : null;
  const next = index >= 0 && index < shots.length - 1 ? shots[index + 1] : null;
  const fresh = !!selected?.applied && !selected.stale;

  const navigation = selected ? (
    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
      <Button
        variant="outlined"
        startIcon={<ViewSidebarOutlinedIcon />}
        title={texts.shotsHint}
        aria-haspopup="dialog"
        aria-expanded={drawer}
        onClick={() => setDrawer(true)}
      >
        {texts.shots}
      </Button>
      <ActionIconButton aria-label={texts.previousShot} disabled={!previous} onClick={() => previous && request(previous.shot)}>
        <ChevronLeftIcon />
      </ActionIconButton>
      <ActionIconButton aria-label={texts.nextShot} disabled={!next} onClick={() => next && request(next.shot)}>
        <ChevronRightIcon />
      </ActionIconButton>
      <Typography variant="h6" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {shotLabel(selected)}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {formatClock(selected.start)}–{formatClock(selected.end)}
      </Typography>
      {fresh ? <Chip size="small" color="success" label={texts.fresh} /> : selected.applied ? <Chip size="small" color="warning" label={texts.stale} /> : null}
      {page.dirty ? <Chip size="small" color="warning" variant="outlined" label={texts.unapplied} /> : null}
    </Stack>
  ) : null;

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
      ) : selected ? (
        <EffectShotPanel
          key={selected.shot}
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
          layout={{ top, height, min, max, onHeight: (value) => setFraction(value / available) }}
          navigation={navigation}
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
      )}
      <EffectShotsDrawer
        open={drawer}
        shots={shots}
        kinds={view.kinds}
        selected={selected?.shot ?? null}
        dirtyShots={page.dirtyShots}
        onSelect={request}
        onClose={() => setDrawer(false)}
      />
      <ConfirmationDialog
        open={!!leaving && !!selected}
        title={selected ? texts.leave.title({ shot: selected.shot }) : ''}
        description={texts.leave.description}
        cancelLabel={texts.leave.stay}
        cancelAutoFocus
        confirmLabel={leaving ? texts.leave.go({ shot: leaving }) : ''}
        confirmIcon={<ChevronRightIcon />}
        onClose={() => setLeaving(null)}
        onConfirm={() => {
          if (leaving) page.select(leaving);
          setLeaving(null);
        }}
      />
    </Stack>
  );
}
