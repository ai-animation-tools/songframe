/**
 * Выбранный принятый план на странице «Эффекты»: состояние эффекта, вкладки «Кадр» (превью «до» и
 * «после», на весь экран — в полном размере) и «Ролик» (принятое видео и ролик с эффектом; пока
 * ролика нет — заглушка с пояснением), цепочка эффектов с параметрами, «Взять параметры с плана»,
 * «Применить» и «Убрать эффект». Рендер и файлы — в Go (effects.render/remove).
 */
import { useState, type ReactElement } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Menu,
  MenuItem,
  Paper,
  Slider,
  Stack,
  Tab,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import MovieFilterIcon from '@mui/icons-material/MovieFilter';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import LayersClearIcon from '@mui/icons-material/LayersClear';
import { shotLabel, type EffectKind, type EffectShot, type EffectStep } from '@shared/effects';
import { componentsTexts } from '@shared/texts/components';
import { effectsTexts as texts } from '@shared/texts/effects';
import { ActionButton } from '../../../components/ActionButton';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { JobStatus } from '../../../components/JobStatus';
import { LinkedText } from '../../../components/LinkedText';
import { VideoPlayer } from '../../../components/VideoPlayer';
import { formatClock } from '../../../format';
import type { JobInfo } from '@shared/types';
import type { PreviewMode } from '../useEffectsPage';
import { EffectStepCard } from './EffectStepCard';
import { FrameFullscreen } from './FrameFullscreen';

/** Вкладки медиа плана: кадр превью и ролик. */
type MediaTab = 'frame' | 'video';

/**
 * Ширина кадра, ролика и заглушки: умеренная и одинаковая на любом окне — вкладки не прыгают, а
 * параметры остаются рядом; крупно смотрят кнопкой «На весь экран».
 */
export const MEDIA_MAX_WIDTH = 640;

/** Место кадра и заглушки ролика. */
const MEDIA_BOX = {
  position: 'relative',
  width: '100%',
  maxWidth: MEDIA_MAX_WIDTH,
  aspectRatio: '16 / 9',
  bgcolor: 'action.hover',
  borderRadius: 1,
  overflow: 'hidden'
} as const;

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
  onChange(steps: EffectStep[]): void;
  onFrame(frame: number): void;
  onMode(mode: PreviewMode): void;
  onFull(full: boolean): void;
  onApply(): void;
  onReset(): void;
  onRemove(): void;
  onCopy(source: EffectShot): void;
}): ReactElement {
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [copyAnchor, setCopyAnchor] = useState<HTMLElement | null>(null);
  const [tab, setTab] = useState<MediaTab>('frame');
  const [video, setVideo] = useState<'after' | 'before'>('after');
  // Ролик с эффектом есть и не снимается: пока эффект убирается, файл не держится плеером.
  const output = shot.applied && !!shot.output && !releasing;
  const byId = new Map(kinds.map((kind) => [kind.id, kind]));
  const missing = kinds.filter((kind) => !draft.some((step) => step.effect === kind.id));
  // Цепочка идёт в порядке реестра: свет раньше дождя, зерно последним.
  const ordered = (steps: EffectStep[]): EffectStep[] =>
    [...steps].sort((a, b) => kinds.findIndex((kind) => kind.id === a.effect) - kinds.findIndex((kind) => kind.id === b.effect));
  const status = !shot.applied ? texts.status.none : shot.stale ? texts.status.stale({ reason: shot.stale }) : texts.status.fresh;
  const fresh = shot.applied && !shot.stale;

  if (shot.problem)
    return (
      <Stack spacing={2}>
        <Typography variant="h6">{shotLabel(shot)}</Typography>
        <Alert severity="error">
          <LinkedText text={shot.problem} />
        </Alert>
      </Stack>
    );

  return (
    <Stack spacing={2} sx={{ minWidth: 0 }} data-testid="effect-shot-panel">
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="h6" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          {shotLabel(shot)}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {formatClock(shot.start)}–{formatClock(shot.end)}
        </Typography>
        {fresh ? <Chip size="small" color="success" label={texts.fresh} /> : shot.applied ? <Chip size="small" color="warning" label={texts.stale} /> : null}
        {dirty ? <Chip size="small" color="warning" variant="outlined" label={texts.status.dirty} /> : null}
      </Stack>
      <Alert severity={fresh ? 'success' : shot.applied ? 'warning' : 'info'}>
        <LinkedText text={status} />
      </Alert>

      <Paper variant="outlined" sx={{ minWidth: 0 }}>
        <Tabs value={tab} onChange={(_, next: MediaTab) => setTab(next)} aria-label={texts.media} sx={{ borderBottom: 1, borderColor: 'divider', px: 1 }}>
          <Tab value="frame" label={texts.preview} id="effect-tab-frame" aria-controls="effect-panel-frame" />
          <Tab value="video" label={texts.video} id="effect-tab-video" aria-controls="effect-panel-video" />
        </Tabs>
        <Box sx={{ p: 2 }} role="tabpanel" id={`effect-panel-${tab}`} aria-labelledby={`effect-tab-${tab}`}>
          {tab === 'frame' ? (
            <>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={mode}
                onChange={(_, next: PreviewMode | null) => next && onMode(next)}
                aria-label={texts.previewCompare}
                sx={{ mb: 1 }}
              >
                <ToggleButton value="before">{texts.previewBefore}</ToggleButton>
                <ToggleButton value="after">{texts.previewAfter}</ToggleButton>
              </ToggleButtonGroup>
              <Box sx={MEDIA_BOX}>
                {preview.url ? (
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
                    sx={{ position: 'absolute', top: 8, left: 8, alignItems: 'center', bgcolor: 'background.paper', px: 1, borderRadius: 1 }}
                  >
                    <CircularProgress size={14} aria-hidden />
                    <Typography variant="caption">{texts.previewLoading}</Typography>
                  </Stack>
                ) : null}
              </Box>
              <Button size="small" startIcon={<FullscreenIcon />} sx={{ mt: 0.5 }} disabled={!preview.url} onClick={() => onFull(true)}>
                {componentsTexts.videoPlayer.fullscreen}
              </Button>
              {preview.error && !full ? (
                <Alert severity="error" sx={{ mt: 1 }}>
                  <LinkedText text={preview.error} />
                </Alert>
              ) : null}
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center', mt: 1 }}>
                <Typography variant="body2" id="effect-preview-frame" sx={{ flex: '0 0 auto' }}>
                  {texts.previewFrame}
                </Typography>
                <Slider
                  size="small"
                  min={0}
                  max={Math.max(0, shot.frames - 1)}
                  step={1}
                  value={frame}
                  aria-labelledby="effect-preview-frame"
                  valueLabelDisplay="auto"
                  onChange={(_, value) => onFrame(Array.isArray(value) ? value[0] : value)}
                />
                <Typography variant="body2" color="text.secondary" sx={{ flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }}>
                  {frame} / {Math.max(0, shot.frames - 1)}
                </Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {texts.previewHint}
              </Typography>
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
          ) : (
            <>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={video}
                onChange={(_, next: 'after' | 'before' | null) => next && setVideo(next)}
                aria-label={texts.video}
                sx={{ mb: 1 }}
              >
                <ToggleButton value="before">{texts.videoBefore}</ToggleButton>
                <ToggleButton value="after">{texts.videoAfter}</ToggleButton>
              </ToggleButtonGroup>
              {video === 'before' ? (
                <Box sx={{ maxWidth: MEDIA_MAX_WIDTH }}>
                  <VideoPlayer key="before" path={shot.source} label={texts.videoBefore} />
                </Box>
              ) : output ? (
                <Box sx={{ maxWidth: MEDIA_MAX_WIDTH }}>
                  <VideoPlayer key="after" path={shot.output} version={shot.version} label={texts.videoAfter} />
                </Box>
              ) : (
                <Stack sx={{ ...MEDIA_BOX, alignItems: 'center', justifyContent: 'center', textAlign: 'center', p: 3 }} spacing={1.5}>
                  {busy ? <CircularProgress size={28} aria-hidden /> : <MovieFilterIcon color="disabled" sx={{ fontSize: 48 }} aria-hidden />}
                  <Typography color="text.secondary" sx={{ maxWidth: 520 }}>
                    {busy ? texts.videoRendering : texts.videoNone}
                  </Typography>
                </Stack>
              )}
            </>
          )}
        </Box>
      </Paper>

      <Stack spacing={1.5}>
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
              plan={{ shot, frame, frameUrl: preview.url, onFrame }}
              disabled={busy}
              onChange={(next) => onChange(draft.map((item, position) => (position === index ? next : item)))}
              onRemove={() => onChange(draft.filter((_, position) => position !== index))}
            />
          ) : null;
        })}
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
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
        </Stack>
      </Stack>

      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
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
      </Stack>
      {actionError ? (
        <Alert severity="error">
          <LinkedText text={actionError} />
        </Alert>
      ) : null}
      <JobStatus job={job ?? undefined} />
    </Stack>
  );
}
