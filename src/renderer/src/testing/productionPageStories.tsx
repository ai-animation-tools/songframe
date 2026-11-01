/**
 * Локальная модель целой страницы «Производство»: снимок производства, задания и переходы ответов существуют только в памяти.
 * Выбор image original, утверждение опоры и приёмка комплекта остаются отдельными методами API, как в главном процессе.
 */
import { useSyncExternalStore, type ReactElement } from 'react';
import { Button, Paper, Stack, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import type { VideoReviewView } from '@shared/video-review';
import { videoReviewTexts } from '@shared/texts/video-review';
import type { Api } from '@shared/api';
import type { AppState, BrokenPackage, JobInfo, PackageView, ProductionView, ShotProduction } from '@shared/types';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { productionTexts } from '@shared/texts/production';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { ProductionPage } from '../pages/ProductionPage/ProductionPage';
import { storyAccess } from './commonStories';
import { assertDeliveryAcceptOptions, DELIVERY_PROJECT, deliveryJob } from './deliveryStories';
import { createDerivedScenario } from './derivedStories';
import { keyframePackage, keyframeQuestion } from './keyframeStories';
import { productionShot } from './productionQueueStories';
import { workflowView } from './productionWorkflowStories';
import { reviewView } from './videoReviewStories';
import { createStoryApi, STORY_VIDEO_PATH, type StoryOptions } from './storybook';

export const PAGE_PROJECT = DELIVERY_PROJECT;
export const PAGE_READ_ERROR = 'Не удалось прочитать состояние производства: plan/project.json занят. Опрос повторит чтение.';
export const PAGE_ACTION_ERROR = 'Не удалось записать ответ: workflow.json пакета занят. Вопрос и материалы сохранены; повторите ответ.';
/** Задание приёмки завершается через этот интервал: страница узнаёт итог только следующим опросом. */
export const PAGE_ACCEPT_MS = 2500;
export const PAGE_REVIEW_ERROR = 'Проверка видео не завершилась. Оригинал и опоры сохранены; повторите анализ.';
const DATE = '2026-10-30T09:00:00.000Z';

const appState: AppState = {
  packaged: false,
  problems: [],
  toolsRoot: '/mock/songframe',
  localDir: '/mock/state',
  current: PAGE_PROJECT,
  history: [],
  platform: 'linux'
};
// Один объект контекста на все истории: useProductionPage берёт проект из state.current, callbacks стабильны.
const pageApp: StoryOptions['app'] = { state: appState, online: true, aiAccess: storyAccess, agentProvider: 'codex' };

/** Пакет фабрики относится к M02; для другого плана меняются ID плана в путях и вопросах, сами материалы остаются. */
export function packageForShot(pkg: PackageView, shot: string): PackageView {
  const replaced = JSON.parse(JSON.stringify(pkg).replaceAll('M02', shot)) as PackageView;
  return { ...replaced, shot };
}

export function pageShot(id: string, overrides: Partial<ShotProduction> = {}): ShotProduction {
  return productionShot({
    id,
    asset: { dir: `${PAGE_PROJECT}/assets/shots/${id}`, video: STORY_VIDEO_PATH, original: STORY_VIDEO_PATH },
    ...overrides
  });
}

export interface ProductionPageModelOptions {
  shots: () => ShotProduction[];
  broken?: () => BrokenPackage[];
  problems?: string[];
  python?: boolean;
  /** Первое чтение: обычное, отложенное (общий индикатор загрузки) или с ошибкой (повтор — штатным опросом). */
  firstRead?: 'ready' | 'delayed' | 'failed';
  /** Первая запись ответа завершается ошибкой без изменения снимка. */
  failFirstAction?: boolean;
  /** Ошибка относится к первому завершению анализа каждого пакета, а не к чтению всей страницы. */
  videoReview?: { failFirstRun?: boolean; runMs?: number };
}

interface PageModel {
  view: ProductionView;
  jobs: JobInfo[];
  reads: number;
  decisions: number;
  selections: number;
  accepts: number;
  submissions: number;
  reviewStarts: number;
  reviewCancels: number;
  subscribe(listener: () => void): () => void;
  revision(): number;
}
const models = new WeakMap<Api, PageModel>();

export function productionPageOptions(options: ProductionPageModelOptions, route = '/project/production', workspaceWidth?: number): StoryOptions {
  return {
    shell: 'page',
    route,
    ...(workspaceWidth ? { workspaceWidth } : {}),
    app: pageApp,
    createApi: () => {
      const listeners = new Set<() => void>();
      const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
      let version = 0;
      let disposed = false;
      let failedAction = false;
      let question = 0;
      const publish = (): void => {
        version++;
        listeners.forEach((listener) => listener());
      };
      const later = (ms: number, action: () => void, cancel = (): void => {}): ReturnType<typeof setTimeout> => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!disposed) action();
        }, ms);
        timers.set(timer, cancel);
        return timer;
      };
      const wait = (ms: number): Promise<void> => new Promise((resolve) => later(ms, resolve, resolve));
      const model: PageModel = {
        view: {
          shots: options.shots(),
          broken: options.broken?.() ?? [],
          problems: options.problems ?? [],
          tools: { python: options.python ?? true, providers: { test: true } }
        },
        jobs: [],
        reads: 0,
        decisions: 0,
        selections: 0,
        accepts: 0,
        submissions: 0,
        reviewStarts: 0,
        reviewCancels: 0,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        revision: () => version
      };
      const checked = (project: string): void => {
        if (disposed || project !== PAGE_PROJECT) throw new Error('Проект истории изменился.');
      };
      const find = (project: string, dir: string): { shot: ShotProduction; pkg: PackageView } => {
        checked(project);
        for (const shot of model.view.shots) {
          const pkg = shot.packages.find((item) => item.dir === dir);
          if (pkg) return { shot, pkg };
        }
        throw new Error('Пакет не найден: обновите страницу.');
      };
      // Как хеш workflow в главном процессе: токен есть у каждого пакета и меняется при любой записи.
      let writes = 0;
      const touch = (pkg: PackageView): void => {
        pkg.decisionToken = `workflow-${++writes}`;
      };
      for (const shot of model.view.shots) shot.packages.forEach(touch);
      const ask = (shot: ShotProduction, pkg: PackageView, pending: PackageView['pendingDecision']): void => {
        question++;
        pkg.pendingDecision = pending;
        touch(pkg);
        shot.attention = shot.packages.find((item) => item.pendingDecision)?.pendingDecision?.question ?? null;
      };
      // Отчёт принадлежит пакету, поэтому выбор другого плана или повторное открытие не сбрасывают его.
      const reviews = new Map<string, { view: VideoReviewView; runs: number; timer: ReturnType<typeof setTimeout> | null }>();
      const reviewEntry = (pkg: PackageView) => {
        let entry = reviews.get(pkg.dir);
        if (!entry) {
          entry = { view: { ...reviewView('idle'), frames: [], durationSeconds: null }, runs: 0, timer: null };
          reviews.set(pkg.dir, entry);
        }
        return entry;
      };
      const reviewRunning = (view: VideoReviewView): boolean => view.status === 'preparing' || view.status === 'running';
      const reviewSnapshot = (pkg: PackageView): VideoReviewView => {
        const entry = reviewEntry(pkg);
        const reason = !model.view.tools.python
          ? videoReviewTexts.main.toolsMissing
          : pkg.request?.kind !== 'video' ||
              !['downloaded', 'edit_review', 'accepted'].includes(pkg.stage) ||
              pkg.request.downloads.length !== 1 ||
              !pkg.resultToken
            ? videoReviewTexts.main.videoRequired
            : !pkg.keyframes.some((frame) => frame.approved && frame.imagePath)
              ? videoReviewTexts.main.referencesRequired
              : [...reviews.values()].some(({ view }) => reviewRunning(view)) || model.jobs.some((job) => job.status === 'running')
                ? videoReviewTexts.main.busy
                : null;
        return structuredClone({ ...entry.view, canStart: !reason, reason });
      };
      const cancelReviewTimer = (entry: ReturnType<typeof reviewEntry>): void => {
        if (entry.timer !== null) {
          clearTimeout(entry.timer);
          timers.delete(entry.timer);
          entry.timer = null;
        }
      };
      const derived = createDerivedScenario({ view: { project: PAGE_PROJECT } });
      const session = createStoryApi({
        production: {
          submit: async () => {
            model.submissions++;
            publish();
            throw new Error('Платная отправка не входит в сценарий проверки видео.');
          },
          view: async (project) => {
            checked(project);
            model.reads++;
            publish();
            if (options.firstRead === 'delayed' && model.reads === 1) await wait(1500);
            if (options.firstRead === 'failed' && model.reads === 1) throw new Error(PAGE_READ_ERROR);
            return structuredClone(model.view);
          },
          decide: async (project, dir, verdict, note, decisionToken) => {
            const { shot, pkg } = find(project, dir);
            const pending = pkg.pendingDecision;
            if (!pending?.options.includes(verdict)) throw new Error('Этот ответ отсутствует в показанном вопросе.');
            if (decisionToken && decisionToken !== pkg.decisionToken) throw new Error(productionTexts.main.package.decisionMaterialsChanged);
            if (!decisionToken) throw new Error(productionTexts.main.package.refreshQuestion);
            model.decisions++;
            publish();
            if (options.failFirstAction && !failedAction) {
              failedAction = true;
              throw new Error(PAGE_ACTION_ERROR);
            }
            const frame = pending.frame;
            // Модель записывает только ответы об опорах; прочие переходы показаны историями своих блоков.
            if (!frame || (verdict !== 'approve' && verdict !== 'revise')) throw new Error(`Ответ «${verdict}» на этой странице витрины не моделируется.`);
            pkg.decision = { stage: pending.stage, verdict, note, at: DATE };
            if (verdict === 'approve') pkg.keyframes = pkg.keyframes.map((item) => (item.id === frame ? { ...item, approved: true } : item));
            const next = verdict === 'approve' ? pkg.keyframes.find((item) => !item.approved && item.imagePath) : undefined;
            ask(shot, pkg, next ? keyframeQuestion(next.id, question + 1) : null);
            pkg.stageLabel = next ? 'Опоры на согласовании' : verdict === 'approve' ? 'Опоры утверждены' : 'Опора возвращена на доработку';
            shot.stageLabel = pkg.stageLabel;
            publish();
          },
          selectImage: async (project, dir, index, token) => {
            const { shot, pkg } = find(project, dir);
            const path = pkg.request?.downloads[index];
            const frame = pkg.request?.frameId;
            if (pkg.stage !== 'image_downloaded' || pkg.pendingDecision || !pkg.resultToken || token !== pkg.resultToken || !path || !frame)
              throw new Error('Выбранный оригинал не подтверждён: обновите пакет.');
            model.selections++;
            // Оригинал становится только кандидатом: утверждение задаётся отдельным вопросом об опоре.
            pkg.stage = 'keyframes_review';
            pkg.stageLabel = 'Опоры на согласовании';
            // Оригиналы остаются в пакете, поэтому токен результата сохраняется; меняется только токен решения.
            pkg.keyframes = pkg.keyframes.map((item) => (item.id === frame ? { ...item, imagePath: path, approved: false } : item));
            ask(shot, pkg, keyframeQuestion(frame, question + 1));
            shot.stageLabel = pkg.stageLabel;
            publish();
          },
          accept: async (project, shotId, dir, acceptOptions) => {
            const { shot, pkg } = find(project, dir);
            if (shot.id !== shotId || !pkg.resultToken || acceptOptions.expectedResultToken !== pkg.resultToken)
              throw new Error('Показанный результат изменился: откройте приёмку заново.');
            if (shot.asset && !acceptOptions.replaceExisting) throw new Error('Отметьте замену принятого комплекта.');
            assertDeliveryAcceptOptions(acceptOptions);
            if (model.jobs.some((job) => job.status === 'running')) throw new Error('Приёмка уже выполняется.');
            model.accepts++;
            const job = deliveryJob('accept', {
              id: `accept-${shot.id}-${model.accepts}`,
              project: PAGE_PROJECT,
              title: `Приёмка ${shot.id}`,
              startedAt: DATE
            });
            model.jobs = [...model.jobs, job];
            publish();
            later(PAGE_ACCEPT_MS, () => {
              model.jobs = model.jobs.map((item) => (item.id === job.id ? { ...item, status: 'done', code: 0, finishedAt: DATE } : item));
              // Комплект меняется только после done; рабочие пакеты плана очищаются, как после accept_shot.
              Object.assign(shot, {
                state: 'completed',
                stageLabel: 'Принят',
                attention: null,
                packages: [],
                asset: { dir: `${PAGE_PROJECT}/assets/shots/${shot.id}`, video: '/mock/story-derived-source-150.mp4', original: STORY_VIDEO_PATH }
              } satisfies Partial<ShotProduction>);
              publish();
            });
            return structuredClone(job);
          }
        },
        videoReview: {
          view: async (project, dir) => reviewSnapshot(find(project, dir).pkg),
          start: async (project, dir) => {
            const { pkg } = find(project, dir);
            const snapshot = reviewSnapshot(pkg);
            if (!snapshot.canStart) throw new Error(snapshot.reason ?? videoReviewTexts.main.busy);
            const entry = reviewEntry(pkg);
            entry.runs++;
            model.reviewStarts++;
            entry.view = { ...reviewView('preparing'), report: null, frames: [], durationSeconds: null, canStart: false };
            publish();
            // Таймеры принадлежат сессии истории и отменяются вместе с анализом; настоящий IPC не используется.
            entry.timer = later(200, () => {
              entry.view = { ...entry.view, status: 'running' };
              entry.timer = later(options.videoReview?.runMs ?? 1800, () => {
                entry.timer = null;
                entry.view = reviewView(options.videoReview?.failFirstRun && entry.runs === 1 ? 'failed' : 'completed');
                if (entry.view.status === 'failed') entry.view.error = PAGE_REVIEW_ERROR;
                if (entry.view.report) entry.view.report.summary = `${pkg.shot}: ${entry.view.report.summary}`;
                publish();
              });
              publish();
            });
            return reviewSnapshot(pkg);
          },
          cancel: async (project, dir) => {
            const { pkg } = find(project, dir);
            const entry = reviewEntry(pkg);
            if (reviewRunning(entry.view)) {
              cancelReviewTimer(entry);
              entry.view = { ...entry.view, status: 'cancelled', error: videoReviewTexts.main.cancelled };
              model.reviewCancels++;
              publish();
            }
            return reviewSnapshot(pkg);
          }
        },
        jobs: { list: async () => structuredClone(model.jobs) },
        productionWorkflow: {
          // Подготовка агентом показана отдельной группой историй; здесь панель только читает состояние пакета.
          view: async (project, shot, packageDir) => {
            checked(project);
            return workflowView({
              project: PAGE_PROJECT,
              shot,
              packageDir: packageDir ?? null,
              canPrepare: !packageDir,
              reasons: packageDir
                ? { prepare: null, continue: 'Сначала ответьте на вопрос пакета.', frames: 'Сначала ответьте на вопрос пакета.' }
                : workflowView().reasons
            });
          }
        },
        derivedShots: derived.api.derivedShots
      });
      models.set(session.api, model);
      session.onCleanup(registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo));
      session.onCleanup(derived.dispose);
      session.onCleanup(() => {
        disposed = true;
        for (const [timer, cancel] of timers) {
          clearTimeout(timer);
          cancel();
        }
        timers.clear();
        reviews.clear();
        listeners.clear();
      });
      return session;
    }
  };
}

export interface StoryLink {
  label: string;
  to: string;
}

/** Целая страница и служебная строка модели; ссылки повторяют переход из уведомления на уже открытой странице. */
export function ProductionPageStory({ links = [] }: { links?: StoryLink[] }): ReactElement {
  const model = models.get(window.api);
  if (!model) throw new Error('Storybook: история страницы требует productionPageOptions.');
  useSyncExternalStore(model.subscribe, model.revision);
  const navigate = useNavigate();
  const approved = model.view.shots.flatMap((shot) =>
    shot.packages.flatMap((pkg) => pkg.keyframes.filter((frame) => frame.approved).map((frame) => `${shot.id}:${frame.id}`))
  );
  return (
    <>
      <ProductionPage />
      <Paper variant="outlined" sx={{ p: 1.5, mt: 2 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          {links.map((link) => (
            <Button key={link.to} size="small" variant="outlined" onClick={() => navigate(link.to)}>
              {link.label}
            </Button>
          ))}
          <Typography variant="caption" color="text.secondary" data-testid="production-model">
            Чтений: {model.reads}. Ответов: {model.decisions}. Выборов оригинала: {model.selections}. Утверждено опор: {approved.join(', ') || 'нет'}. Приёмок
            комплекта: {model.accepts}. Отправок генерации: {model.submissions}.
          </Typography>
          <Typography variant="caption" color="text.secondary" data-testid="production-review-model">
            Проверок видео: {model.reviewStarts}. Отмен проверок: {model.reviewCancels}.
          </Typography>
        </Stack>
      </Paper>
    </>
  );
}

/** Снимок длинного проекта: длинные названия, этапы и пути пакетов проверяют переносы и прокрутку. */
export function longPageShots(count = 24): ShotProduction[] {
  const states: ShotProduction['state'][] = ['completed', 'progress', 'planned', 'stale'];
  return Array.from({ length: count }, (_, index) => {
    const id = `M${String(index + 1).padStart(2, '0')}`;
    const state = states[index % states.length];
    const pkg = state === 'progress' ? longPackage(id) : null;
    return pageShot(id, {
      title: `${id}: длинное название плана у старых ворот, где герой долго смотрит на освещённое окно и вспоминает дорогу`,
      original: 'Герой останавливается у ворот, свет падает слева, камера медленно приближается и задерживается на лице.',
      start: index * 5,
      end: index * 5 + 5,
      state,
      stageLabel: {
        completed: 'Принят',
        progress: 'Опоры на согласовании у длинной попытки',
        planned: 'Запланирован',
        stale: 'Постановка изменена',
        unknown: ''
      }[state],
      asset:
        state === 'completed' || state === 'stale' ? { dir: `${PAGE_PROJECT}/assets/shots/${id}`, video: STORY_VIDEO_PATH, original: STORY_VIDEO_PATH } : null,
      regenerateProblem: state === 'planned' ? 'Нет сохранённого запроса для повтора.' : null,
      attention: pkg?.pendingDecision?.question ?? null,
      packages: pkg ? [pkg] : []
    });
  });
}

function longPackage(shot: string): PackageView {
  const relative = `plan/batches/${shot}-попытка-с-очень-длинным-именем-папки-для-проверки-переноса-строк-01`;
  const base = packageForShot(keyframePackage(), shot);
  return {
    ...base,
    dir: `${PAGE_PROJECT}/${relative}`,
    relative,
    description:
      'Длинное описание пакета: герой стоит у старых ворот, вечерний свет падает слева, машина остаётся у забора, одежда и направление взгляда сохраняются между опорами. '.repeat(
        3
      )
  };
}
