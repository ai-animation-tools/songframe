/** Черновик замечания и платное подтверждение относятся к показанному вопросу, а не ко всему плану. */
import type { Api } from '@shared/api';
import type { AcceptOptions, JobInfo, PackageView, ProductionView } from '@shared/types';
import { FPS } from '@shared/video';

export function decisionNoteKey(pkg: PackageView): string {
  return `${pkg.dir}\0${pkg.decisionToken ?? JSON.stringify(pkg.pendingDecision)}`;
}

export async function sendConfirmedRequest(
  api: Api,
  project: string,
  pkg: PackageView,
  quoteToken?: string,
  unknownCostConsentToken?: string
): Promise<JobInfo | void> {
  if (!pkg.request?.sha256) throw new Error('У показанного запроса нет SHA256. Обновите пакет перед отправкой.');
  if (!quoteToken) throw new Error('Перед отправкой обновите и подтвердите стоимость запроса.');
  // Главный процесс атомарно связывает разрешение и отправку с этим снимком запроса.
  if (unknownCostConsentToken) {
    // Согласие относится к показанной оценке; новая подготовка или обновление цены потребуют другого токена.
    if (unknownCostConsentToken !== quoteToken) throw new Error('Согласие относится к другой проверке стоимости. Подтвердите запрос заново.');
    return api.production.submit(project, pkg.dir, pkg.request.sha256, pkg.decisionToken, quoteToken, unknownCostConsentToken);
  } else {
    return api.production.submit(project, pkg.dir, pkg.request.sha256, pkg.decisionToken, quoteToken);
  }
}

/** Приёмка связана с показанными оригиналами; токен вопроса не заменяет токен результата. */
export interface AcceptTarget {
  shot: string;
  dir: string;
  resultToken?: string;
  /** У плана уже есть комплект в assets: приёмка возможна только с явной заменой. */
  hasAsset?: boolean;
  /** Длина окна плана и запрошенного оригинала в кадрах: при расхождении «целиком» заведомо не подходит. */
  windowFrames?: number;
  originalFrames?: number;
  /** Речевой план без подготовленного WAV принять нельзя: accept_shot требует точный срез песни. */
  speechMissing?: boolean;
}

export function acceptTargetFor(pkg: PackageView, hasAsset: boolean, lipsync = false): AcceptTarget {
  const window = pkg.timing?.frames ?? (pkg.timing?.window_seconds ? Math.round(pkg.timing.window_seconds * FPS) : undefined);
  // У повтора по сохранённому запросу длительность есть только в параметрах запроса.
  const requested = pkg.timing?.request_seconds ?? Number(pkg.request?.parameters?.duration);
  const original = requested > 0 ? Math.round(requested * FPS) : undefined;
  return {
    shot: pkg.shot,
    dir: pkg.dir,
    resultToken: pkg.resultToken,
    hasAsset,
    windowFrames: window,
    originalFrames: original,
    speechMissing: lipsync && !pkg.speech
  };
}

/** Оригинал короче окна удерживает последний кадр, длиннее — обрезается по окну; совпадающий принимается целиком. */
export function defaultAcceptOptions(target: AcceptTarget): AcceptOptions {
  const base: AcceptOptions = { mode: 'full', cutStart: 0, cutEnd: 0, speed: '1', holdFirst: 0, holdLast: 0 };
  const { windowFrames: window, originalFrames: original } = target;
  if (!window || !original || window === original) return base;
  return { ...base, mode: 'cut', cutEnd: Math.min(window, original) / FPS, holdLast: Math.max(0, window - original) };
}

export async function acceptShownResult(api: Api, project: string, target: AcceptTarget, options: AcceptOptions): Promise<JobInfo> {
  if (!target.resultToken) throw new Error('Результат не подтверждён. Обновите пакет и откройте приёмку заново.');
  if (target.hasAsset && !options.replaceExisting) throw new Error('У плана уже есть принятый комплект. Подтвердите замену в диалоге приёмки.');
  return api.production.accept(project, target.shot, target.dir, { ...options, expectedResultToken: target.resultToken });
}

/** Проба стыков собирается с соседями по шкале: предыдущий план, сам план и следующий. */
export function reviewShots(view: ProductionView, shotId: string): string[] {
  const index = view.shots.findIndex((shot) => shot.id === shotId);
  if (index === -1) return [shotId];
  return view.shots.slice(Math.max(0, index - 1), index + 2).map((shot) => shot.id);
}

/** Маршрут монтажа для пробы стыков: соседи по шкале и результат показанной попытки на дорожке сцены. */
export function reviewMontageRoute(view: ProductionView, pkg: PackageView, project: string): string {
  const download = pkg.request?.downloads[0];
  const root = project.replace(/[\\/]+$/, '');
  const relative =
    download && (download.startsWith(root + '/') || download.startsWith(root + '\\')) ? download.slice(root.length + 1).replaceAll('\\', '/') : null;
  const source = relative ? `&source=${encodeURIComponent(`${pkg.shot}:${relative}`)}` : '';
  return `/project/montage?shots=${reviewShots(view, pkg.shot).join(',')}${source}`;
}

/** regenerate_shot печатает JSON с полем package: это папка новой попытки, которую страница открывает сама. */
export function regeneratedPackage(log: string): string | null {
  const matches = log.match(/\{[^\n]*"package"[^\n]*\}/g);
  for (const candidate of (matches ?? []).reverse()) {
    try {
      const data = JSON.parse(candidate) as { package?: unknown };
      if (typeof data.package === 'string' && data.package) return data.package;
    } catch {
      // Строка журнала не является JSON целиком: проверяем предыдущие.
    }
  }
  return null;
}

/** В очереди остаются сохранённые неотправленные запросы, включая опоры изображений. */
export function isQueuedPackage(pkg: PackageView): boolean {
  return pkg.relative.replaceAll('\\', '/').startsWith('plan/awaiting/') && pkg.request?.attemptStatus === 'prepared';
}

/** park переименовывает папку попытки в ID плана: перенос узнаём по плану и неизменному SHA запроса. */
export function relocatedPackage(pkg: PackageView, view: ProductionView): PackageView | null {
  if (!pkg.request?.sha256) return null;
  const candidates = view.shots
    .filter((shot) => shot.id === pkg.shot)
    .flatMap((shot) => shot.packages)
    .filter((candidate) => isQueuedPackage(candidate) && candidate.request?.sha256 === pkg.request?.sha256);
  return candidates.length === 1 ? candidates[0] : null;
}
