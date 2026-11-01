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
import type { LyricsLine, TimingLine, TimingSection, TimingView } from '@shared/types';
import { useApp } from '../../state';
import { Link as RouterLink } from 'react-router-dom';
import { TimingGenerateDialog, TimingLinesTable, TimingPlayer, TimingToolbar, UnassignedLyrics } from './components';
import { emptyTiming, MIN_LENGTH, round } from './timing';
import { useTimingPlayer } from './useTimingPlayer';
import { useHeaderHeight } from '../../components/headerHeight';
import { LinkedText } from '../../components/LinkedText';
import { validateTiming } from '@shared/timing-validation';
import { applyTimingBoundaryDrafts, parseTimingBoundary, type TimingBoundaryDrafts } from './manualTiming';

const MODEL_KEY = 'songframe.whisperModel';

export function TimingPage(): ReactElement {
  const { state, refresh, notify, describeError } = useApp();
  const project = state?.current ?? '';
  const [loadError, setLoadError] = useState<string | null>(null);
  const headerHeight = useHeaderHeight();
  const [view, setView] = useState<TimingView | null>(null);
  const [lines, setLines] = useState<TimingLine[]>([]);
  const [sections, setSections] = useState<TimingSection[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [boundaryDrafts, setBoundaryDrafts] = useState<TimingBoundaryDrafts>({});
  const [saveProblems, setSaveProblems] = useState<string[]>([]);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
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

  const updateLine = (id: number, patch: Partial<TimingLine>): void => {
    if (busy || generating) return;
    setSaveProblems([]);
    // Изменение на шкале заменяет только затронутые сырые поля, не стирая соседний ввод.
    if (patch.start !== undefined || patch.end !== undefined)
      setBoundaryDrafts((current) => {
        const next = { ...current, [id]: { ...current[id] } };
        if (patch.start !== undefined) delete next[id].start;
        if (patch.end !== undefined) delete next[id].end;
        if (!Object.keys(next[id]).length) delete next[id];
        return next;
      });
    // Ручной текст не нормализуем посреди ввода: служебная фраза меняется вместе с флажком.
    setLines((current) =>
      current.map((line) => {
        if (line.id !== id) return line;
        const updated = { ...line, ...patch };
        return patch.verified === undefined ? updated : withTimingVerification(updated);
      })
    );
    setDirty(true);
  };

  const onBoundaryInput = (id: number, field: 'start' | 'end', text: string): void => {
    if (busy || generating) return;
    // Нечисловая геометрия остаётся только в черновике. Ни blur, ни Enter не запускают проверку ручного режима.
    if (manualMode || boundaryDrafts[id]?.[field] !== undefined) updateLine(id, { [field]: parseTimingBoundary(text) });
    setBoundaryDrafts((current) => ({ ...current, [id]: { ...current[id], [field]: text } }));
    setSaveProblems([]);
    setDirty(true);
  };

  const player = useTimingPlayer({ view, lines, sections, selected, setSelected, updateLine, busy, generating, generateOpen, manualMode, describeError });
  const { duration, time, playLine, scrollTo } = player;

  const lyricsByNumber = useMemo(() => new Map((view?.lyrics ?? []).map((l) => [l.number, l])), [view]);
  const textOf = useCallback(
    (line: TimingLine) => lyricsByNumber.get(line.source_line)?.text ?? timingTexts.missingSourceLine({ line: line.source_line }),
    [lyricsByNumber]
  );
  const unassigned = useMemo<LyricsLine[]>(() => {
    const used = new Set(lines.map((l) => l.source_line));
    return (view?.lyrics ?? []).filter((l) => l.text && !l.header && !used.has(l.number));
  }, [view, lines]);
  const verifiedCount = lines.filter((l) => l.verified).length;
  const invalidBindings = selectLyricTimings(view?.timing?.lines ?? [], view?.lyrics ?? []).invalidIds.length > 0;
  const hasLyrics = !!view?.lyrics.some((line) => line.text && !line.header);
  const canGenerate = !!view?.trackPath && hasLyrics && !!state?.toolsRoot;

  const confirmAll = (): void => {
    if (busy || generating || verifiedCount === lines.length) return;
    // Как и флажок одной строки, массовое подтверждение остаётся правкой до нажатия «Сохранить».
    setLines((current) => current.map((line) => withTimingVerification(line, true)));
    setDirty(true);
  };

  const load = useCallback(async () => {
    setLoadError(null);
    const next = await window.api.timing.view(project);
    setView(next);
    const loaded = selectLyricTimings(next.timing?.lines ?? [], next.lyrics).lines;
    const normalized = loaded.map((line) => withTimingVerification(line));
    setLines(normalized);
    setSections(next.timing?.sections ?? []);
    // Нормализация отображения не является ручной правкой и не блокирует повторную разметку.
    // Файл остаётся прежним до явного сохранения; отмена правок всегда возвращает чистое состояние.
    setDirty(false);
    setBoundaryDrafts({});
    setSaveProblems([]);
    setSelected(null);
  }, [project]);

  useEffect(() => {
    load().catch((error) => setLoadError(describeError(error)));
  }, [load, notify, describeError]);

  const addLine = (lyric: LyricsLine): void => {
    const sorted = [...lines].sort((a, b) => a.start - b.start);
    const after = sorted.filter((l) => l.start < time).pop();
    const before = sorted.find((l) => l.start >= time);
    const start = manualMode ? time : Math.max(after?.end ?? 0, time);
    const end = manualMode ? Math.min(duration || start + 2, start + 2) : Math.min((before?.start ?? duration) || start + 2, start + 2);
    if (!manualMode && end - start < MIN_LENGTH) {
      notify(timingTexts.noRoomForLine, 'warning');
      return;
    }
    const id = Math.max(0, ...lines.map((l) => l.id)) + 1;
    setLines((current) => [
      ...current,
      {
        id,
        source_line: lyric.number,
        start: round(start),
        end: round(end),
        verified: false,
        // eslint-disable-next-line no-restricted-syntax -- Сохраняемая заметка строки timing.json остаётся у владельца формата данных.
        note: 'добавлена вручную'
      }
    ]);
    setSelected(id);
    setSaveProblems([]);
    setDirty(true);
  };

  const removeLine = (id: number): void => {
    setLines((current) => current.filter((l) => l.id !== id));
    if (selected === id) setSelected(null);
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
    const ordered = applyTimingBoundaryDrafts(lines, boundaryDrafts)
      .filter((line) => Number.isFinite(line.start) && Number.isFinite(line.end) && line.end >= line.start)
      .sort((a, b) => a.start - b.start)
      .map((line, index) => ({ ...line, id: index + 1 }));
    setSections(buildSections(view.lyrics, ordered, duration || null));
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
    const payload = { ...base, lines: applyTimingBoundaryDrafts(lines, boundaryDrafts), sections };
    // Проверка запускается только явным сохранением и совпадает с обязательной проверкой main перед записью.
    const problems = validateTiming(payload, view?.lyrics ?? [], duration || null);
    setSaveProblems(problems);
    if (problems.length) {
      notify(timingTexts.saveValidationFailed, 'error');
      return;
    }
    setBusy(true);
    try {
      const saved = await window.api.timing.save(project, payload);
      setView((current) => (current ? { ...current, timing: saved } : current));
      setLines(saved.lines);
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

  const generate = async (): Promise<void> => {
    if (dirty || busy || generating || !canGenerate) return;
    setGenerating(true);
    setGenerateOpen(false);
    try {
      localStorage.setItem(MODEL_KEY, model);
    } catch {
      /* тема и модель просто не запомнятся */
    }
    try {
      const result = await window.api.timing.generate(project, { model: model.trim() || undefined, device, reset: resetAll });
      if (result.code !== 0)
        throw new Error((result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ') || timingTexts.exitCode({ code: result.code }));
      await load();
      await refresh();
      notify(timingTexts.draftReady, 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setGenerating(false);
    }
  };

  // Пока данные страницы не готовы, общий прелоадер оболочки показывает индикатор.
  usePageLoading(!view && !loadError);
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

  if (!view) return <></>;

  // Причина недоступности разметки без учёта правок и операций: общая для панели и диалога.
  const generateBlockedReason = !view.trackPath
    ? timingTexts.addTrack
    : !hasLyrics
      ? timingTexts.addLyrics
      : !state?.toolsRoot
        ? timingTexts.toolsMissing
        : null;

  return (
    <Stack spacing={2} inert={busy || generating || undefined} aria-busy={busy || generating} sx={{ pb: 8 }}>
      <PageActionBar barRef={toolbarRef}>
        <TimingToolbar
          lineCount={lines.length}
          verifiedCount={verifiedCount}
          dirty={dirty}
          busy={busy}
          generating={generating}
          invalidBindings={invalidBindings}
          canGenerate={canGenerate}
          manualMode={manualMode}
          onManualModeChange={setManualMode}
          generateBlockedReason={generateBlockedReason}
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
      {manualMode && <Alert severity="info">{timingTexts.manualModeHint}</Alert>}
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
      <TimingLinesTable
        lines={lines}
        selected={selected}
        duration={duration}
        manualMode={manualMode}
        boundaryDrafts={boundaryDrafts}
        onBoundaryInput={manualMode || Object.keys(boundaryDrafts).length ? onBoundaryInput : undefined}
        textOf={textOf}
        onUpdate={updateLine}
        onPlay={playLine}
        onRemove={removeLine}
        onSelect={(line) => {
          setSelected(line.id);
          scrollTo(line.start);
        }}
      />
      {unassigned.length ? <UnassignedLyrics lyrics={unassigned} onAdd={addLine} /> : null}
      <TimingGenerateDialog
        open={generateOpen}
        model={model}
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
