/** Локальная модель получения сохраняет оплаченные оригиналы, а выбор опоры и приёмку выполняет отдельными переходами. */
import { useState, useSyncExternalStore } from 'react';
import { Alert, Button, Paper, Stack, Typography } from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Api } from '@shared/api';
import type { AcceptOptions, JobInfo, PackageView, ProductionView } from '@shared/types';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { PackageResume } from '../pages/ProductionPage/components/PackageResume';
import { PackageResult } from '../pages/ProductionPage/components/PackageResult';
import { PackageDecision } from '../pages/ProductionPage/components/PackageDecision';
import { AcceptResultDialog } from '../pages/ProductionPage/components/AcceptResultDialog';
import { RegenerateDialog } from '../pages/ProductionPage/components/RegenerateDialog';
import { JobStatus } from '../components/JobStatus';
import { acceptShownResult, acceptTargetFor, defaultAcceptOptions, reviewMontageRoute, type AcceptTarget } from '../pages/ProductionPage/decisions';
import { createStoryApi, type StoryApiSession, type StoryOptions } from './storybook';
import { assertDeliveryAcceptOptions, deliveryJob, deliveryPackage, DELIVERY_DATE, DELIVERY_PROJECT, DELIVERY_RESULT_TOKEN } from './deliveryStories';
import { productionShot } from './productionQueueStories';
import { storyAccess } from './commonStories';

export const RECEIVE_ERROR = 'Получение прервано. Сохранённый ID и скачанные оригиналы остались в пакете; повторите получение.';
export const RESULT_ERROR = 'Не удалось сохранить результат операции. Оригиналы и выбранный пакет сохранены; повторите действие.';

/** Файлы принадлежат показанной попытке, а basename разрешается в существующее медиа витрины. */
export function receivedPackage(kind: 'video' | 'image' = 'video', options: { question?: boolean; previews?: boolean; token?: boolean } = {}): PackageView {
  const pkg = deliveryPackage(kind);
  return {
    ...pkg,
    resultToken: options.token === false ? undefined : pkg.resultToken,
    pendingDecision: options.question ? pkg.pendingDecision : null,
    preview: options.previews ? [1, 2].map((index) => `${pkg.dir}/preview/story-image.png?summary=${index}`) : [],
    request: {
      ...pkg.request!,
      downloads: kind === 'image' ? [1, 2].map((index) => `${pkg.request!.dir}/original-${index}/story-image.png?variant=${index}`) : pkg.request!.downloads
    }
  };
}

export function receivingPackage(
  status = 'running',
  options: { kind?: 'video' | 'image'; unknown?: boolean; partial?: boolean; manual?: boolean } = {}
): PackageView {
  const pkg = deliveryPackage(options.kind ?? 'video', 'submitted');
  return {
    ...pkg,
    request: {
      ...pkg.request!,
      attemptStatus: status,
      generationId: options.unknown || options.manual ? null : pkg.request!.generationId,
      manualResult: !!options.manual,
      downloads: options.partial || options.manual ? [`${pkg.request!.dir}/original-1/${options.kind === 'image' ? 'story-image.png' : 'story-video.mp4'}`] : []
    }
  };
}

interface DeliverySnapshot {
  pkg: PackageView;
  running: boolean;
  job?: JobInfo;
  error?: string;
  resumeCalls: number;
  pickerCalls: number;
  acceptCalls: number;
  selectionCalls: number;
  lastGenerationId: string | null;
  accepted: boolean;
  acceptedOptions?: AcceptOptions;
  epoch: number;
}

interface ResultModelOptions {
  pkg?: PackageView;
  failFirst?: boolean;
  cancelPicker?: boolean;
}

interface ResultModel {
  snapshot(): DeliverySnapshot;
  subscribe(listener: () => void): () => void;
  reset(): void;
  report(error: unknown): void;
}

const models = new WeakMap<Api, ResultModel>();

/** Методы API меняют тот же snapshot, который читает родитель; ненастроенная платная отправка намеренно завершается ошибкой. */
function createResultSession(options: ResultModelOptions): StoryApiSession {
  const initial = structuredClone(options.pkg ?? receivedPackage());
  let state: DeliverySnapshot;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failed = false;
  const listeners = new Set<() => void>();
  const publish = (change: Partial<DeliverySnapshot>): void => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const reset = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    failed = false;
    publish({
      pkg: structuredClone(initial),
      running: false,
      job: undefined,
      error: undefined,
      resumeCalls: 0,
      pickerCalls: 0,
      acceptCalls: 0,
      selectionCalls: 0,
      lastGenerationId: null,
      accepted: false,
      acceptedOptions: undefined,
      epoch: (state?.epoch ?? -1) + 1
    });
  };
  reset();
  const checked = (project: string, dir: string): PackageView => {
    if (project !== DELIVERY_PROJECT || dir !== state.pkg.dir) throw new Error('Операция относится к другому пакету.');
    return state.pkg;
  };
  const question = (pkg: PackageView): PackageView['pendingDecision'] => ({
    stage: pkg.stage,
    question: 'Принять полученный результат?',
    options: ['accept', 'retry', 'review', 'revise'],
    asked_at: DELIVERY_DATE
  });
  const completeResult = (pkg: PackageView, manual = false): PackageView => {
    const image = pkg.request?.kind === 'image';
    const stage = image ? 'image_downloaded' : 'downloaded';
    const path = `${pkg.request!.dir}/original-1/${image ? 'story-image.png' : 'story-video.mp4'}`;
    const next: PackageView = {
      ...pkg,
      stage,
      stageLabel: 'Результат получен',
      resultToken: DELIVERY_RESULT_TOKEN,
      request: {
        ...pkg.request!,
        attemptStatus: 'downloaded',
        manualResult: manual || pkg.request!.manualResult,
        downloads: [...new Set([...pkg.request!.downloads, path])]
      }
    };
    return { ...next, pendingDecision: image ? null : question(next) };
  };
  const run = (kind: JobInfo['kind'], finish: (pkg: PackageView) => PackageView, error = RESULT_ERROR): JobInfo => {
    if (timer !== null) throw new Error('Дождитесь текущего локального задания.');
    const job = deliveryJob(kind);
    publish({ running: true, job, error: undefined });
    timer = setTimeout(() => {
      timer = null;
      const fail = !!options.failFirst && !failed;
      failed = true;
      publish({
        running: false,
        error: fail ? error : undefined,
        pkg: fail ? state.pkg : finish(state.pkg),
        job: { ...job, status: fail ? 'failed' : 'done', finishedAt: DELIVERY_DATE, code: fail ? 1 : 0, ...(fail ? { error } : {}) }
      });
    }, 300);
    return job;
  };
  const session = createStoryApi({
    dialog: {
      pickFiles: async () => {
        publish({ pickerCalls: state.pickerCalls + 1 });
        return options.cancelPicker ? [] : [`/mock/История генераций/${state.pkg.request?.kind === 'image' ? 'story-image.png' : 'story-video.mp4'}`];
      }
    },
    production: {
      resume: async (project, dir) => {
        const pkg = checked(project, dir);
        if (!pkg.request?.generationId && !pkg.request?.manualResult) throw new Error('Без ID требуется ручное выяснение исхода.');
        publish({ resumeCalls: state.resumeCalls + 1, lastGenerationId: pkg.request?.generationId ?? null });
        return run('submit', (current) => completeResult(current), RECEIVE_ERROR);
      },
      attachResult: async (project, dir, files) => {
        const pkg = checked(project, dir);
        if (!files.length || pkg.request?.generationId) throw new Error('Ручное получение требует выбранного файла и неизвестного ID.');
        return run('submit', (current) => completeResult(current, true), RECEIVE_ERROR);
      },
      markNotCreated: async (project, dir) => {
        const pkg = checked(project, dir);
        if (pkg.request?.generationId) throw new Error('У попытки уже сохранён ID задания.');
        const prepared = deliveryPackage(pkg.request?.kind === 'image' ? 'image' : 'video', 'prepared');
        publish({
          pkg: {
            ...pkg,
            stage: prepared.stage,
            stageLabel: prepared.stageLabel,
            request: { ...pkg.request!, attemptStatus: 'prepared', creditsConsumed: null },
            pendingDecision: prepared.pendingDecision,
            decision: null,
            resultToken: undefined
          }
        });
      },
      contactSheet: async (project, dir) => {
        checked(project, dir);
        return run('contact_sheet', (pkg) => ({ ...pkg, preview: [1, 2].map((index) => `${pkg.dir}/preview/story-image.png?summary=${index}`) }));
      },
      reopenQuestion: async (project, dir) => {
        const pkg = checked(project, dir);
        publish({ pkg: { ...pkg, pendingDecision: question(pkg) } });
      },
      selectImage: async (project, dir, index, token) => {
        const pkg = checked(project, dir);
        if (!pkg.resultToken || token !== pkg.resultToken || !pkg.request?.downloads[index]) throw new Error('Выбранный оригинал не подтверждён.');
        const frame = pkg.request.frameId!;
        publish({
          selectionCalls: state.selectionCalls + 1,
          pkg: {
            ...pkg,
            stage: 'keyframes_review',
            keyframes: pkg.keyframes.map((item) => (item.id === frame ? { ...item, imagePath: pkg.request!.downloads[index], approved: false } : item)),
            pendingDecision: {
              stage: 'keyframes_review',
              question: `Утвердить опору ${frame}?`,
              options: ['approve', 'revise'],
              frame,
              asked_at: DELIVERY_DATE
            }
          }
        });
      },
      decide: async (project, dir, verdict, note) => {
        const pkg = checked(project, dir);
        const frame = pkg.pendingDecision?.frame;
        if (!pkg.pendingDecision?.options.includes(verdict)) throw new Error('Этот ответ отсутствует в показанном вопросе.');
        publish({
          pkg: {
            ...pkg,
            pendingDecision: null,
            decision: { stage: pkg.stage, verdict, note, at: DELIVERY_DATE },
            keyframes: verdict === 'approve' && frame ? pkg.keyframes.map((item) => (item.id === frame ? { ...item, approved: true } : item)) : pkg.keyframes
          }
        });
      },
      regenerate: async () =>
        run('regenerate', (pkg) => {
          const prepared = deliveryPackage('video', 'prepared');
          const dir = `${pkg.dir}-retry`;
          return {
            ...prepared,
            dir,
            relative: `${pkg.relative}-retry`,
            retryOf: pkg.dir,
            prompt: prepared.prompt ? { ...prepared.prompt, path: `${dir}/video-prompt.txt` } : null,
            request: { ...prepared.request!, dir: `${dir}/requests/video-01` }
          };
        }),
      accept: async (project, shot, dir, acceptOptions) => {
        const pkg = checked(project, dir);
        if (shot !== pkg.shot || !pkg.resultToken || acceptOptions.expectedResultToken !== pkg.resultToken || pkg.request?.attemptStatus !== 'downloaded')
          throw new Error('Результат не готов к приёмке.');
        assertDeliveryAcceptOptions(acceptOptions);
        publish({ acceptCalls: state.acceptCalls + 1 });
        return run('accept', (current) => {
          publish({ accepted: true, acceptedOptions: { ...acceptOptions } });
          return { ...current, stage: 'accepted', stageLabel: 'Принят', pendingDecision: null };
        });
      }
    }
  });
  const model: ResultModel = {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset,
    report(error) {
      publish({ error: error instanceof Error ? error.message : String(error) });
    }
  };
  models.set(session.api, model);
  session.onCleanup(registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo));
  session.onCleanup(() => {
    if (timer !== null) clearTimeout(timer);
    listeners.clear();
    models.delete(session.api);
  });
  return session;
}

export function resultStoryOptions(options: ResultModelOptions = {}, offline = false): StoryOptions {
  return { route: '/project/production?shot=M02', app: { aiAccess: storyAccess, online: !offline }, createApi: () => createResultSession(options) };
}

export interface ResultStoryProps {
  busy?: boolean;
  providerAvailable?: boolean;
  showDecision?: boolean;
}

function DeliveryStory({ resume, busy = false, providerAvailable = true, showDecision = true }: ResultStoryProps & { resume: boolean }) {
  const model = models.get(window.api);
  if (!model) throw new Error('История требует resultStoryOptions.');
  const state = useSyncExternalStore(model.subscribe, model.snapshot);
  const [target, setTarget] = useState<AcceptTarget | null>(null);
  const [options, setOptions] = useState<AcceptOptions>(() => defaultAcceptOptions(acceptTargetFor(state.pkg, false)));
  const [repeat, setRepeat] = useState(false);
  const [note, setNote] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const pkg = state.pkg;
  const locked = busy || state.running;
  const act = (operation: Promise<unknown>): void => {
    void operation.catch(model.report);
  };
  const openAccept = (): void => {
    const next = acceptTargetFor(pkg, false);
    setOptions(defaultAcceptOptions(next));
    setTarget(next);
  };
  const decide = (verdict: string): void => {
    if (verdict === 'review') {
      const view: ProductionView = {
        shots: [productionShot({ id: 'M01' }), productionShot({ packages: [pkg] }), productionShot({ id: 'M03' })],
        broken: [],
        problems: [],
        tools: { python: true, providers: { test: true } }
      };
      navigate(reviewMontageRoute(view, pkg, DELIVERY_PROJECT));
      return;
    }
    act(
      window.api.production.decide(DELIVERY_PROJECT, pkg.dir, verdict, note, pkg.decisionToken).then(() => {
        if (verdict === 'accept') openAccept();
        if (verdict === 'retry') setRepeat(true);
      })
    );
  };
  const reset = (): void => {
    setTarget(null);
    setRepeat(false);
    setNote('');
    model.reset();
    navigate('/project/production?shot=M02');
  };
  const partial = pkg.request?.attemptStatus === 'download_partial';
  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {pkg.stageLabel} · {pkg.relative}
        </Typography>
        {resume && (
          <PackageResume
            key={`resume-${state.epoch}`}
            pkg={pkg}
            busy={locked}
            providerAvailable={providerAvailable}
            onResume={() => act(window.api.production.resume(DELIVERY_PROJECT, pkg.dir))}
            onAttach={(files) => act(window.api.production.attachResult(DELIVERY_PROJECT, pkg.dir, files))}
            onNotCreated={() => act(window.api.production.markNotCreated(DELIVERY_PROJECT, pkg.dir))}
          />
        )}
        {!state.accepted && (
          <PackageResult
            key={`result-${state.epoch}`}
            pkg={pkg}
            busy={locked}
            onAccept={openAccept}
            onContactSheet={() => act(window.api.production.contactSheet(DELIVERY_PROJECT, pkg.dir))}
            onSelectImage={(index) => act(window.api.production.selectImage(DELIVERY_PROJECT, pkg.dir, index, pkg.resultToken!))}
            onReopenQuestion={() => act(window.api.production.reopenQuestion(DELIVERY_PROJECT, pkg.dir))}
          />
        )}
        {partial && <Alert severity="warning">Скачана часть результата. Приёмка недоступна; сохранённые оригиналы остаются в пакете.</Alert>}
        {pkg.request?.attemptStatus === 'prepared' ? (
          <Alert severity="info">{pkg.pendingDecision?.question} Требуются новая оценка стоимости и отдельное подтверждение отправки.</Alert>
        ) : null}
        {pkg.request?.attemptStatus !== 'prepared' && (showDecision || pkg.pendingDecision?.frame) && (
          <PackageDecision
            key={`decision-${state.epoch}`}
            pending={pkg.pendingDecision}
            aiKind={pkg.request?.kind === 'image' ? 'image' : 'video'}
            note={note}
            setNote={setNote}
            busy={locked}
            onDecide={decide}
          />
        )}
        <JobStatus job={state.job} error={state.error} />
      </Paper>
      <Typography variant="caption" data-testid="delivery-state" sx={{ overflowWrap: 'anywhere' }}>
        Статус: {pkg.request?.attemptStatus}; ID: {pkg.request?.generationId ?? 'нет'}; ручной результат: {String(pkg.request?.manualResult)}; оригиналов:{' '}
        {pkg.request?.downloads.length ?? 0}; получение: {state.resumeCalls}; выбор файлов: {state.pickerCalls}; выбор кандидата: {state.selectionCalls};
        приёмка: {state.acceptCalls}; отправка: 0.
      </Typography>
      {state.lastGenerationId && <Typography variant="caption">Получение продолжено по ID: {state.lastGenerationId}</Typography>}
      {pkg.request?.kind === 'image' && (
        <Typography variant="caption">
          Опора {pkg.request.frameId}: {pkg.keyframes.find((frame) => frame.id === pkg.request?.frameId)?.imagePath ? 'кандидат выбран' : 'кандидат не выбран'};
          утверждена: {String(pkg.keyframes.find((frame) => frame.id === pkg.request?.frameId)?.approved ?? false)}.
        </Typography>
      )}
      {state.accepted && (
        <Alert severity="success">
          Результат принят в assets/shots/M02; монтажный участок {state.acceptedOptions?.cutStart}–{state.acceptedOptions?.cutEnd} с, исходный оригинал 8 с
          сохранён.
        </Alert>
      )}
      {location.pathname === '/project/montage' && (
        <Alert severity="info">
          Открыт маршрут: {location.pathname}
          {location.search}. Вопрос о результате сохранён.
        </Alert>
      )}
      <Button startIcon={<RestartAltIcon />} onClick={reset} sx={{ alignSelf: 'start' }}>
        Сбросить модель
      </Button>
      <AcceptResultDialog
        key={`accept-${state.epoch}`}
        target={target}
        options={options}
        onOptions={setOptions}
        onClose={() => setTarget(null)}
        onConfirm={() => {
          if (!target) return;
          // Рабочая страница закрывает подтверждение перед запуском: ошибка операции остаётся видимой у блока результата.
          setTarget(null);
          act(acceptShownResult(window.api, DELIVERY_PROJECT, target, options));
        }}
      />
      <RegenerateDialog
        key={`repeat-${state.epoch}`}
        shot={repeat ? pkg.shot : null}
        onClose={() => setRepeat(false)}
        onConfirm={() => act(window.api.production.regenerate(DELIVERY_PROJECT, pkg.shot).then(() => setRepeat(false)))}
      />
    </Stack>
  );
}

export function ResumeStory(props: ResultStoryProps) {
  return <DeliveryStory {...props} resume />;
}
export function ResultStory(props: ResultStoryProps) {
  return <DeliveryStory {...props} resume={false} />;
}
