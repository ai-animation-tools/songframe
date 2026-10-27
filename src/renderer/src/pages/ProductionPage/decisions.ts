/** Черновик замечания и платное подтверждение относятся к показанному вопросу, а не ко всему плану. */
import type { Api } from '@shared/api';
import type { AcceptOptions, JobInfo, PackageView, ProductionView } from '@shared/types';

export function isExternalPackage(pkg: PackageView): boolean {
  return pkg.executor === 'agent' || pkg.pendingDecision?.executor === 'agent';
}

export function decisionNoteKey(pkg: PackageView): string {
  return `${pkg.dir}\0${pkg.decisionToken ?? JSON.stringify(pkg.pendingDecision)}`;
}

export async function sendConfirmedRequest(api: Api, project: string, pkg: PackageView, quoteToken?: string, unknownCostConsentToken?: string): Promise<void> {
  if (isExternalPackage(pkg)) {
    await api.production.decide(project, pkg.dir, 'send', '', pkg.decisionToken);
    return;
  }
  if (!pkg.request?.sha256) throw new Error('У показанного запроса нет SHA256. Обновите пакет перед отправкой.');
  if (!quoteToken) throw new Error('Перед отправкой обновите и подтвердите стоимость запроса.');
  // Главный процесс атомарно связывает разрешение и отправку с этим снимком запроса.
  if (unknownCostConsentToken) {
    // Согласие относится к показанной оценке; новая подготовка или обновление цены потребуют другого токена.
    if (unknownCostConsentToken !== quoteToken) throw new Error('Согласие относится к другой проверке стоимости. Подтвердите запрос заново.');
    await api.production.submit(project, pkg.dir, pkg.request.sha256, pkg.decisionToken, quoteToken, unknownCostConsentToken);
  } else {
    await api.production.submit(project, pkg.dir, pkg.request.sha256, pkg.decisionToken, quoteToken);
  }
}

/** Приёмка связана с показанными оригиналами; токен вопроса не заменяет токен результата. */
export interface AcceptTarget {
  shot: string;
  dir: string;
  resultToken?: string;
}

export async function acceptShownResult(api: Api, project: string, target: AcceptTarget, options: AcceptOptions): Promise<JobInfo> {
  if (!target.resultToken) throw new Error('Результат не подтверждён. Обновите пакет и откройте приёмку заново.');
  return api.production.accept(project, target.shot, target.dir, { ...options, expectedResultToken: target.resultToken });
}

/** После переноса в очередь сохраняем выбор только при однозначном совпадении того же пакета и frozen запроса. */
export function relocatedPackage(pkg: PackageView, view: ProductionView): PackageView | null {
  const name = pkg.dir.split(/[\\/]/).pop();
  const candidates = view.shots
    .filter((shot) => shot.id === pkg.shot)
    .flatMap((shot) => shot.packages)
    .filter((candidate) => candidate.dir.split(/[\\/]/).pop() === name && candidate.request?.sha256 === pkg.request?.sha256);
  return candidates.length === 1 ? candidates[0] : null;
}
