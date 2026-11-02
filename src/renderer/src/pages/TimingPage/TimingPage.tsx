import { songTimingTexts } from '@shared/texts/song-timing';
import { timingTexts } from '@shared/texts/timing';
import { commonTexts } from '@shared/texts/common';
import { PageActionBar } from '../../components/PageActionBar';
import { usePageLoading } from '../../components/PageLoader';
import RefreshIcon from '@mui/icons-material/Refresh';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
/** Редактор таймингов: загрузка документа, правки и сохранение подтверждённых на слух строк. */
import { selectLyricTimings } from '@shared/lyrics';
import { withTimingVerification } from '@shared/timing-verification';
import { buildSections } from '@shared/timing-sections';
import { type ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/material';
import type { JobInfo, TimingLine, TimingSection, TimingView } from '@shared/types';
import { useApp } from '../../state';
import { Link as RouterLink } from 'react-router-dom';
import { TimingGenerateDialog, TimingPlayer, TimingToolbar } from './components';
import { emptyTiming } from './timing';
import { useTimingPlayer } from './useTimingPlayer';
import { useHeaderHeight } from '../../components/headerHeight';
import { LinkedText } from '../../components/LinkedText';
import { validateTiming } from '@shared/timing-validation';
import { applyTimingBoundaryDrafts, parseTimingBoundary, type TimingBoundaryDrafts } from './manualTiming';
import { timingEditorTexts } from '@shared/texts/timing-editor';
import {
  canVerifyEditorLine,
  collectEditorLines,
  editorLineOrder,
  editorTimingRows,
  sourceLyrics,
  stableTimingLines,
  visibleEditorRows,
  type TimingEditorFilter,
  type TimingCandidate
} from './timingEditor';
import { TimingLyricsEditor } from './components/TimingLyricsEditor';

const MODEL_KEY = 'songframe.whisperModel';

export function TimingPage(): ReactElement {
  const { state, refresh, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentProject = useRef(project);
  currentProject.current = project;
  const [loadError, setLoadError] = useState<string | null>(null);
  const headerHeight = useHeaderHeight();
  const [viewProject, setViewProject] = useState(project);
  const [view, setView] = useState<TimingView | null>(null);
  const [lines, setLines] = useState<TimingLine[]>([]);
  const [candidates, setCandidates] = useState<TimingCandidate[]>([]);
  const [lineOrder, setLineOrder] = useState<number[]>([]);
  const [sections, setSections] = useState<TimingSection[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editorFilter, setEditorFilter] = useState<TimingEditorFilter>('all');
  const [manualMode, setManualMode] = useState(false);
  const [boundaryDrafts, setBoundaryDrafts] = useState<TimingBoundaryDrafts>({});
  const [saveProblems, setSaveProblems] = useState<string[]>([]);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationJob, setGenerationJob] = useState<JobInfo | null>(null);
  const [generationWorking, setGenerationWorking] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [vocals, setVocals] = useState(false);
  const resultRead = useRef<string | null>(null);
  const [resultReady, setResultReady] = useState(false);
  const [model, setModel] = useState(() => {
    try {
      return localStorage.getItem(MODEL_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [device, setDevice] = useState<'auto' | 'cpu'>('auto');
  const [resetAll, setResetAll] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    // Высота действий меняется при переносе кнопок: шкала должна оставаться под ними.
    const updateHeight = (): void => setToolbarHeight(toolbar.getBoundingClientRect().height);
    const observer = new ResizeObserver(updateHeight);
    observer.observe(toolbar);
    updateHeight();
    return () => observer.disconnect();
  }, [view, loadError]);

  const editorRows = useMemo(() => editorTimingRows(view?.lyrics ?? [], lines, candidates, lineOrder), [view?.lyrics, lines, candidates, lineOrder]);

  const updateLine = (id: number, patch: Partial<TimingLine>): void => {
    if (busy || generating) return;
    setSaveProblems([]);
    if (patch.start !== undefined || patch.end !== undefined)
      setBoundaryDrafts((current) => {
        const next = { ...current, [id]: { ...current[id] } };
        if (patch.start !== undefined) delete next[id].start;
        if (patch.end !== undefined) delete next[id].end;
        if (!Object.keys(next[id]).length) delete next[id];
        return next;
      });
    const row = editorRows.find((line) => line.id === id);
    if (!row) return;
    if (patch.verified && !canVerifyEditorLine({ ...row, ...patch })) return;
    const candidate = candidates.find((item) => item.source_line === id);
    if (candidate && Object.keys(patch).every((key) => key === 'note')) {
      // Заметка уточняет сомнительное предложение, но сама не принимает его границы.
      setCandidates((current) => current.map((item) => (item.source_line === id ? { ...item, note: patch.note } : item)));
      setDirty(true);
      return;
    }
    // Предложение становится разметкой только после правки границ или явного подтверждения.
    const adopt = patch.start !== undefined || patch.end !== undefined || patch.verified === true;
    // Снятие подтверждения смешанной пары не принимает её кандидата: иначе копия в lines
    // заслонит следующие изменения заметки, единственным владельцем которой остаётся candidates.
    if (candidate && !adopt) return;
    const updated = { ...row, ...patch };
    const normalized = patch.verified === undefined ? updated : withTimingVerification(updated);
    setLines((current) => [...current.filter((line) => line.id !== id), normalized]);
    if (adopt) setCandidates((current) => current.filter((line) => line.source_line !== id));
    setDirty(true);
  };

  const onBoundaryInput = (id: number, field: 'start' | 'end', text: string): void => {
    if (busy || generating) return;
    updateLine(id, { [field]: parseTimingBoundary(text), verified: false });
    setBoundaryDrafts((current) => ({ ...current, [id]: { ...current[id], [field]: text } }));
    setSaveProblems([]);
    setDirty(true);
  };

  const player = useTimingPlayer({
    view,
    lines: editorRows,
    navigationLines: visibleEditorRows(editorRows, editorFilter),
    sectionLines: lines.filter((line) => !candidates.some((candidate) => candidate.source_line === line.source_line)),
    candidates,
    sections,
    selected,
    setSelected,
    updateLine,
    busy,
    generating,
    generateOpen,
    manualMode: true,
    describeError
  });
  const { duration, time, playLine, scrollTo } = player;
  const verifiedCount = editorRows.filter((line) => line.verified).length;
  const invalidBindings = selectLyricTimings(view?.timing?.lines ?? [], view?.lyrics ?? []).invalidIds.length > 0;
  const hasLyrics = !!view?.lyrics.some((line) => line.text && !line.header);
  const canGenerate = !!view?.trackPath && hasLyrics && !!state?.toolsRoot;

  const confirmAll = (): void => {
    if (busy || generating) return;
    const valid = editorRows.filter(canVerifyEditorLine);
    setLines((current) => [...current.filter((line) => !valid.some((row) => row.id === line.id)), ...valid.map((line) => withTimingVerification(line, true))]);
    setCandidates((current) => current.filter((candidate) => !valid.some((line) => line.source_line === candidate.source_line)));
    setDirty(true);
  };

  const load = useCallback(async () => {
    setLoadError(null);
    const next = await window.api.timing.view(project);
    if (!mounted.current || currentProject.current !== project) return;
    setView(next);
    setViewProject(project);
    const loaded = selectLyricTimings(next.timing?.lines ?? [], next.lyrics).lines;
    const normalized = loaded.map((line) => withTimingVerification(line));
    setLines(stableTimingLines(normalized));
    setCandidates(next.timing?.candidates ?? []);
    setLineOrder(editorLineOrder(next.lyrics, next.timing?.line_order));
    setSections(next.timing?.sections ?? []);
    // Нормализация отображения не является ручной правкой и не блокирует повторную разметку.
    // Файл остаётся прежним до явного сохранения; отмена правок всегда возвращает чистое состояние.
    setDirty(false);
    setBoundaryDrafts({});
    setSaveProblems([]);
    setSelected(null);
  }, [project]);

  useEffect(() => {
    load().catch((error) => {
      if (mounted.current && currentProject.current === project) setLoadError(describeError(error));
    });
  }, [load, project, describeError]);

  const removeLine = (id: number): void => {
    player.stopLine();
    setLines((current) => current.filter((l) => l.id !== id));
    setCandidates((current) => current.filter((candidate) => candidate.source_line !== id));
    setBoundaryDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setSaveProblems([]);
    setDirty(true);
  };

  /** Пересчёт заменяет музыкальную карту только в черновике; отмена возвращает исходные секции и заметки. */
  const recalculateSections = (): void => {
    if (busy || generating || invalidBindings || !lines.length || !view) return;
    // Примечания новых секций должны ссылаться на те же номера строк, которые запишет saveTiming.
    // Незаконченные поля не должны создавать NaN в музыкальной карте; сам черновик строк сохраняется.
    const ordered = applyTimingBoundaryDrafts(
      lines.filter((line) => !candidates.some((candidate) => candidate.source_line === line.source_line)),
      boundaryDrafts
    )
      .filter((line) => Number.isFinite(line.start) && Number.isFinite(line.end) && line.end >= line.start)
      .sort((a, b) => a.start - b.start)
      .map((line, index) => ({ ...line, id: index + 1 }));
    setSections(buildSections(view.lyrics, ordered, duration || null, candidates));
    setDirty(true);
    notify(timingTexts.sectionsRecalculated, 'info');
  };

  const save = async (): Promise<void> => {
    // Не удаляем скрытые устаревшие строки из файла побочным эффектом сохранения других правок.
    if (invalidBindings) {
      notify(timingTexts.lyricsChanged, 'warning');
      return;
    }
    const base = view?.timing ?? emptyTiming(duration || null);
    const collected = collectEditorLines(
      lines.filter((line) => !candidates.some((candidate) => candidate.source_line === line.source_line)),
      boundaryDrafts
    );
    const payload = { ...base, lines: collected.lines, sections, candidates, line_order: lineOrder };
    // Проверка запускается только явным сохранением и совпадает с обязательной проверкой main перед записью.
    const problems = [...collected.problems, ...validateTiming(payload, view?.lyrics ?? [], duration || null)];
    setSaveProblems(problems);
    if (problems.length) {
      notify(timingTexts.saveValidationFailed, 'error');
      return;
    }
    setBusy(true);
    try {
      const saved = await window.api.timing.save(project, payload);
      setView((current) => (current ? { ...current, timing: saved } : current));
      setLines(stableTimingLines(saved.lines));
      setCandidates(saved.candidates ?? []);
      setLineOrder(editorLineOrder(view?.lyrics ?? [], saved.line_order));
      setSections(saved.sections);
      setBoundaryDrafts({});
      setSaveProblems([]);
      setDirty(false);
      await refresh();
      notify(timingTexts.saved, 'success');
    } catch (error) {
      const message = describeError(error);
      setSaveProblems([message]);
      notify(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // Успех показываем только после чтения записанного файла. Ошибка чтения оставляет повтор в окне.
  const readGenerationResult = useCallback(async (): Promise<void> => {
    if (!generationJob || resultRead.current === generationJob.id) return;
    resultRead.current = generationJob.id;
    setGenerationWorking(true);
    setGenerationError(null);
    try {
      await load();
      if (!mounted.current || currentProject.current !== project) return;
      await refresh();
      if (!mounted.current || currentProject.current !== project) return;
      setResultReady(true);
      notify(songTimingTexts.ready, 'success');
    } catch (reason) {
      if (mounted.current && currentProject.current === project) setGenerationError(describeError(reason));
    } finally {
      if (mounted.current && currentProject.current === project) {
        resultRead.current = null;
        setGenerationWorking(false);
      }
    }
  }, [generationJob, load, project, refresh, notify, describeError]);

  // Задание переживает повторное открытие страницы; поздний ответ старого проекта не меняет новую форму.
  useEffect(() => {
    let active = true;
    setGenerationJob(null);
    setGenerating(false);
    setGenerationWorking(false);
    setGenerationError(null);
    setResultReady(false);
    resultRead.current = null;
    setGenerateOpen(false);
    void window.api.jobs
      .list()
      .then((jobs) => {
        if (!active) return;
        const running = jobs.find((job) => job.project === project && job.status === 'running' && job.steps.some((step) => step.tool === 'align_lyrics'));
        if (running) {
          setGenerationJob(running);
          setGenerating(true);
          setGenerateOpen(true);
          setVocals(running.steps.some((step) => step.label === songTimingTexts.vocals));
        }
      })
      .catch(() => {
        /* Ошибка восстановления не запрещает обычный просмотр документа. */
      });
    return () => {
      active = false;
    };
  }, [project]);

  useEffect(() => {
    if (generationJob?.status !== 'running') return;
    let active = true,
      polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void window.api.jobs
        .get(generationJob.id)
        .then((job) => {
          if (!active || !mounted.current || currentProject.current !== project) return;
          if (!job) {
            // Пропавшее наблюдение не доказывает остановку процесса: сохраняем явную ошибку без сообщения об успехе.
            setGenerationJob((current) => (current ? { ...current, status: 'interrupted', error: songTimingTexts.noJob } : null));
            setGenerating(false);
            setGenerationError(null);
            return;
          }
          if (job.status !== 'running') setGenerationError(null);
          setGenerationJob(job);
          if (job.status !== 'running') {
            if (job.status === 'done') setGenerationWorking(true);
            setGenerating(false);
          }
        })
        .catch((reason) => {
          if (active && mounted.current && currentProject.current === project) setGenerationError(describeError(reason));
        })
        .finally(() => {
          polling = false;
        });
    }, 750);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [generationJob?.id, generationJob?.status, project, describeError]);

  // Обрабатываем и быстрый terminal-ответ start/cancel: ему уже не нужен следующий опрос.
  useEffect(() => {
    if (generationJob?.status === 'done' && !resultReady && !generationError) void readGenerationResult();
  }, [generationJob?.status, resultReady, generationError, readGenerationResult]);

  const stopGeneration = async (): Promise<boolean> => {
    if (!generationJob || generationWorking) return false;
    setGenerationWorking(true);
    setGenerationError(null);
    try {
      let job = await window.api.timing.cancel(generationJob.id);
      // abort только запрашивает остановку. Закрывать окно разрешаем после завершения записи/процесса.
      while (job.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!mounted.current || currentProject.current !== project) return false;
        const next = await window.api.jobs.get(job.id);
        if (!next) throw new Error(songTimingTexts.noJob);
        job = next;
      }
      if (!mounted.current || currentProject.current !== project) return false;
      setGenerationJob(job);
      setGenerating(false);
      return true;
    } catch (reason) {
      if (mounted.current && currentProject.current === project) setGenerationError(describeError(reason));
      return false;
    } finally {
      if (mounted.current && currentProject.current === project) setGenerationWorking(false);
    }
  };
  const generate = async (): Promise<void> => {
    if (dirty || busy || generating || generationWorking || !canGenerate) return;
    setGenerationWorking(true);
    setGenerationError(null);
    setResultReady(false);
    setGenerationJob(null);
    try {
      if (typeof window.api.timing.start !== 'function') throw new Error(songTimingTexts.restart);
      try {
        localStorage.setItem(MODEL_KEY, model);
      } catch {
        /* Выбранная папка остаётся в открытой форме. */
      }
      const job = await window.api.timing.start(project, { model: model.trim() || undefined, device, reset: resetAll, vocals });
      if (!mounted.current || currentProject.current !== project) return;
      setGenerationJob(job);
      setGenerating(job.status === 'running');
    } catch (error) {
      if (mounted.current && currentProject.current === project) setGenerationError(describeError(error));
    } finally {
      if (mounted.current && currentProject.current === project) setGenerationWorking(false);
    }
  };

  // Пока данные страницы не готовы, общий прелоадер оболочки показывает индикатор.
  usePageLoading((!view || viewProject !== project) && !loadError);
  if (loadError)
    return (
      <Alert
        severity="error"
        action={
          <Button startIcon={<RefreshIcon />} onClick={() => load().catch((error) => setLoadError(describeError(error)))}>
            {commonTexts.retry}
          </Button>
        }
      >
        <LinkedText text={loadError} />
      </Alert>
    );

  if (!view || viewProject !== project) return <></>;

  // Причина недоступности разметки без учёта правок и операций: общая для панели и диалога.
  const generateBlockedReason = !view.trackPath
    ? timingTexts.addTrack
    : !hasLyrics
      ? timingTexts.addLyrics
      : !state?.toolsRoot
        ? timingTexts.toolsMissing
        : null;

  return (
    <Stack spacing={2} inert={busy || generating || generationWorking || undefined} aria-busy={busy || generating || generationWorking} sx={{ pb: 8 }}>
      <PageActionBar barRef={toolbarRef}>
        <TimingToolbar
          lineCount={sourceLyrics(view.lyrics).length}
          verifiedCount={verifiedCount}
          dirty={dirty}
          busy={busy || generationWorking}
          generating={generating}
          invalidBindings={invalidBindings}
          canGenerate={!!view.trackPath && !!state?.toolsRoot}
          manualMode={manualMode}
          onManualModeChange={(manual) => {
            player.stopLine();
            setManualMode(manual);
          }}
          generateBlockedReason={!view.trackPath ? timingTexts.addTrack : !state?.toolsRoot ? timingTexts.toolsMissing : null}
          onGenerate={() => setGenerateOpen(true)}
          onConfirmAll={confirmAll}
          onRecalculateSections={recalculateSections}
          onSave={save}
          onDiscard={() => load().catch((error) => setLoadError(describeError(error)))}
        />
      </PageActionBar>
      {view.problems.length || !view.trackPath || !hasLyrics ? (
        <Alert
          severity="warning"
          action={
            !view.trackPath || !hasLyrics ? (
              <Button startIcon={<FolderOpenIcon />} component={RouterLink} to="/project/sources">
                {timingTexts.openSources}
              </Button>
            ) : undefined
          }
        >
          <LinkedText text={timingTexts.sourceProblems({ trackMissing: !view.trackPath, problems: view.problems })} />
        </Alert>
      ) : null}
      {manualMode && <Alert severity="info">{timingEditorTexts.instruction}</Alert>}
      {!!saveProblems.length && (
        <Alert severity="error" aria-label={timingTexts.saveProblemsTitle}>
          <Stack spacing={0.5}>
            <Typography>{timingTexts.saveProblemsTitle}</Typography>
            {saveProblems.map((problem, index) => (
              <Typography key={`${index}:${problem}`} variant="body2">
                <LinkedText text={problem} />
              </Typography>
            ))}
          </Stack>
        </Alert>
      )}
      {lines.length ? (
        <Typography variant="body2" color="text.secondary">
          {timingTexts.sectionsHelp({ count: player.sections.length })}
        </Typography>
      ) : null}
      {/* Статус из файла разметки: черновик правок отражает чип в панели. */}
      {view.timing?.status ? (
        <Typography variant="caption" color="text.secondary">
          {timingTexts.fileStatus({ status: view.timing.status })}
        </Typography>
      ) : null}

      {view.trackPath ? <TimingPlayer player={player} lines={lines} stickyTop={headerHeight + toolbarHeight} /> : null}
      <TimingLyricsEditor
        lyrics={view.lyrics}
        filter={editorFilter}
        onFilterChange={setEditorFilter}
        rows={editorRows}
        candidates={candidates}
        order={lineOrder}
        drafts={boundaryDrafts}
        selected={selected}
        selectedIds={player.selectionIds}
        duration={duration}
        time={time}
        hasTrack={!!view.trackPath}
        playingLineId={player.playingLineId}
        loopingLineId={player.loopingLineId}
        onStop={player.stopLine}
        onInput={onBoundaryInput}
        onUpdate={updateLine}
        onPlay={playLine}
        onLoop={player.toggleLoop}
        onRemove={removeLine}
        onOrder={(order) => {
          setLineOrder(order);
          setDirty(true);
        }}
        onSelect={(id) => {
          player.stopLine();
          player.selectLine(id);
          const row = editorRows.find((line) => line.id === id);
          if (row) scrollTo(row.start);
        }}
      />
      <TimingGenerateDialog
        key={`local-${project}`}
        project={project}
        open={generateOpen}
        model={model}
        vocals={vocals}
        job={generationJob}
        working={generationWorking}
        error={generationError}
        resultReady={resultReady}
        onReloadResult={() => void readGenerationResult()}
        onVocalsChange={setVocals}
        onStop={stopGeneration}
        onCancelDownload={async (id) => {
          let job = await window.api.timing.cancel(id);
          while (job.status === 'running') {
            await new Promise((resolve) => setTimeout(resolve, 250));
            const next = await window.api.jobs.get(id);
            if (!next) throw new Error(songTimingTexts.modelJobMissing);
            job = next;
          }
        }}
        device={device}
        resetAll={resetAll}
        canGenerate={canGenerate && !dirty && !busy && !generating}
        generateBlockedReason={generating || busy ? timingTexts.operationPending : dirty ? timingTexts.saveBeforeGenerate : generateBlockedReason}
        onClose={() => setGenerateOpen(false)}
        onModelChange={setModel}
        onDeviceChange={setDevice}
        onResetChange={setResetAll}
        onGenerate={generate}
      />
    </Stack>
  );
}
