import { navigationTexts } from '@shared/texts/navigation';
import { commonTexts } from '@shared/texts/common';
import { montageTexts } from '@shared/texts/montage';
import { Refresh, OpenInNew, CallReceived } from '@mui/icons-material';
import { usePageLoading } from '../../components/PageLoader';
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Alert, Box, Button, FormControl, InputLabel, MenuItem, Paper, Select, Stack, TextField, Typography } from '@mui/material';
import { VideoLibrary } from '@mui/icons-material';
import type { MontageSource } from '@shared/montage';
import { FPS } from '@shared/video';
import { ActionButton } from '../../components/ActionButton';
import { ActionIconButton } from '../../components/ActionIconButton';
import { DateTime } from '../../components/DateTime';
import { ScenarioRequired } from '../../components/ScenarioRequired';
import {
  MontageApplyDialog,
  MontageAudioRange,
  MontageClipEditor,
  MontageDiscardDialog,
  MontagePreview,
  MontageSourcesDrawer,
  MontageShortcuts,
  MontageTimeline,
  SourceMetadata
} from './components';
import { moveClip, projectMediaUrl, samePath } from './model';
import { useMontage } from './useMontage';
import { useMontageRemove } from './useMontageRemove';
import { MontageRemoveDialog } from './components/MontageRemoveDialog';
import { MontageMaterialDialog } from './components/MontageMaterialDialog';
import { MontageSplitHandle } from './components/MontageSplitHandle';
import { MontageActionBar } from './components/MontageActionBar';
import { MontageExportDialog } from './components/MontageExportDialog';
import { useThemeMode } from '../../theme';
import { useDetachedMontage } from './useDetachedMontage';
import { useHeaderHeight } from '../../components/headerHeight';
import { LinkedText } from '../../components/LinkedText';

const SPLIT_KEY = 'montage-preview-split';
const DIVIDER_HEIGHT = 20;

/** Рабочая область монтируется заново при смене проекта или набора сцен, включая все медиаплееры. */
export function MontageWorkspace({ project, shots, preferred = {} }: { project: string; shots: string[]; preferred?: Record<string, string> }): ReactElement {
  const page = useMontage(project, shots, preferred);
  const savedLabelId = useId();
  const previewPanelId = useId();
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const headerHeight = useHeaderHeight();
  const [detachedFraction, setDetachedFraction] = useState(0.25);
  const [loop, setLoop] = useState(false);
  const [volume, setVolume] = useState(100);
  const { mode: theme } = useThemeMode();
  const [previewFraction, setPreviewFraction] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(SPLIT_KEY));
      return saved >= 0.05 && saved <= 0.95 ? saved : 0.42;
    } catch {
      return 0.42;
    }
  });
  useLayoutEffect(() => {
    const resize = (): void => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const [actionBar, setActionBar] = useState<HTMLDivElement | null>(null);
  const [actionBarHeight, setActionBarHeight] = useState(0);
  useLayoutEffect(() => {
    if (!actionBar) return;
    // Высота панели меняется при переносе кнопок: плеер должен оставаться под ней.
    const update = (): void => setActionBarHeight(actionBar.getBoundingClientRect().height);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(actionBar);
    return () => observer.disconnect();
  }, [actionBar]);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const [trackFrames, setTrackFrames] = useState<number | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [material, setMaterial] = useState<MontageSource | null>(null);
  const [videoOpen, setVideoOpen] = useState(false);
  const lengthStatus = useRef<HTMLDivElement>(null);
  const { view, draft, commit, job } = page;
  const running = job?.status === 'running';
  const locked = page.busy || running;
  const lockedReason = running ? montageTexts.jobPending : commonTexts.operationPending;
  const selectedClip = draft.clips.find((clip) => clip.id === page.selected);
  // Результат попытки на дорожке подписывается явно: пользователь сравнивает его с принятым клипом, а не наоборот.
  const attemptsOnTrack = draft.clips.flatMap((clip) => {
    const source = page.sources.find((item) => item.scene === clip.scene && samePath(item.path, clip.path));
    return source?.attempt ? [{ scene: clip.scene, label: source.label }] : [];
  });
  // Галерея повторяет порядок каталога: сцены по реестру, затем все варианты материала внутри карточки.
  const galleryMaterials = useMemo(
    () => (view?.scenes ?? []).flatMap((scene) => page.sources.filter((source) => source.scene === scene.id)),
    [view?.scenes, page.sources]
  );
  const materialIndex = material ? galleryMaterials.findIndex((source) => source.id === material.id) : -1;
  const remove = useMontageRemove({
    project,
    clip: selectedClip,
    locked,
    blocked: sourcesOpen || page.applyOpen || videoOpen || pendingOpen !== null || material !== null || view?.scenarioStatus !== 'ready',
    onRemove: (id) => {
      commit({ ...draft, clips: draft.clips.filter((clip) => clip.id !== id) });
      page.setSelected(null);
    }
  });
  const trackUrl = draft.audio.path ? projectMediaUrl(project, draft.audio.path) : null;
  const suspended = sourcesOpen || page.applyOpen || videoOpen || pendingOpen !== null || remove.target !== null || material !== null || locked;
  const suspendedReason = locked ? lockedReason : montageTexts.closeDialogToWatch;
  const detachedPlayer = useDetachedMontage(
    { project, draft, trackUrl, frame: page.frame, seekVersion: page.seekVersion, selectedClipId: page.selected, suspended, theme, loop, volume },
    {
      onFrame: page.setFrame,
      onMetadata: page.onMetadata,
      onTrackFrames: setTrackFrames,
      onPreferences: (nextLoop, nextVolume) => {
        setLoop(nextLoop);
        setVolume(nextVolume);
      },
      onError: (error) => page.notify(montageTexts.playerWindowFailed(String(error)), 'error')
    }
  );
  const metadataSources = useMemo(() => {
    const paths = new Set(page.sources.map((source) => source.path));
    const extra: MontageSource[] = draft.clips
      .filter((clip) => !paths.has(clip.path))
      .map((clip) => ({
        id: clip.id,
        scene: clip.scene,
        title: clip.scene,
        label: clip.path,
        path: clip.path,
        kind: clip.kind,
        frames: clip.source_frames,
        original: false
      }));
    return [...page.sources, ...extra];
  }, [page.sources, draft.clips]);
  // Пока данные страницы не готовы, общий прелоадер оболочки показывает индикатор.
  usePageLoading(!view && !page.error);
  if (!view)
    return page.error ? (
      <Alert
        severity="error"
        action={
          <Button startIcon={<Refresh />} onClick={() => void page.load()}>
            {commonTexts.retry}
          </Button>
        }
      >
        <LinkedText text={page.error} />
      </Alert>
    ) : (
      <></>
    );
  if (view.scenarioStatus !== 'ready')
    return <ScenarioRequired title={navigationTexts.pages.montage} status={view.scenarioStatus} onRefresh={() => void page.load()} />;
  const boundsProblem = trackFrames !== null && draft.audio.end_frame_exclusive > trackFrames ? montageTexts.audioPastEnd : null;
  const exportProblem = boundsProblem ?? page.exportProblem;
  const exportProblemLabel = boundsProblem ? montageTexts.pastEndLabel : page.exportProblemLabel;
  const requestOpen = (id: string): void => {
    if (page.dirty) setPendingOpen(id);
    else if (id === '__refresh') void page.load();
    else void page.open(id);
  };
  const previewTop = headerHeight + actionBarHeight + 8;
  // Вся доступная высота делится между панелями; маленькое окно допускает их внутреннюю прокрутку.
  const availableHeight = Math.max(220, viewportHeight - previewTop - 24 - DIVIDER_HEIGHT);
  const minPreviewHeight = Math.min(180, availableHeight / 2);
  const maxPreviewHeight = Math.max(minPreviewHeight, availableHeight - 180);
  const previewHeight = Math.min(
    maxPreviewHeight,
    Math.max(minPreviewHeight, availableHeight * (detachedPlayer.detached ? detachedFraction : previewFraction))
  );
  const timelineHeight = availableHeight - previewHeight;
  const setSplitHeight = (height: number): void => {
    const fraction = height / availableHeight;
    if (detachedPlayer.detached) {
      setDetachedFraction(fraction);
      return;
    }
    setPreviewFraction(fraction);
    try {
      localStorage.setItem(SPLIT_KEY, String(fraction));
    } catch {
      // Недоступное локальное хранилище не мешает менять компоновку текущего окна.
    }
  };

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <MontageActionBar
        barRef={setActionBar}
        locked={locked}
        running={running}
        jobAction={page.jobAction}
        jobFailed={job?.status === 'failed'}
        exportReady={page.exportReady}
        busy={page.busy}
        name={draft.name}
        dirty={page.dirty}
        saved={!!page.savedId}
        hasAudio={!!draft.audio.path}
        canUndo={page.history.past.length > 0}
        canRedo={page.history.future.length > 0}
        exportProblem={exportProblem}
        exportProblemLabel={exportProblemLabel}
        stale={page.stale}
        onUndo={() => page.dispatch({ type: 'undo' })}
        onRedo={() => page.dispatch({ type: 'redo' })}
        onSave={() => void page.save()}
        onSaveAsNew={() => void page.save(true)}
        onReopen={() => requestOpen('__refresh')}
        onExport={() => void page.exportVideo()}
        onApply={() => page.setApplyOpen(true)}
        onShowProblem={() => lengthStatus.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        onOpenVideo={() => setVideoOpen(true)}
        onSaveVideo={() => void page.saveVideo()}
      />
      {view.problems.length ? (
        <Alert severity="warning">
          {view.problems.map((problem, index) => (
            <div key={index}>
              <LinkedText text={problem} />
            </div>
          ))}
        </Alert>
      ) : null}
      {attemptsOnTrack.length ? (
        <Alert severity="warning">
          {attemptsOnTrack.map((item) => (
            <div key={item.scene}>{montageTexts.attemptOnTrack({ scene: item.scene, label: item.label })}</div>
          ))}
        </Alert>
      ) : null}
      {page.stale ? <Alert severity="warning">{montageTexts.staleDraft}</Alert> : null}
      {/* Общий контейнер продолжается до конца дорожки: sticky не ограничивается высотой первого ряда. */}
      <Stack sx={{ width: '100%', minWidth: 0 }}>
        <Paper
          id={previewPanelId}
          variant="outlined"
          sx={{
            position: 'sticky',
            top: previewTop,
            zIndex: (theme) => theme.zIndex.appBar - 2,
            p: 1,
            minWidth: 0,
            width: '100%',
            height: previewHeight,
            overflowY: 'auto',
            bgcolor: 'background.paper'
          }}
        >
          {/* При узком окне плеер и обрезка идут столбцом; внутренняя прокрутка сохраняет место для дорожки. */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr)',
              '@container workspace (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' },
              gap: 2,
              alignItems: 'start'
            }}
          >
            <Box sx={{ width: '100%', minWidth: 0 }}>
              {!detachedPlayer.detached ? (
                <MontagePreview
                  project={project}
                  draft={draft}
                  selectedClipId={page.selected}
                  trackUrl={trackUrl}
                  frame={page.frame}
                  seekVersion={page.seekVersion}
                  onFrame={page.setFrame}
                  onMetadata={page.onMetadata}
                  onTrackFrames={setTrackFrames}
                  loop={loop}
                  volume={volume}
                  onPreferences={(nextLoop, nextVolume) => {
                    setLoop(nextLoop);
                    setVolume(nextVolume);
                  }}
                  videoMaxWidth={`min(100%, max(200px, ${(previewHeight - 190) * 1.7778}px))`}
                  suspended={suspended}
                  suspendedReason={suspendedReason}
                  actions={
                    <ActionIconButton aria-label={montageTexts.detachPlayer} onClick={detachedPlayer.open} disabled={locked} disabledReason={lockedReason}>
                      <OpenInNew />
                    </ActionIconButton>
                  }
                />
              ) : (
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography color="text.secondary">{montageTexts.playerDetached}</Typography>
                  <ActionButton startIcon={<CallReceived />} onClick={detachedPlayer.close} disabled={locked} disabledReason={lockedReason}>
                    {montageTexts.returnPlayer}
                  </ActionButton>
                </Stack>
              )}
              {/* Подсказки относятся к управлению просмотром и остаются рядом с ним. */}
              <Box sx={{ mt: 1 }}>
                <MontageShortcuts />
              </Box>
            </Box>
            <Stack spacing={1.5} sx={{ minWidth: 0 }}>
              <Paper variant="outlined" sx={{ p: 2, pointerEvents: locked ? 'none' : undefined, opacity: locked ? 0.7 : 1 }}>
                <Stack spacing={1.5}>
                  <TextField
                    key={`name-${page.savedId}-${draft.name}`}
                    size="small"
                    label={montageTexts.draftName}
                    defaultValue={draft.name}
                    onBlur={(event) => commit({ ...draft, name: event.target.value.trim() || montageTexts.defaultName })}
                    fullWidth
                  />
                  <FormControl size="small" fullWidth>
                    <InputLabel id={savedLabelId}>{montageTexts.openDraft}</InputLabel>
                    <Select
                      labelId={savedLabelId}
                      label={montageTexts.openDraft}
                      value=""
                      disabled={locked || !view.saved.length}
                      onChange={(event) => requestOpen(event.target.value)}
                    >
                      {view.saved.map((saved) => (
                        <MenuItem key={saved.id} value={saved.id}>
                          {saved.name} · <DateTime value={saved.updatedAt} />
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Stack>
              </Paper>
              {/* Материалы открываются из того же блока, в котором редактируется выбранный фрагмент. */}
              <Button
                sx={{ alignSelf: 'flex-start' }}
                variant="outlined"
                startIcon={<VideoLibrary />}
                onClick={() => setSourcesOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={sourcesOpen}
              >
                {montageTexts.sceneMaterials}
              </Button>
              <Box sx={{ minWidth: 0, pointerEvents: locked ? 'none' : undefined, opacity: locked ? 0.7 : 1 }}>
                <MontageClipEditor
                  draft={draft}
                  clip={selectedClip}
                  title={view.scenes.find((scene) => scene.id === selectedClip?.scene)?.title}
                  onChange={commit}
                  disabled={locked}
                  disabledReason={lockedReason}
                  onRequestRemove={remove.request}
                />
              </Box>
            </Stack>
          </Box>
        </Paper>
        <Box sx={{ position: 'sticky', top: previewTop + previewHeight, zIndex: (theme) => theme.zIndex.appBar - 2, bgcolor: 'background.default' }}>
          <MontageSplitHandle value={previewHeight} min={minPreviewHeight} max={maxPreviewHeight} controls={previewPanelId} onChange={setSplitHeight} />
        </Box>
        {/* Длинная дорожка прокручивается под закреплённым блоком и не прячется за ним в конце страницы. */}
        <Paper
          variant="outlined"
          sx={{
            p: 2,
            height: timelineHeight,
            overflowY: 'auto',
            pointerEvents: locked ? 'none' : undefined,
            opacity: locked ? 0.7 : 1
          }}
        >
          <Stack spacing={2}>
            <MontageTimeline
              draft={draft}
              trackUrl={trackUrl}
              lyricLines={draft.audio.path === view.trackPath ? view.lyricLines : []}
              lyricProblem={draft.audio.path === view.trackPath ? view.lyricProblem : montageTexts.differentTrack}
              duration={trackFrames === null ? (view.duration ?? 0) : trackFrames / FPS}
              frame={page.frame}
              selected={page.selected}
              onSelect={page.setSelected}
              onSeek={(frame) => page.seek(Math.max(0, Math.min(page.audioLength - 1, frame)))}
              onChange={commit}
              onDropSource={page.addSource}
              onMove={(id, before) => commit({ ...draft, clips: moveClip(draft.clips, id, before) })}
            />
            <MontageAudioRange draft={draft} trackFrames={trackFrames} onChange={commit} />
            {exportProblem ? (
              <Alert ref={lengthStatus} severity="warning">
                {exportProblem}
              </Alert>
            ) : (
              <Alert severity="success">{montageTexts.lengthsMatch(page.length)}</Alert>
            )}
          </Stack>
        </Paper>
      </Stack>
      <MontageSourcesDrawer
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        disabled={locked}
        project={project}
        sources={page.sources}
        scenes={view.scenes}
        clips={draft.clips}
        selectedClipId={page.selected}
        onSelectClip={page.setSelected}
        onPreview={setMaterial}
        onAdd={page.addSource}
      />
      <SourceMetadata project={project} sources={metadataSources} onMetadata={page.onMetadata} />
      {material ? (
        <MontageMaterialDialog
          key={project}
          project={project}
          source={material}
          position={Math.max(0, materialIndex)}
          total={galleryMaterials.length || 1}
          onPrevious={materialIndex > 0 ? () => setMaterial(galleryMaterials[materialIndex - 1]) : undefined}
          onNext={materialIndex >= 0 && materialIndex < galleryMaterials.length - 1 ? () => setMaterial(galleryMaterials[materialIndex + 1]) : undefined}
          onClose={() => setMaterial(null)}
        />
      ) : null}
      {page.video && page.exportReady ? (
        <MontageExportDialog
          open={videoOpen}
          url={projectMediaUrl(project, page.video)}
          busy={page.busy}
          onClose={() => setVideoOpen(false)}
          onSave={() => void page.saveVideo()}
        />
      ) : null}
      <MontageRemoveDialog scene={remove.target?.scene} onClose={remove.close} onConfirm={remove.confirm} />
      <MontageApplyDialog
        open={page.applyOpen}
        draft={draft}
        view={view}
        busy={page.busy}
        onClose={() => page.setApplyOpen(false)}
        onApply={() => void page.apply()}
      />
      <MontageDiscardDialog
        open={pendingOpen !== null}
        onClose={() => setPendingOpen(null)}
        onContinue={() => {
          const id = pendingOpen;
          setPendingOpen(null);
          if (id === '__refresh') void page.load();
          else if (id) void page.open(id);
        }}
      />
    </Stack>
  );
}
