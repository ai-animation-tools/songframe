/**
 * Выбранный принятый план на странице «Эффекты», раскладкой как у «Монтажа пробы»: закреплённая
 * под шапкой панель (высоту задаёт страница, разделитель под панелью) и под ней цепочка эффектов.
 * В панели — строка плана (навигация страницы), слева одно превью: «Кадр» (до и после, ручки
 * источника и луча поверх кадра, на весь экран — в полном размере) или «Ролик» (принятое видео и
 * ролик с эффектом), под ним общая шкала плана со строками песни, моментами эффектов и кадром
 * превью; справа состояние эффекта и действия: «Применить», сброс, «Убрать эффект», добавление
 * эффекта и «Взять параметры с плана». Карточки эффектов прокручиваются под панелью, превью и шкала
 * остаются на экране. Рендер и файлы — в Go (effects.render/remove).
 */
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { Alert, Box, Button, CircularProgress, Divider, Menu, MenuItem, Paper, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import MovieFilterIcon from '@mui/icons-material/MovieFilter';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import LayersClearIcon from '@mui/icons-material/LayersClear';
import WbIncandescentOutlinedIcon from '@mui/icons-material/WbIncandescentOutlined';
import { fractionToSeconds, shotLabel, stepValue, type EffectKind, type EffectShot, type EffectStep } from '@shared/effects';
import { componentsTexts } from '@shared/texts/components';
import { effectsTexts as texts } from '@shared/texts/effects';
import { ActionButton } from '../../../components/ActionButton';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { JobStatus } from '../../../components/JobStatus';
import { LinkedText } from '../../../components/LinkedText';
import { SplitHandle } from '../../../components/SplitHandle';
import { VideoPlayer } from '../../../components/VideoPlayer';
import type { JobInfo } from '@shared/types';
import type { PreviewMode } from '../useEffectsPage';
import { BeamEditor } from './BeamEditor';
import { EffectStepCard } from './EffectStepCard';
import { FrameFullscreen } from './FrameFullscreen';
import { PlanTimeline, type PlanMark } from './PlanTimeline';

/** Медиа плана в панели: кадр превью или ролик. */
type MediaTab = 'frame' | 'video';

/** Наибольшая ширина превью и ролика: крупно смотрят кнопкой «На весь экран». */
export const MEDIA_MAX_WIDTH = 960;

/** Высота элементов панели вокруг кадра (строка плана, переключатели, шкала, отступы), пиксели: остальное — кадру. */
const PANEL_CHROME = 236;

/** Закреплённая панель: верх под шапкой, высота и её пределы — от страницы. */
export interface EffectPanelLayout {
  top: number;
  height: number;
  min: number;
  max: number;
  onHeight(height: number): void;
}

export function EffectShotPanel({
  shot,
  kinds,
  others,
  draft,
  dirty,
  frame,
  mode,
  full,
  preview,
  busy,
  job,
  actionError,
  releasing,
  reasons,
  layout,
  navigation,
  onChange,
  onFrame,
  onMode,
  onFull,
  onApply,
  onReset,
  onRemove,
  onCopy
}: {
  shot: EffectShot;
  kinds: EffectKind[];
  /** Другие планы с эффектом: источники «Взять параметры с плана». */
  others: EffectShot[];
  draft: EffectStep[];
  dirty: boolean;
  frame: number;
  mode: PreviewMode;
  /** Кадр открыт на весь экран: превью приходит в полном размере. */
  full: boolean;
  preview: { url: string | null; error: string | null; loading: boolean };
  busy: boolean;
  job: JobInfo | null;
  actionError: string | null;
  releasing: boolean;
  reasons: { apply: string | null; reset: string | null; remove: string | null };
  layout: EffectPanelLayout;
  /** Строка плана страницы: «Планы», соседние планы, название и отметки. */
  navigation: ReactNode;
  onChange(steps: EffectStep[]): void;
  onFrame(frame: number): void;
  onMode(mode: PreviewMode): void;
  onFull(full: boolean): void;
  onApply(): void;
  onReset(): void;
  onRemove(): void;
  onCopy(source: EffectShot): void;
}): ReactElement {
  const panelId = useId();
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [copyAnchor, setCopyAnchor] = useState<HTMLElement | null>(null);
  const [tab, setTab] = useState<MediaTab>('frame');
  const [video, setVideo] = useState<'after' | 'before'>('after');
  // Ручки источника и луча на превью: по переключателю, потому что поле вокруг кадра уменьшает его.
  const [handles, setHandles] = useState(false);
  // Переключатель в карточке включает ручки и показывает кадр, если открыт ролик.
  const showHandlesOnFrame = (shown: boolean): void => {
    setHandles(shown);
    if (shown) setTab('frame');
  };
  // Ролик с эффектом есть и не снимается: пока эффект убирается, файл не держится плеером.
  const output = shot.applied && !!shot.output && !releasing;
  const byId = new Map(kinds.map((kind) => [kind.id, kind]));
  const missing = kinds.filter((kind) => !draft.some((step) => step.effect === kind.id));
  // Цепочка идёт в порядке реестра: свет раньше дождя, зерно последним.
  const ordered = (steps: EffectStep[]): EffectStep[] =>
    [...steps].sort((a, b) => kinds.findIndex((kind) => kind.id === a.effect) - kinds.findIndex((kind) => kind.id === b.effect));
  const status = !shot.applied ? texts.status.none : shot.stale ? texts.status.stale({ reason: shot.stale }) : texts.status.fresh;
  const fresh = shot.applied && !shot.stale;
  // Эффект с источником и лучом (свет): его ручки показывает общее превью.
  const beamIndex = draft.findIndex((step) => !!byId.get(step.effect)?.beam);
  const beamStep = beamIndex >= 0 ? draft[beamIndex] : null;
  const beamKind = beamStep ? byId.get(beamStep.effect) : undefined;
  const showHandles = handles && !!beamStep && !!beamKind?.beam && tab === 'frame';
  // Отметки моментов всех эффектов цепочки на общей шкале.
  const marks: PlanMark[] = draft.flatMap((step) => {
    const kind = byId.get(step.effect);
    if (!kind) return [];
    return kind.params
      .filter((spec) => kind.planTime.includes(spec.name))
      .map((spec) => ({ name: `${kind.id}.${spec.name}`, title: spec.title, seconds: fractionToSeconds(stepValue(step, spec), shot) }));
  });
  const mediaWidth = `min(100%, ${MEDIA_MAX_WIDTH}px, max(240px, ${Math.round(((layout.height - PANEL_CHROME) * 16) / 9)}px))`;
  const mediaBox = {
    position: 'relative',
    width: mediaWidth,
    aspectRatio: '16 / 9',
    bgcolor: 'action.hover',
    borderRadius: 1,
    overflow: 'hidden'
  } as const;

  const frameView = (
    <>
      <Box sx={mediaBox}>
        {showHandles && beamStep && beamKind?.beam ? (
          <BeamEditor
            beam={beamKind.beam}
            specs={beamKind.params}
            step={beamStep}
            frameUrl={preview.url}
            disabled={busy}
            onChange={(next) => onChange(draft.map((item, position) => (position === beamIndex ? next : item)))}
          />
        ) : preview.url ? (
          <Box
            component="img"
            src={preview.url}
            alt={texts.previewAlt({ shot: shot.shot, frame })}
            sx={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', opacity: preview.loading ? 0.6 : 1 }}
          />
        ) : null}
        {preview.loading ? (
          <Stack
            direction="row"
            spacing={1}
            sx={{ position: 'absolute', top: 8, left: 8, alignItems: 'center', bgcolor: 'background.paper', px: 1, borderRadius: 1, pointerEvents: 'none' }}
          >
            <CircularProgress size={14} aria-hidden />
            <Typography variant="caption">{texts.previewLoading}</Typography>
          </Stack>
        ) : null}
      </Box>
      {preview.error && !full ? (
        <Alert severity="error" sx={{ mt: 1, maxWidth: mediaWidth }}>
          <LinkedText text={preview.error} />
        </Alert>
      ) : null}
      <Box sx={{ mt: 1, width: mediaWidth }}>
        <PlanTimeline frames={shot.frames} fps={shot.fps} frame={frame} lines={shot.lines} lyricProblem={shot.lyricProblem} marks={marks} onFrame={onFrame} />
      </Box>
      {full ? (
        <FrameFullscreen
          url={preview.url}
          alt={texts.previewAlt({ shot: shot.shot, frame })}
          loading={preview.loading}
          error={preview.error}
          mode={mode}
          onMode={onMode}
          onClose={() => onFull(false)}
        />
      ) : null}
    </>
  );

  const videoView =
    video === 'before' ? (
      <Box sx={{ width: mediaWidth }}>
        <VideoPlayer key="before" path={shot.source} label={texts.videoBefore} />
      </Box>
    ) : output ? (
      <Box sx={{ width: mediaWidth }}>
        <VideoPlayer key="after" path={shot.output} version={shot.version} label={texts.videoAfter} />
      </Box>
    ) : (
      <Stack sx={{ ...mediaBox, alignItems: 'center', justifyContent: 'center', textAlign: 'center', p: 3 }} spacing={1.5}>
        {busy ? <CircularProgress size={28} aria-hidden /> : <MovieFilterIcon color="disabled" sx={{ fontSize: 48 }} aria-hidden />}
        <Typography color="text.secondary" sx={{ maxWidth: 520 }}>
          {busy ? texts.videoRendering : texts.videoNone}
        </Typography>
      </Stack>
    );

  const actions = (
    <Stack spacing={1} sx={{ minWidth: 0 }}>
      <Alert severity={fresh ? 'success' : shot.applied ? 'warning' : 'info'}>
        <LinkedText text={status} />
      </Alert>
      {dirty ? <Alert severity="warning">{texts.status.dirty}</Alert> : null}
      <ActionButton
        variant="contained"
        startIcon={<AutoAwesomeIcon />}
        title={texts.applyHint}
        disabled={!!reasons.apply}
        disabledReason={reasons.apply}
        onClick={onApply}
      >
        {texts.apply}
      </ActionButton>
      <ActionButton startIcon={<RestartAltIcon />} disabled={!!reasons.reset} disabledReason={reasons.reset} onClick={onReset}>
        {texts.reset}
      </ActionButton>
      {shot.applied ? (
        <DestructiveButton
          label={texts.removeTitle({ shot: shot.shot })}
          description={texts.removeDescription}
          confirmLabel={texts.removeEffect}
          startIcon={<LayersClearIcon />}
          variant="outlined"
          size="medium"
          disabled={!!reasons.remove}
          disabledReason={reasons.remove}
          onConfirm={onRemove}
        >
          {texts.removeEffect}
        </DestructiveButton>
      ) : null}
      <Divider />
      <ActionButton
        color="success"
        startIcon={<AddIcon />}
        disabled={busy || !missing.length}
        disabledReason={busy ? texts.busy : texts.addAll}
        onClick={(event) => setAddAnchor(event.currentTarget)}
      >
        {texts.add}
      </ActionButton>
      <Menu anchorEl={addAnchor} open={!!addAnchor} onClose={() => setAddAnchor(null)}>
        {missing.map((kind) => (
          <MenuItem
            key={kind.id}
            onClick={() => {
              setAddAnchor(null);
              onChange(ordered([...draft, { effect: kind.id, given: {} }]));
            }}
          >
            {kind.title}
          </MenuItem>
        ))}
      </Menu>
      <ActionButton
        startIcon={<ContentCopyIcon />}
        disabled={busy || !others.length}
        disabledReason={busy ? texts.busy : texts.copyFromNone}
        onClick={(event) => setCopyAnchor(event.currentTarget)}
      >
        {texts.copyFrom}
      </ActionButton>
      <Menu anchorEl={copyAnchor} open={!!copyAnchor} onClose={() => setCopyAnchor(null)}>
        {others.map((other) => (
          <MenuItem
            key={other.shot}
            onClick={() => {
              setCopyAnchor(null);
              onCopy(other);
            }}
          >
            {shotLabel(other)} · {other.steps.map((step) => byId.get(step.effect)?.title ?? step.effect).join(', ')}
          </MenuItem>
        ))}
      </Menu>
      {actionError ? (
        <Alert severity="error">
          <LinkedText text={actionError} />
        </Alert>
      ) : null}
      <JobStatus job={job ?? undefined} />
    </Stack>
  );

  return (
    <Stack sx={{ minWidth: 0 }} data-testid="effect-shot-panel">
      <Paper
        id={panelId}
        variant="outlined"
        data-testid="effect-preview-panel"
        sx={{
          position: 'sticky',
          top: layout.top,
          zIndex: (theme) => theme.zIndex.appBar - 2,
          p: 1.5,
          height: layout.height,
          overflowY: 'auto',
          bgcolor: 'background.paper'
        }}
      >
        <Stack spacing={1}>
          {navigation}
          {shot.problem ? (
            <Alert severity="error">
              <LinkedText text={shot.problem} />
            </Alert>
          ) : (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(240px, 320px)', gap: 2, alignItems: 'start' }}>
              <Box sx={{ minWidth: 0 }}>
                <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 1 }}>
                  <ToggleButtonGroup size="small" exclusive value={tab} onChange={(_, next: MediaTab | null) => next && setTab(next)} aria-label={texts.media}>
                    <ToggleButton value="frame">{texts.preview}</ToggleButton>
                    <ToggleButton value="video">{texts.video}</ToggleButton>
                  </ToggleButtonGroup>
                  {tab === 'frame' ? (
                    <ToggleButtonGroup
                      size="small"
                      exclusive
                      value={mode}
                      onChange={(_, next: PreviewMode | null) => next && onMode(next)}
                      aria-label={texts.previewCompare}
                    >
                      <ToggleButton value="before">{texts.previewBefore}</ToggleButton>
                      <ToggleButton value="after">{texts.previewAfter}</ToggleButton>
                    </ToggleButtonGroup>
                  ) : (
                    <ToggleButtonGroup
                      size="small"
                      exclusive
                      value={video}
                      onChange={(_, next: 'after' | 'before' | null) => next && setVideo(next)}
                      aria-label={texts.video}
                    >
                      <ToggleButton value="before">{texts.videoBefore}</ToggleButton>
                      <ToggleButton value="after">{texts.videoAfter}</ToggleButton>
                    </ToggleButtonGroup>
                  )}
                  {tab === 'frame' && beamKind ? (
                    <ToggleButton size="small" value="handles" selected={handles} title={texts.beam.toggleHint} onChange={() => showHandlesOnFrame(!handles)}>
                      <WbIncandescentOutlinedIcon fontSize="small" sx={{ mr: 0.5 }} aria-hidden />
                      {texts.beam.toggle({ title: beamKind.title })}
                    </ToggleButton>
                  ) : null}
                  {tab === 'frame' ? (
                    <Button
                      size="small"
                      startIcon={<FullscreenIcon />}
                      title={texts.previewHint}
                      sx={{ ml: 'auto' }}
                      disabled={!preview.url}
                      onClick={() => onFull(true)}
                    >
                      {componentsTexts.videoPlayer.fullscreen}
                    </Button>
                  ) : null}
                </Stack>
                {tab === 'frame' ? frameView : videoView}
              </Box>
              {actions}
            </Box>
          )}
        </Stack>
      </Paper>
      <Box sx={{ position: 'sticky', top: layout.top + layout.height, zIndex: (theme) => theme.zIndex.appBar - 2, bgcolor: 'background.default' }}>
        <SplitHandle
          value={layout.height}
          min={layout.min}
          max={layout.max}
          controls={panelId}
          label={texts.splitHeight}
          hint={texts.splitHint}
          valueText={texts.panelHeight}
          onChange={layout.onHeight}
        />
      </Box>
      {!shot.problem ? (
        <Stack spacing={1.5} sx={{ pt: 1 }}>
          <Typography variant="subtitle1">{texts.chain}</Typography>
          {!draft.length ? <Typography color="text.secondary">{texts.chainEmpty}</Typography> : null}
          {draft.map((step, index) => {
            const kind = byId.get(step.effect);
            return kind ? (
              <EffectStepCard
                key={step.effect}
                kind={kind}
                step={step}
                camera={shot.camera}
                heading={shot.heading}
                plan={{ shot, frame, handles, onHandles: showHandlesOnFrame }}
                disabled={busy}
                onChange={(next) => onChange(draft.map((item, position) => (position === index ? next : item)))}
                onRemove={() => onChange(draft.filter((_, position) => position !== index))}
              />
            ) : null;
          })}
        </Stack>
      ) : null}
    </Stack>
  );
}
