/** Модель ручной разметки использует рабочие таблицу, панель и плеер, сохраняя документ только в памяти. */
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { Alert, Box, Stack, Typography } from '@mui/material';
import { timingTexts } from '@shared/texts/timing';
import { withTimingVerification } from '@shared/timing-verification';
import { buildSections, resolveTimingSections } from '@shared/timing-sections';
import type { TimingFile, TimingLine, TimingView } from '@shared/types';
import { ActionButton } from '../components/ActionButton';
import { TimingLinesTable } from '../pages/TimingPage/components/TimingLinesTable';
import { TimingPlayer } from '../pages/TimingPage/components/TimingPlayer';
import { TimingToolbar } from '../pages/TimingPage/components/TimingToolbar';
import { emptyTiming, round } from '../pages/TimingPage/timing';
import { useTimingPlayer } from '../pages/TimingPage/useTimingPlayer';
import { createStoryApi, storyFileUrl, STORY_TRACK_PATH, type StoryOptions } from './storybook';

// Длительности опубликованного MP3 совпадают с manifest и timing.json проекта-образца: декодированный звук и контейнер различаются.
const STORY_TIMING_DURATION = 30;
const STORY_TRACK_CONTAINER_DURATION = 30.040816;

export type TimingStoryVariant = 'regular' | 'long' | 'long-list' | 'empty' | 'media-error' | 'missing-track' | 'invalid-bindings';
export interface TimingStoryProps {
  variant?: TimingStoryVariant;
  showPlayer?: boolean;
  delayedMedia?: boolean;
  failSaveOnce?: boolean;
}

/** Пересчёт секций и сохранение используют последовательные номера в хронологическом порядке, как TimingPage. */
function orderedTimingStoryLines(lines: TimingLine[]): TimingLine[] {
  return [...lines].sort((first, second) => first.start - second.start).map((line, index) => ({ ...line, id: index + 1 }));
}

/** Повторяет нормализацию ответа main, а общие правила заметок и секций берёт из рабочих чистых функций. @link src/main/timing.ts */
function normalizeTimingStoryFile(timing: TimingFile, view: TimingView): TimingFile {
  const lines = orderedTimingStoryLines(timing.lines).map((line) =>
    withTimingVerification({ ...line, start: round(line.start), end: round(line.end), note: (line.note ?? '').trim() })
  );
  const verified = lines.filter((line) => line.verified).length;
  const base = timing.status.replace(/;\s*подтверждено на слух.*$/, '').replace(/\.$/, '');
  const duration = timing.duration_container ?? view.duration;
  return {
    version: 2,
    status:
      lines.length && verified === lines.length
        ? 'Разметка подтверждена на слух.'
        : `${base || 'Разметка'}; подтверждено на слух ${verified} из ${lines.length} строк.`,
    source: 'source/track.mp3',
    sha256: view.trackSha256 ?? timing.sha256 ?? null,
    duration_decoded: timing.duration_decoded ?? duration,
    duration_container: duration,
    clock: emptyTiming(duration).clock,
    lines,
    sections: resolveTimingSections(timing.sections, view.lyrics, lines, duration)
  };
}

/** Границы коротких строк позволяют проверить реальную остановку audio, не ожидая целого куплета. */
export function makeTimingStoryView(variant: TimingStoryVariant = 'regular', delayedMedia = false): TimingView {
  const lines: TimingLine[] = [
    { id: 1, source_line: 2, start: 0.3, end: 0.8, verified: false, note: 'сверка на слух не выполнена; начало куплета' },
    { id: 2, source_line: 3, start: 1.2, end: 2.2, verified: true, note: 'сверка на слух выполнена' },
    { id: 3, source_line: 4, start: 2.6, end: 3.6, verified: false, note: '' }
  ];
  if (variant === 'long-list') {
    lines.splice(
      0,
      lines.length,
      ...Array.from({ length: 20 }, (_, index) => ({
        id: index + 1,
        source_line: index + 2,
        start: round(index + 0.1),
        end: round(index + 0.7),
        verified: false,
        note: ''
      }))
    );
  }
  return {
    timing: {
      ...emptyTiming(STORY_TIMING_DURATION),
      duration_container: STORY_TRACK_CONTAINER_DURATION,
      lines: variant === 'empty' ? [] : lines,
      status: 'Черновик'
    },
    lyrics:
      variant === 'long-list'
        ? lines.map((line) => ({ number: line.source_line!, text: `Строка песни ${line.id}: дорога ведёт к старым воротам.`, header: false }))
        : [
            { number: 1, text: '[Куплет]', header: true },
            {
              number: 2,
              text:
                variant === 'long'
                  ? 'До рассвета тянется дорога мимо старых ворот и садового товарищества с бесконечно длинным названием. '.repeat(3)
                  : 'У старых ворот начинается утро',
              header: false
            },
            { number: 3, text: 'Сосед торопливо заводит мотор', header: false },
            { number: 4, text: 'И снова зовёт нас знакомая дорога', header: false }
          ],
    trackPath: variant === 'missing-track' ? null : variant === 'media-error' ? '/mock/missing-timing-track.mp3' : STORY_TRACK_PATH,
    trackSha256: delayedMedia ? 'timing-delayed' : 'timing-regular',
    duration: STORY_TIMING_DURATION,
    problems: []
  };
}

/** Сохранение заменяет только снимок сессии; намеренная ошибка позволяет повторить действие с тем же черновиком. */
export function timingStoryOptions({ variant = 'regular', delayedMedia = false, failSaveOnce = false }: TimingStoryProps = {}): StoryOptions {
  return {
    route: '/project/timing',
    createApi: () => {
      let view = makeTimingStoryView(variant, delayedMedia);
      let failed = false;
      const session = createStoryApi({
        timing: {
          view: async () => structuredClone(view),
          save: async (_project, timing) => {
            if (failSaveOnce && !failed) {
              failed = true;
              throw new Error('Не удалось сохранить разметку. Правки остались в форме; повторите сохранение.');
            }
            const normalized = normalizeTimingStoryFile(timing, view);
            view = { ...view, timing: structuredClone(normalized) };
            return structuredClone(normalized);
          }
        }
      });
      if (delayedMedia) {
        // Задерживаем только fetch волны с меткой этой истории: audio загружает штатный MP3 без подмены браузерных API.
        const originalFetch = window.fetch;
        const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
        const delayedFetch: typeof window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url !== `${storyFileUrl(STORY_TRACK_PATH)}?v=timing-delayed`) return originalFetch(input, init);
          return new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(timer);
              originalFetch(input, init).then(resolve, reject);
            }, 1400);
            pending.set(timer, () => reject(new DOMException('История закрыта', 'AbortError')));
          });
        };
        window.fetch = delayedFetch;
        session.onCleanup(() => {
          if (window.fetch === delayedFetch) window.fetch = originalFetch;
          for (const [timer, reject] of pending) {
            clearTimeout(timer);
            reject();
          }
          pending.clear();
        });
      }
      return session;
    }
  };
}

/** Черновик и сохранённый снимок разделены, как на странице; сброс перемонтирует поля и очищает выбор/аудио. */
export function TimingStory({ variant = 'regular', showPlayer = false, delayedMedia = false }: TimingStoryProps): ReactElement {
  const initial = useRef(makeTimingStoryView(variant, delayedMedia));
  const [saved, setSaved] = useState<TimingFile>(() => structuredClone(initial.current.timing!));
  const [draft, setDraft] = useState<TimingFile>(() => structuredClone(initial.current.timing!));
  const [trackPath, setTrackPath] = useState(initial.current.trackPath);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [epoch, setEpoch] = useState(0);
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const updateLine = useCallback((id: number, patch: Partial<TimingLine>): void => {
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => {
        if (line.id !== id) return line;
        const updated = { ...line, ...patch };
        return patch.verified === undefined ? updated : withTimingVerification(updated);
      })
    }));
    setNotice(null);
  }, []);
  const describeMediaError = useCallback(
    () => 'Не удалось загрузить волну: демонстрационный трек недоступен. Восстановите трек и повторите прослушивание.',
    []
  );
  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <TimingToolbar
        lineCount={draft.lines.length}
        verifiedCount={draft.lines.filter((line) => line.verified).length}
        dirty={dirty}
        busy={busy}
        generating={false}
        invalidBindings={variant === 'invalid-bindings'}
        canGenerate={false}
        generateBlockedReason={trackPath ? timingTexts.toolsMissing : timingTexts.addTrack}
        onGenerate={() => undefined}
        onConfirmAll={() => setDraft((current) => ({ ...current, lines: current.lines.map((line) => withTimingVerification(line, true)) }))}
        onRecalculateSections={() =>
          setDraft((current) => ({
            ...current,
            sections: buildSections(initial.current.lyrics, orderedTimingStoryLines(current.lines), initial.current.duration)
          }))
        }
        onDiscard={() => {
          setDraft(structuredClone(saved));
          setSelected(null);
          setNotice(null);
          setEpoch((current) => current + 1);
        }}
        onSave={() => {
          setBusy(true);
          void window.api.timing
            .save('storybook-timing', draft)
            .then((result) => {
              setSaved(structuredClone(result));
              setDraft(result);
              setNotice({ error: false, text: timingTexts.saved });
            })
            .catch((error: unknown) => setNotice({ error: true, text: error instanceof Error ? error.message : String(error) }))
            .finally(() => setBusy(false));
        }}
      />
      {notice && <Alert severity={notice.error ? 'error' : 'success'}>{notice.text}</Alert>}
      <TimingEditor
        key={epoch}
        view={{ ...initial.current, timing: draft, trackPath: showPlayer ? trackPath : null }}
        draft={draft}
        selected={selected}
        setSelected={setSelected}
        updateLine={updateLine}
        onRemove={(id) => {
          setDraft((current) => ({ ...current, lines: current.lines.filter((line) => line.id !== id) }));
          if (selected === id) setSelected(null);
        }}
        showPlayer={showPlayer}
        busy={busy}
        describeError={describeMediaError}
      />
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        {variant === 'media-error' && (
          <ActionButton onClick={() => setTrackPath(STORY_TRACK_PATH)} disabled={trackPath === STORY_TRACK_PATH}>
            Восстановить демонстрационный трек
          </ActionButton>
        )}
        <ActionButton
          onClick={() => {
            setDraft(structuredClone(saved));
            setSelected(null);
            setNotice(null);
            setEpoch((current) => current + 1);
          }}
        >
          Открыть сохранённую разметку заново
        </ActionButton>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        Данные живут в памяти витрины. Автоматическая разметка недоступна: Python и распознавание здесь не запускаются.
      </Typography>
    </Stack>
  );
}

interface TimingEditorProps {
  view: TimingView;
  draft: TimingFile;
  selected: number | null;
  setSelected(id: number | null): void;
  updateLine(id: number, patch: Partial<TimingLine>): void;
  onRemove(id: number): void;
  showPlayer: boolean;
  busy: boolean;
  describeError(error: unknown): string;
}

/** Hook остаётся настоящим: декодирование, остановка строки и клавиатура работают на локальном MP3 витрины. */
function TimingEditor({ view, draft, selected, setSelected, updateLine, onRemove, showPlayer, busy, describeError }: TimingEditorProps): ReactElement {
  const player = useTimingPlayer({
    view,
    lines: draft.lines,
    sections: draft.sections,
    selected,
    setSelected,
    updateLine,
    busy,
    generating: false,
    generateOpen: false,
    describeError
  });
  return (
    <Stack spacing={2}>
      {showPlayer && <TimingPlayer player={player} lines={draft.lines} stickyTop={0} />}
      <Box sx={{ minWidth: 0 }}>
        <TimingLinesTable
          lines={draft.lines}
          selected={selected}
          duration={player.duration}
          textOf={(line) => view.lyrics.find((lyric) => lyric.number === line.source_line)?.text ?? ''}
          onSelect={(line) => setSelected(line.id)}
          onUpdate={updateLine}
          onRemove={onRemove}
          onPlay={player.playLine}
        />
      </Box>
      <Typography role="status" variant="body2" color="text.secondary">
        {selected === null ? 'Строка не выбрана' : `Выбрана строка ${selected}`}
      </Typography>
    </Stack>
  );
}
