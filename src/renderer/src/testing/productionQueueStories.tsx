/** Родители карточки, устаревшего пакета и очереди меняют только данные витрины; платной отправки здесь нет. */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import type { BrokenPackage, JobInfo, PackageView, ShotProduction } from '@shared/types';
import { ProductionShotCard } from '../pages/ProductionPage/components/ProductionShotCard';
import { PackageSceneChanged } from '../pages/ProductionPage/components/PackageSceneChanged';
import { ProductionQueue } from '../pages/ProductionPage/components/ProductionQueue';
import { RegenerateDialog } from '../pages/ProductionPage/components/RegenerateDialog';
import { BUSY_REASON } from '../pages/ProductionPage/constants';
import { keyframePackage } from './keyframeStories';
import { STORY_IMAGE_PATH, STORY_VIDEO_PATH } from './storybook';

const DATE = '2026-10-30T09:00:00.000Z';
const PROJECT = '/mock/Клип у старых ворот';
export const RETRY_ERROR = 'Не удалось проверить сохранённый запрос. Исходный комплект и пакеты сохранены; повторите подготовку.';
export const DELETE_ERROR = 'Не удалось удалить повреждённую папку. Она осталась в очереди; повторите удаление.';

/** Очередь хранит уже замороженные запросы, но ни один из них ещё не отправлялся. */
export function queuedPackage(kind: 'image' | 'video' = 'video', suffix = '01'): PackageView {
  const relative = `plan/awaiting/M02-${kind}-${suffix}`;
  const image = kind === 'image';
  const base = keyframePackage();
  return {
    ...base,
    dir: `${PROJECT}/${relative}`,
    relative,
    stage: image ? 'image_request_choice' : 'ready',
    stageLabel: image ? 'Запрос изображения отложен' : 'В очереди',
    waitReason: 'user_saved',
    keyframes: image
      ? base.keyframes.map((frame) => ({ ...frame, imagePath: frame.id === 'K01' ? frame.imagePath : null, approved: frame.id === 'K01' }))
      : base.keyframes.map((frame) => ({ ...frame, imagePath: `${STORY_IMAGE_PATH}?frame=${frame.id}`, approved: true })),
    keyframeNotes: [],
    pendingDecision: null,
    decision: { stage: image ? 'image_request_choice' : 'request_choice', verdict: 'park', at: DATE },
    prompt: image ? null : { path: `${PROJECT}/${relative}/video-prompt.txt`, text: 'Камера плавно приближается к старым воротам.', approved: true },
    request: {
      dir: `${PROJECT}/${relative}/requests/${kind}-01`,
      kind,
      provider: 'test',
      command: image ? 'text_to_image' : 'image_to_video',
      ...(image ? { frameId: 'K02' } : {}),
      sha256: (image ? 'b' : 'a').repeat(64),
      model: 'Демонстрационная модель',
      parameters: image ? { aspect_ratio: '16:9' } : { duration: 5 },
      inputs: image ? [] : [{ slot: 'first_frame', path: 'keyframes/K01.png', imagePath: `${STORY_IMAGE_PATH}?frame=K01` }],
      promptText: image ? 'Герой у старых ворот, вечернее освещение.' : 'Камера плавно приближается к старым воротам.',
      attemptStatus: 'prepared',
      generationId: null,
      manualResult: false,
      creditsConsumed: null,
      downloads: []
    }
  };
}

/** Подготовленная попытка в batches ещё ждёт решения; её запрос и опоры согласованы между собой. */
export function preparedPackage(suffix = '01'): PackageView {
  const source = queuedPackage();
  const relative = `plan/batches/M02-attempt-${suffix}`;
  const dir = `${PROJECT}/${relative}`;
  return {
    ...source,
    dir,
    relative,
    stage: 'request_choice',
    stageLabel: 'Запрос подготовлен',
    waitReason: null,
    prompt: source.prompt ? { ...source.prompt, path: `${dir}/video-prompt.txt` } : null,
    request: { ...source.request!, dir: `${dir}/requests/video-01` },
    pendingDecision: { stage: 'request_choice', question: 'Что сделать с подготовленным запросом?', options: ['send', 'park', 'revise'], asked_at: DATE },
    decision: null
  };
}

export function productionShot(overrides: Partial<ShotProduction> = {}): ShotProduction {
  return {
    id: 'M02',
    title: 'Возвращение к старым воротам',
    original: 'Герой останавливается у ворот и смотрит на свет в окне.',
    start: 12,
    end: 17,
    lipsync: false,
    state: 'completed',
    stageLabel: 'Принят',
    regenerateProblem: null,
    derivedFrom: null,
    attention: null,
    asset: { dir: `${PROJECT}/assets/shots/M02`, video: '/mock/story-derived-source-150.mp4', original: STORY_VIDEO_PATH },
    packages: [],
    ...overrides
  };
}

export function brokenPackage(overrides: Partial<BrokenPackage> = {}): BrokenPackage {
  const relative = overrides.relative ?? 'plan/awaiting/M02-broken';
  return {
    // Подпись подтверждения и абсолютный путь удаления относятся к одной папке.
    dir: `${PROJECT}/${relative}`,
    relative,
    shot: 'M02',
    reason: 'workflow.json повреждён: JSON не прочитан',
    ...overrides
  };
}

/** Один таймер принадлежит одному родителю; сброс и размонтирование отменяют его продолжение. */
function useLocalOperation() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [running, setRunning] = useState(false);
  const failed = useRef(false);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
  const run = (finish: (fail: boolean) => void, failFirst: boolean): void => {
    if (timer.current !== null) return;
    setRunning(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setRunning(false);
      const fail = failFirst && !failed.current;
      failed.current = true;
      finish(fail);
    }, 350);
  };
  const reset = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    failed.current = false;
    setRunning(false);
  };
  return { running, run, reset };
}

export interface ProductionShotStoryProps {
  initialShot?: ShotProduction;
  initialSelected?: string;
  busy?: boolean;
  pythonAvailable?: boolean;
  failFirst?: boolean;
}

export function ProductionShotStory({ initialShot, initialSelected = '', busy = false, pythonAvailable = true, failFirst = false }: ProductionShotStoryProps) {
  const [shot, setShot] = useState(() => structuredClone(initialShot ?? productionShot()));
  const [selected, setSelected] = useState(initialSelected);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [job, setJob] = useState<JobInfo>();
  const [epoch, setEpoch] = useState(0);
  const operation = useLocalOperation();
  const locked = busy || operation.running;
  const repeat = (): void => {
    setConfirm(null);
    const pending: JobInfo = {
      id: 'demo-regenerate-M02',
      project: PROJECT,
      kind: 'regenerate',
      title: 'Подготовка повтора M02',
      status: 'running',
      startedAt: DATE,
      finishedAt: null,
      log: '',
      code: null,
      steps: []
    };
    setJob(pending);
    operation.run((fail) => {
      setJob({ ...pending, status: fail ? 'failed' : 'done', finishedAt: DATE, code: fail ? 1 : 0, ...(fail ? { error: RETRY_ERROR } : {}) });
      if (fail) return;
      const created: PackageView = {
        ...preparedPackage(String(shot.packages.length + 1).padStart(2, '0')),
        retryOf: shot.packages.at(-1)?.dir ?? null
      };
      // Как useProductionPage, успешная подготовка сохраняет комплект и сама выбирает новый пакет.
      setShot((current) => ({ ...current, packages: [...current.packages, created], attention: created.pendingDecision!.question }));
      setSelected(created.dir);
    }, failFirst);
  };
  return (
    <Stack spacing={2}>
      <ProductionShotCard
        key={epoch}
        shot={shot}
        busy={locked}
        pythonAvailable={pythonAvailable}
        selectedPackage={selected}
        onRegenerate={setConfirm}
        onOpenPackage={setSelected}
        operation={{ job }}
      />
      <RegenerateDialog shot={confirm} problem={shot.regenerateProblem} onClose={() => setConfirm(null)} onConfirm={repeat} />
      {selected && (
        <Alert severity="info">Открыт пакет: {shot.packages.find((pkg) => pkg.dir === selected)?.relative ?? selected}. Отправок генерации: 0.</Alert>
      )}
      <Button
        onClick={() => {
          operation.reset();
          setShot(structuredClone(initialShot ?? productionShot()));
          setSelected(initialSelected);
          setConfirm(null);
          setJob(undefined);
          setEpoch((value) => value + 1);
        }}
        sx={{ alignSelf: 'start' }}
      >
        Сбросить модель
      </Button>
    </Stack>
  );
}

export interface SceneChangedStoryProps {
  initialPackage?: PackageView;
  busy?: boolean;
  failFirst?: boolean;
}

export function SceneChangedStory({ initialPackage, busy = false, failFirst = false }: SceneChangedStoryProps) {
  const [pkg, setPackage] = useState(() => structuredClone(initialPackage ?? { ...queuedPackage(), sceneChanged: true }));
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [revision, setRevision] = useState(false);
  const [draft, setDraft] = useState('');
  const [epoch, setEpoch] = useState(0);
  const revisionInput = useRef<HTMLTextAreaElement>(null);
  const operation = useLocalOperation();
  useEffect(() => {
    if (revision) revisionInput.current?.focus();
  }, [revision]);
  return (
    <Stack spacing={2}>
      <Typography variant="body2">Пакет: {pkg.relative}</Typography>
      {pkg.sceneChanged ? (
        <PackageSceneChanged
          key={epoch}
          pkg={pkg}
          busy={busy || operation.running}
          busyReason={BUSY_REASON}
          onKeep={() => {
            setNotice(null);
            operation.run((fail) => {
              if (fail) {
                setNotice({ error: true, text: 'Не удалось сохранить соответствие постановке. Пакет сохранён; повторите решение.' });
                return;
              }
              setPackage((current) => ({ ...current, sceneChanged: false }));
              setNotice({ error: false, text: 'Пакет оставлен для текущей постановки. Материалы и подготовленный запрос сохранены.' });
            }, failFirst);
          }}
          onOpenRevision={() => {
            setRevision(true);
            revisionInput.current?.focus();
          }}
        />
      ) : (
        <Alert severity="success">Постановка пакета актуальна: sceneChanged = false.</Alert>
      )}
      {operation.running && <Alert severity="info">Сохраняем решение…</Alert>}
      {notice && <Alert severity={notice.error ? 'error' : 'success'}>{notice.text}</Alert>}
      {revision && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2">Доработка пакета: {pkg.relative}</Typography>
          <TextField
            multiline
            fullWidth
            label="Что изменить в описании этого пакета"
            inputRef={revisionInput}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            sx={{ mt: 1 }}
          />
          <Typography variant="caption">Открыта подготовка выбранного пакета. Агент не запущен; постановка ещё требует решения.</Typography>
        </Paper>
      )}
      <Button
        onClick={() => {
          operation.reset();
          setPackage(structuredClone(initialPackage ?? { ...queuedPackage(), sceneChanged: true }));
          setNotice(null);
          setRevision(false);
          setDraft('');
          setEpoch((value) => value + 1);
        }}
        sx={{ alignSelf: 'start' }}
      >
        Сбросить модель
      </Button>
    </Stack>
  );
}

export interface ProductionQueueStoryProps {
  initialPackages?: PackageView[];
  initialBroken?: BrokenPackage[];
  initialSelected?: string;
  busy?: boolean;
  failFirst?: boolean;
}

export function ProductionQueueStory({
  initialPackages,
  initialBroken = [],
  initialSelected = '',
  busy = false,
  failFirst = false
}: ProductionQueueStoryProps) {
  const [packages] = useState(() => structuredClone(initialPackages ?? [queuedPackage('image'), queuedPackage('video')]));
  const [broken, setBroken] = useState(() => structuredClone(initialBroken));
  const [selected, setSelected] = useState(initialSelected);
  const [filter, setFilter] = useState<'queued' | 'all'>('queued');
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [epoch, setEpoch] = useState(0);
  const operation = useLocalOperation();
  const current = packages.find((pkg) => pkg.dir === selected);
  return (
    <Stack spacing={2}>
      <ProductionQueue
        key={epoch}
        packages={packages}
        broken={broken}
        selected={selected}
        busy={busy || operation.running}
        onOpen={(pkg) => {
          setSelected(pkg.dir);
          setFilter('queued');
        }}
        onResetFilter={() => setFilter('all')}
        onDiscardBroken={(item) => {
          setNotice(null);
          operation.run((fail) => {
            if (fail) {
              setNotice({ error: true, text: DELETE_ERROR });
              return;
            }
            setBroken((items) => items.filter((other) => other.dir !== item.dir));
            setNotice({ error: false, text: `Удалена повреждённая папка: ${item.relative}. Выбор сохранён.` });
          }, failFirst);
        }}
      />
      <Typography variant="body2">Фильтр: {filter === 'queued' ? 'Очередь' : 'Все планы'}. Отправок генерации: 0.</Typography>
      {current && (
        <Alert severity="info">
          Открыт запрос {current.shot}
          {current.request?.frameId ? ` · опора ${current.request.frameId}` : ''}: {current.relative}. SHA256: {current.request?.sha256}.
        </Alert>
      )}
      {operation.running && <Alert severity="info">Удаляем повреждённую папку…</Alert>}
      {notice && <Alert severity={notice.error ? 'error' : 'success'}>{notice.text}</Alert>}
      <Button
        onClick={() => {
          operation.reset();
          setBroken(structuredClone(initialBroken));
          setSelected(initialSelected);
          setFilter('queued');
          setNotice(null);
          setEpoch((value) => value + 1);
        }}
        sx={{ alignSelf: 'start' }}
      >
        Сбросить модель
      </Button>
    </Stack>
  );
}
