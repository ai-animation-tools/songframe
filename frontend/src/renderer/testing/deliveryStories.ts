/** Общие снимки запроса и результата для локальных историй отправки, получения и приёмки. */
import type { AcceptOptions, JobInfo, PackageView, ProductionQuote } from '@shared/types';
import { FPS } from '@shared/video';
import { productionTexts } from '@shared/texts/production';
import { preparedPackage, queuedPackage } from './productionQueueStories';
import { STORY_IMAGE_PATH, STORY_VIDEO_PATH } from './storybook';

export const DELIVERY_PROJECT = '/mock/Клип у старых ворот';
export const DELIVERY_DATE = '2026-10-30T09:00:00.000Z';
export const DELIVERY_RESULT_TOKEN = 'c'.repeat(64);

export function deliveryPackage(kind: 'video' | 'image' = 'video', phase: 'prepared' | 'submitted' | 'downloaded' = 'downloaded'): PackageView {
  const source = kind === 'video' ? preparedPackage() : queuedPackage('image');
  const relative = `plan/batches/M02-${kind}-attempt-01`;
  const dir = `${DELIVERY_PROJECT}/${relative}`;
  const requestDir = `${dir}/requests/${kind}-01`;
  const stage =
    phase === 'prepared'
      ? kind === 'image'
        ? 'image_request_choice'
        : 'request_choice'
      : phase === 'submitted'
        ? kind === 'image'
          ? 'image_submitted'
          : 'submitted'
        : kind === 'image'
          ? 'image_downloaded'
          : 'downloaded';
  return {
    ...source,
    dir,
    relative,
    stage,
    stageLabel: phase === 'prepared' ? 'Запрос подготовлен' : phase === 'submitted' ? 'Получение результата' : 'Результат получен',
    waitReason: null,
    // Окно плана — 5 секунд, исходный видеорезультат — 8 секунд; приёмка требует выбора участка.
    timing: { frames: 150, window_seconds: 5, request_seconds: kind === 'video' ? 8 : 5 },
    keyframes: source.keyframes.map((frame) => (frame.role === 'last' ? { ...frame, time_seconds: kind === 'video' ? 8 : 5 } : frame)),
    prompt: source.prompt ? { ...source.prompt, path: `${dir}/video-prompt.txt` } : null,
    request: {
      ...source.request!,
      dir: requestDir,
      parameters: kind === 'video' ? { duration: 8 } : { aspect_ratio: '16:9' },
      attemptStatus: phase,
      generationId: phase === 'prepared' ? null : `demo-${kind}-01`,
      creditsConsumed: phase === 'prepared' ? null : 12,
      downloads: phase === 'downloaded' ? [`${requestDir}/${(kind === 'video' ? STORY_VIDEO_PATH : STORY_IMAGE_PATH).split('/').pop()}`] : []
    },
    decisionToken: 'd'.repeat(64),
    resultToken: phase === 'downloaded' ? DELIVERY_RESULT_TOKEN : undefined,
    pendingDecision:
      phase === 'prepared'
        ? { stage, question: 'Отправить подготовленный запрос?', options: ['send', 'park', 'revise'], asked_at: DELIVERY_DATE }
        : phase === 'downloaded' && kind === 'video'
          ? { stage, question: 'Принять полученный результат?', options: ['accept', 'retry', 'review', 'revise'], asked_at: DELIVERY_DATE }
          : null,
    decision: phase === 'prepared' ? null : { stage: kind === 'image' ? 'image_request_choice' : 'request_choice', verdict: 'send', at: DELIVERY_DATE }
  };
}

export function deliveryQuote(pkg: PackageView, overrides: Partial<ProductionQuote> = {}): ProductionQuote {
  return { token: 'quote-demo-1', requestSha: pkg.request!.sha256!, verdict: 'ok', credits: 12, balance: 100, reasons: [], ...overrides };
}

/** Повторяет границу IPC Production.accept: неточные и пустые срезы не запускают задание.
 * Реальную обработку медиа и полный контракт accept_shot по-прежнему проверяют тесты приложения. */
export function assertDeliveryAcceptOptions(options: AcceptOptions): void {
  if (options.mode === 'full') return;
  const frame = (seconds: number | undefined): number => {
    if (
      typeof seconds !== 'number' ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      !Number.isSafeInteger(Math.round(seconds * FPS)) ||
      Math.abs(seconds * FPS - Math.round(seconds * FPS)) > 1e-6
    )
      throw new Error(productionTexts.main.package.acceptBoundsInvalid({ fps: FPS }));
    return Math.round(seconds * FPS);
  };
  const start = frame(options.cutStart);
  const end = frame(options.cutEnd);
  if (end <= start) throw new Error(productionTexts.main.package.acceptEndInvalid);
}

export function deliveryJob(kind: JobInfo['kind'], overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: `demo-${kind}-1`,
    project: DELIVERY_PROJECT,
    kind,
    title: 'Локальное задание витрины',
    status: 'running',
    startedAt: DELIVERY_DATE,
    finishedAt: null,
    log: '',
    code: null,
    steps: [],
    ...overrides
  };
}
