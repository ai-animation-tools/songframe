/**
 * Локальная модель целой страницы «Производство»: снимок производства, задания и переходы ответов существуют только в памяти.
 * Выбор image original, утверждение опоры и приёмка комплекта остаются отдельными методами API, как в Go.
 */
import { useSyncExternalStore, type ReactElement } from 'react';
import { Button, Paper, Stack, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import type { VideoReviewView } from '@shared/video-review';
import { videoReviewTexts } from '@shared/texts/video-review';
import type { Api } from '@shared/api';
import type { AcceptedKit, AppState, ShotSpend, BrokenPackage, JobInfo, PackageView, ProductionView, ShotProduction } from '@shared/types';
import type { ProductionFramePrompt, ProductionProposal } from '@shared/production-workflow';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { productionTexts } from '@shared/texts/production';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { ProductionPage } from '../pages/ProductionPage/ProductionPage';
import { storyAccess } from './commonStories';
import { assertDeliveryAcceptOptions, DELIVERY_PROJECT, deliveryJob } from './deliveryStories';
import { createDerivedScenario } from './derivedStories';
import { fragmentModel } from './fragmentStories';
import { keyframePackage, keyframeQuestion } from './keyframeStories';
import { productionShot } from './productionQueueStories';
import { workflowProposal, workflowView } from './productionWorkflowStories';
import { reviewView } from './videoReviewStories';
import { createStoryApi, STORY_IMAGE_PATH, STORY_VIDEO_PATH, type StoryOptions } from './storybook';

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

/** Отказ Go для файла не MP4 (production.CheckManualResult). */
export const OWN_VIDEO_FORMAT_ERROR = 'Нужно видео в формате MP4, а выбранный файл в другом формате. Перекодируйте его в MP4 и загрузите снова.';

export interface ProductionPageModelOptions {
  shots: () => ShotProduction[];
  broken?: () => BrokenPackage[];
  problems?: string[];
  /** FFmpeg/ffprobe не найдены: проверка видео объясняет причину, просмотр остаётся доступен. */
  ffmpegMissing?: boolean;
  /** Первое чтение: обычное, отложенное (общий индикатор загрузки) или с ошибкой (повтор — штатным опросом). */
  firstRead?: 'ready' | 'delayed' | 'failed';
  /** Первая запись ответа завершается ошибкой без изменения снимка. */
  failFirstAction?: boolean;
  /** Ошибка относится к первому завершению анализа каждого пакета, а не к чтению всей страницы. */
  videoReview?: { failFirstRun?: boolean; runMs?: number };
  /** Идёт получение результата: Go сообщает о занятой попытке. */
  receiving?: boolean;
  /** Провайдер видео без липсинка: речевой план идёт ручной генерацией по пакету, с пошаговой инструкцией в реестре. */
  manual?: boolean;
  /** Предел длины видеопромпта провайдера (ProductionWorkflowView.promptMaxChars). */
  promptMaxChars?: number;
  /** Сведения принятого комплекта плана (production.acceptedKit); без модели — комплект без сведений генерации. */
  acceptedKit?: (shot: string) => AcceptedKit | null;
  /** Расход плана (production.spend); без модели — отправок нет и блок «Расход» не показывается. */
  spend?: (shot: string) => ShotSpend | null;
}

interface PageModel {
  view: ProductionView;
  jobs: JobInfo[];
  reads: number;
  decisions: number;
  selections: number;
  accepts: number;
  submissions: number;
  frameImports: number;
  frameNotes: string[];
  frameRuns: number;
  discards: number;
  reviewStarts: number;
  reviewCancels: number;
  manualBuilds: number;
  manualUploads: number;
  /** Загрузок своего видео плана (production.attachOwnVideo). */
  ownVideos: number;
  promptReopens: string[];
  /** Свои описания, сохранённые без агента: описание и число опор каждого. */
  ownSaves: string[];
  /** Выбранные способы генерации попыток по порядку. */
  methodChanges: string[];
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
          tools: { providers: { test: true } }
        },
        jobs: [],
        reads: 0,
        decisions: 0,
        selections: 0,
        accepts: 0,
        submissions: 0,
        frameImports: 0,
        frameNotes: [],
        frameRuns: 0,
        discards: 0,
        reviewStarts: 0,
        reviewCancels: 0,
        manualBuilds: 0,
        manualUploads: 0,
        ownVideos: 0,
        promptReopens: [],
        ownSaves: [],
        methodChanges: [],
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
      // Как хеш workflow в Go: токен есть у каждого пакета и меняется при любой записи.
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
        const reason = options.ffmpegMissing
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
      // Попытки со способом «Вручную вне приложения» (productionWorkflow.setGenerationMethod).
      const manualMethods = new Set<string>();
      // План опор своих описаний по папке попытки: опора без промпта создаётся только своим файлом.
      const ownFramePrompts = new Map<string, ProductionFramePrompt[]>();
      // Свой файл опоры становится предложением только на время между импортом и применением.
      const frameImports = new Map<string, ProductionProposal>();
      const workflowSnapshot = (project: string, shot: string, packageDir: string | undefined) => {
        checked(project);
        const pkg = model.view.shots.flatMap((item) => item.packages).find((item) => item.dir === packageDir);
        // Как в Go: следующая опора доступна, пока к попытке нет открытого вопроса.
        const nextFrame = pkg && !pkg.pendingDecision ? (pkg.keyframes.find((frame) => !frame.approved && !frame.imagePath)?.id ?? null) : null;
        // Как Go: пакет ручной генерации собирается после утверждённого промпта и, у речевого плана, готового среза, один раз на попытку.
        const chosen = !!packageDir && manualMethods.has(packageDir);
        const manualReason = !pkg
          ? null
          : pkg.request
            ? 'Пакет для ручной генерации уже собран.'
            : chosen && !pkg.prompt?.approved
              ? 'Сначала утвердите видеопромпт.'
              : options.manual && !pkg.speech
                ? 'Сначала подготовьте WAV в блоке «Речь».'
                : null;
        const manual = !!options.manual || chosen;
        return workflowView({
          ...(manual ? { manual: true, canBuildManual: !!pkg && !manualReason, videoProvider: TEST_PROVIDER } : {}),
          ...(options.manual ? { singleFrame: true } : {}),
          ...(chosen ? { generationMethod: 'manual' as const } : {}),
          // У ручной генерации предела промпта нет: у формы сервиса свои правила.
          ...(options.promptMaxChars && !manual ? { promptMaxChars: options.promptMaxChars, videoProvider: TEST_PROVIDER } : {}),
          project: PAGE_PROJECT,
          shot,
          packageDir: packageDir ?? null,
          busy: !!options.receiving,
          canPrepare: !packageDir,
          canGenerateFrames: !!nextFrame,
          nextFrame,
          framePrompts: (packageDir && ownFramePrompts.get(packageDir)) || [],
          proposal: (packageDir && frameImports.get(packageDir)) || null,
          reasons: packageDir
            ? {
                prepare: null,
                continue: 'Сначала ответьте на вопрос пакета.',
                frames: nextFrame ? null : 'Сначала ответьте на вопрос пакета.',
                ...(manual ? { manual: manualReason } : {})
              }
            : workflowView().reasons
        });
      };
      const derived = createDerivedScenario({ view: { project: PAGE_PROJECT } });
      // Фрагмент под музыку: задание tool и видео витрины; список заданий страницы остаётся своим.
      const fragment = fragmentModel();
      const session = createStoryApi({
        animatic: fragment.overrides.animatic,
        production: {
          acceptedKit: async (_project, shot) => structuredClone(options.acceptedKit?.(shot) ?? null),
          spend: async (_project, shot) =>
            structuredClone(
              options.spend?.(shot) ?? {
                attempts: 0,
                images: 0,
                videos: 0,
                rejected: 0,
                unknown: 0,
                manual: 0,
                totals: [],
                acceptedSeconds: null,
                perSecond: []
              }
            ),
          addKeyframeNote: async (project, dir, frame, note, scope) => {
            find(project, dir);
            model.frameNotes = [...model.frameNotes, `${frame}/${scope}: ${note}`];
            publish();
          },
          // Как shot_workflow reopen-prompt: утверждённый промпт возвращается, пока запрос не отправлен; опоры остаются.
          reopenPrompt: async (project, dir, note) => {
            const { shot, pkg } = find(project, dir);
            if (!pkg.prompt?.approved || !['prompt_review', 'request_choice'].includes(pkg.stage) || !note.trim())
              throw new Error('Видеопромпт сейчас вернуть нельзя.');
            model.promptReopens = [...model.promptReopens, note.trim()];
            pkg.prompt = { ...pkg.prompt, approved: false };
            pkg.request = null;
            pkg.stage = 'prompt_review';
            pkg.decision = { stage: 'prompt_review', verdict: 'revise', note: note.trim(), at: DATE };
            ask(shot, pkg, null);
            pkg.stageLabel = 'Видеопромпт возвращён на доработку';
            shot.stageLabel = pkg.stageLabel;
            publish();
          },
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
            // Как Go: принятое описание переводит попытку к опорам, первая из них становится следующей.
            // Как approve-prompt: утверждённый промпт ведёт к запросу; предел провайдера Go проверяет и здесь, кроме ручной попытки.
            if (pending.stage === 'prompt_review' && verdict === 'approve' && pkg.prompt) {
              if (options.promptMaxChars && !manualMethods.has(pkg.dir) && Array.from(pkg.prompt.text).length > options.promptMaxChars)
                throw new Error('Промпт длиннее предела провайдера: верните его на доработку.');
              pkg.decision = { stage: pending.stage, verdict, note, at: DATE };
              pkg.prompt = { ...pkg.prompt, approved: true };
              ask(shot, pkg, null);
              pkg.stageLabel = 'Видеопромпт утверждён';
              shot.stageLabel = pkg.stageLabel;
              publish();
              return;
            }
            if (pending.stage === 'description_review' && verdict === 'approve') {
              pkg.decision = { stage: pending.stage, verdict, note, at: DATE };
              pkg.stage = 'keyframes_review';
              ask(shot, pkg, null);
              pkg.stageLabel = 'Описание утверждено';
              shot.stageLabel = pkg.stageLabel;
              publish();
              return;
            }
            const frame = pending.frame;
            // Модель записывает только ответы об описании и опорах; прочие переходы показаны историями своих блоков.
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
          },
          // Загрузка видео ручной генерации: оригинал и сведения записываются сразу, затем вопрос о результате.
          attachManual: async (project, dir, video) => {
            const { shot, pkg } = find(project, dir);
            if (pkg.request?.mode !== 'manual' || pkg.request.attemptStatus !== 'manual_pending') throw new Error('Пакет ручной генерации не ждёт видео.');
            if (!video.source.trim()) throw new Error('Укажите источник видео.');
            model.manualUploads++;
            pkg.request = {
              ...pkg.request,
              attemptStatus: 'downloaded',
              manualResult: true,
              downloads: [video.file],
              manualGeneration: {
                source: video.source,
                original_name: video.file.split('/').pop() ?? video.file,
                attached_at: DATE,
                cost: video.costAmount === null || !video.costUnit ? null : { amount: video.costAmount, unit: video.costUnit },
                description: video.note || null
              }
            };
            pkg.stage = 'downloaded';
            pkg.stageLabel = 'Результат получен';
            pkg.resultToken = `manual-result-${model.manualUploads}`;
            ask(shot, pkg, {
              stage: 'downloaded',
              question: 'Принять полученный результат?',
              options: ['accept', 'retry', 'review', 'revise'],
              asked_at: DATE
            });
            shot.stageLabel = pkg.stageLabel;
            publish();
            return deliveryJob('submit', { id: `manual-${shot.id}-${model.manualUploads}`, project: PAGE_PROJECT, status: 'done', code: 0, finishedAt: DATE });
          },
          // Как Go: своё видео — новая попытка без описания, опор и промпта; вопрос о результате тот же, что после загрузки.
          attachOwnVideo: async (project, shotId, video) => {
            checked(project);
            const shot = model.view.shots.find((item) => item.id === shotId);
            if (!shot) throw new Error('План не найден.');
            if (!/\.mp4$/i.test(video.file)) throw new Error(OWN_VIDEO_FORMAT_ERROR);
            if (!video.source.trim()) throw new Error('Укажите источник видео.');
            model.ownVideos++;
            const relative = `plan/batches/${shot.id}-attempt-0${shot.packages.length + 1}`;
            const dir = `${PAGE_PROJECT}/${relative}`;
            const pkg = keyframePackage({
              dir,
              relative,
              shot: shot.id,
              stage: 'downloaded',
              stageLabel: 'Результат получен',
              keyframes: [],
              keyframeNotes: [],
              pendingDecision: null,
              timing: { frames: Math.round((shot.end - shot.start) * 30), window_seconds: shot.end - shot.start, request_seconds: null },
              resultToken: `own-video-${model.ownVideos}`,
              request: {
                dir: `${dir}/request-01`,
                kind: 'video',
                provider: 'manual',
                mode: 'manual',
                ownVideo: true,
                sha256: 'c'.repeat(64),
                model: '',
                parameters: {},
                inputs: [],
                attemptStatus: 'downloaded',
                promptText: '',
                generationId: null,
                manualResult: true,
                creditsConsumed: null,
                downloads: [video.file],
                manualGeneration: {
                  source: video.source,
                  original_name: video.file.split('/').pop() ?? video.file,
                  attached_at: DATE,
                  cost: video.costAmount === null || !video.costUnit ? null : { amount: video.costAmount, unit: video.costUnit },
                  description: video.note || null
                }
              }
            });
            shot.packages = [...shot.packages, pkg];
            shot.state = 'progress';
            ask(shot, pkg, {
              stage: 'downloaded',
              question: 'Принять полученный результат?',
              options: ['accept', 'retry', 'review', 'revise'],
              asked_at: DATE
            });
            shot.stageLabel = pkg.stageLabel;
            publish();
            return {
              packageDir: dir,
              job: deliveryJob('submit', { id: `own-video-${shot.id}-${model.ownVideos}`, project: PAGE_PROJECT, status: 'done', code: 0, finishedAt: DATE })
            };
          },
          discardAttempt: async (project, dir) => {
            const { shot, pkg } = find(project, dir);
            shot.packages = shot.packages.filter((item) => item !== pkg);
            shot.attention = shot.packages.find((item) => item.pendingDecision)?.pendingDecision?.question ?? null;
            model.discards++;
            publish();
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
            // Таймеры принадлежат сессии истории и отменяются вместе с анализом; настоящий API не используется.
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
        jobs: { list: async () => structuredClone(model.jobs), get: fragment.overrides.jobs.get },
        productionWorkflow: {
          // Подготовка агентом показана отдельной группой историй; здесь есть только свой файл опоры, идущий мимо агента.
          view: async (project, shot, packageDir) => workflowSnapshot(project, shot, packageDir),
          generateFrames: async (project, shot, dir) => {
            find(project, dir);
            model.frameRuns++;
            publish();
            return workflowSnapshot(project, shot, dir);
          },
          // Как Go: способ попытки записывается до утверждения промпта, пока запрос не подготовлен.
          setGenerationMethod: async (project, shot, dir, method) => {
            const { pkg } = find(project, dir);
            if (options.manual || pkg.prompt?.approved || pkg.request) throw new Error('Способ генерации этой попытки сменить нельзя.');
            if (method === 'manual') manualMethods.add(dir);
            else manualMethods.delete(dir);
            model.methodChanges = [...model.methodChanges, method];
            touch(pkg);
            publish();
            return workflowSnapshot(project, shot, dir);
          },
          buildManual: async (project, shot, dir) => {
            const { pkg } = find(project, dir);
            const chosen = manualMethods.has(dir);
            if ((!options.manual && !chosen) || pkg.request || (options.manual && !pkg.speech) || (chosen && !pkg.prompt?.approved))
              throw new Error('Пакет для ручной генерации сейчас собрать нельзя.');
            const requestDir = `${pkg.dir}/request-01`;
            model.manualBuilds++;
            pkg.stage = 'request_choice';
            pkg.stageLabel = 'Пакет для ручной генерации собран';
            pkg.request = {
              dir: requestDir,
              kind: 'video',
              provider: TEST_PROVIDER,
              mode: 'manual',
              sha256: 'b'.repeat(64),
              model: '',
              parameters: { duration: pkg.timing?.request_seconds ?? 5 },
              // Входы — утверждённые опоры по порядку, у речевого плана затем срез речи.
              inputs: [
                ...(options.manual ? pkg.keyframes.slice(0, 1) : pkg.keyframes).map((frame, index) => ({
                  slot: 'image',
                  role: `Опора ${frame.id}`,
                  path: `inputs/0${index + 1}.png`,
                  imagePath: `${requestDir}/inputs/0${index + 1}.png`
                })),
                ...(options.manual ? [{ slot: 'audio', role: 'Срез речи', path: 'inputs/02.wav', imagePath: `${requestDir}/inputs/02.wav` }] : [])
              ],
              attemptStatus: 'manual_pending',
              promptText: pkg.prompt?.text ?? null,
              generationId: null,
              manualResult: false,
              creditsConsumed: null,
              downloads: []
            };
            touch(pkg);
            publish();
            return workflowSnapshot(project, shot, dir);
          },
          importFrames: async (project, shot, dir, images) => {
            find(project, dir);
            model.frameImports++;
            frameImports.set(
              dir,
              workflowProposal('frames', { id: `page-import-${model.frameImports}`, jobId: '', after: { schemaVersion: 1, stage: 'frames', images } })
            );
            return workflowSnapshot(project, shot, dir);
          },
          referenceImages: async (project) => {
            checked(project);
            return ['source/heroes/story-image.png', 'source/places/story-image.png'];
          },
          // Как Go: своё описание проверяется правилами ответа агента и записывается в новую попытку с вопросом описания.
          saveOwn: async (input) => {
            checked(input.project);
            const shot = model.view.shots.find((item) => item.id === input.shot);
            if (input.stage === 'prompt') {
              const pkg = shot?.packages.find((item) => item.dir === input.packageDir);
              if (!shot || !pkg || !pkg.keyframes.every((frame) => frame.approved)) throw new Error('Сначала утвердите все опоры.');
              if (options.promptMaxChars && Array.from(input.prompt).length > options.promptMaxChars) throw new Error('Промпт длиннее предела провайдера.');
              pkg.prompt = { path: `${pkg.dir}/video-prompt.txt`, approved: false, text: input.prompt };
              pkg.request = null;
              pkg.stage = 'prompt_review';
              pkg.stageLabel = 'Видеопромпт на согласовании';
              ask(shot, pkg, { stage: 'prompt_review', question: 'Утвердить видеопромпт?', options: ['approve', 'revise'], asked_at: DATE });
              shot.stageLabel = pkg.stageLabel;
              model.ownSaves = [...model.ownSaves, `промпт ${Array.from(input.prompt).length}`];
              publish();
              return workflowSnapshot(input.project, input.shot, pkg.dir);
            }
            if (!shot) throw new Error('Своё описание этого плана в витрине не моделируется.');
            if (input.keyframes.at(-1)?.timeSeconds !== input.requestSeconds) throw new Error('Последняя опора должна стоять в конце запроса.');
            const existing = input.packageDir ? shot.packages.find((item) => item.dir === input.packageDir) : undefined;
            const relative = `plan/batches/${shot.id}-attempt-0${shot.packages.length + 1}`;
            const pkg =
              existing ??
              keyframePackage({
                dir: `${PAGE_PROJECT}/${relative}`,
                relative,
                shot: shot.id,
                keyframeNotes: [],
                timing: { frames: Math.round((shot.end - shot.start) * 30), window_seconds: shot.end - shot.start, request_seconds: input.requestSeconds }
              });
            pkg.stage = 'description_review';
            pkg.stageLabel = 'Описание на согласовании';
            pkg.description = input.description;
            pkg.timing = pkg.timing ? { ...pkg.timing, request_seconds: input.requestSeconds } : pkg.timing;
            pkg.keyframes = input.keyframes.map((frame) => ({
              id: frame.id,
              role: frame.role,
              time_seconds: frame.timeSeconds,
              imagePath: null,
              approved: false
            }));
            ownFramePrompts.set(pkg.dir, input.keyframes);
            if (!existing) shot.packages = [...shot.packages, pkg];
            shot.state = 'progress';
            ask(shot, pkg, { stage: 'description_review', question: 'Утвердить описание?', options: ['approve', 'revise'], asked_at: DATE });
            shot.stageLabel = pkg.stageLabel;
            model.ownSaves = [...model.ownSaves, `${input.description} (${input.keyframes.length})`];
            publish();
            return workflowSnapshot(input.project, input.shot, pkg.dir);
          },
          // Применение записывает кандидата и задаёт вопрос: утверждение остаётся отдельным ответом.
          apply: async (project, shotId, dir, id) => {
            const { shot, pkg } = find(project, dir ?? '');
            const proposal = frameImports.get(pkg.dir);
            if (proposal?.id !== id || proposal.after?.stage !== 'frames') throw new Error('Предложение больше нельзя применить.');
            const [image] = proposal.after.images;
            frameImports.delete(pkg.dir);
            pkg.keyframes = pkg.keyframes.map((item) => (item.id === image.id ? { ...item, imagePath: image.path, approved: false } : item));
            ask(shot, pkg, keyframeQuestion(image.id, question + 1));
            publish();
            return workflowSnapshot(project, shotId, pkg.dir);
          }
        },
        // Видео выбирается окном с фильтром MP4 (своё видео, ручная генерация), иначе — изображение опоры.
        dialog: {
          pickFiles: async (request) => [
            request?.filters?.some((filter) => filter.extensions.includes('mp4')) || options.manual || manualMethods.size ? STORY_VIDEO_PATH : STORY_IMAGE_PATH
          ]
        },
        shell: { openPath: async () => undefined, fileUrl: fragment.overrides.shell.fileUrl },
        derivedShots: derived.api.derivedShots
      });
      models.set(session.api, model);
      session.onCleanup(
        registerMediaProviderForTests(
          TEST_PROVIDER,
          options.manual
            ? {
                ...testProviderInfo,
                lipSync: null,
                manualLipSync: {
                  url: 'https://example.test/avatar',
                  steps: ['Откройте сайт {url} и выберите режим с липсинком.', 'Загрузите изображение {image} и звук {audio}.', 'Вставьте видеопромпт.'],
                  sourceExample: 'Тестовый сервис на сайте'
                }
              }
            : testProviderInfo
        )
      );
      session.onCleanup(derived.dispose);
      session.onCleanup(fragment.dispose);
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
            комплекта: {model.accepts}. Отправок генерации: {model.submissions}. Своих файлов опор: {model.frameImports}. Указаний к опорам:{' '}
            {model.frameNotes.join(', ') || 'нет'}. Созданий опор: {model.frameRuns}. Удалений попыток: {model.discards}. Пакетов ручной генерации:{' '}
            {model.manualBuilds}. Загрузок видео: {model.manualUploads}. Своих видео: {model.ownVideos}. Возвратов промпта:{' '}
            {model.promptReopens.join(', ') || 'нет'}. Своих описаний: {model.ownSaves.join(', ') || 'нет'}. Способов генерации:{' '}
            {model.methodChanges.join(', ') || 'нет'}.
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
