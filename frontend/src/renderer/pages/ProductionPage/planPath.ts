import { productionTexts } from '@shared/texts/production';
/**
 * Путь плана: какие шаги есть, на каком шаге план и что сказать пользователю. Чистая функция над
 * снимками страницы и панели: своего состояния у пути нет, источник истины — workflow.json попытки.
 */
import type { ProductionPass, ProductionWorkflowView } from '@shared/production-workflow';
import type { PackageView, ShotProduction } from '@shared/types';
import { formatClock } from '../../format';

export type PlanStepKey = 'description' | 'frames' | 'prompt' | 'speech' | 'request' | 'generation' | 'result';
export type PlanStepStatus = 'done' | 'current' | 'future';
/** action — ход пользователя, wait — ждём агента или сервис, done — план принят. */
export type PlanTone = 'action' | 'wait' | 'done';

export interface PlanStep {
  key: PlanStepKey;
  title: string;
  status: PlanStepStatus;
  summary: string | null;
}
export interface PlanPath {
  steps: PlanStep[];
  current: PlanStepKey;
  /** Все шаги пройдены: результат принят. */
  finished: boolean;
  now: string;
  tone: PlanTone;
}

/** Попытка отправлена и ещё не завершена: повторная оплата и удаление запрещены. */
export const REQUEST_IN_FLIGHT = [
  'submitting',
  'submission_unknown',
  'submitted',
  'running',
  'watermark_free_pending',
  'outputs_pending',
  'download_pending',
  'downloading',
  'polling'
];

const QUESTION_STEPS: Record<string, PlanStepKey> = {
  description_review: 'description',
  keyframes_review: 'frames',
  image_request_choice: 'frames',
  prompt_review: 'prompt',
  request_choice: 'request',
  downloaded: 'result',
  edit_review: 'result'
};

const PROPOSAL_STEPS: Record<ProductionPass, PlanStepKey> = { description: 'description', frames: 'frames', prompt: 'prompt', request: 'request' };

const texts = productionTexts.planPath;

/** Вопрос задан на шаге пути: шаг, которому принадлежит пользовательское решение. */
export function questionStep(stage: string): PlanStepKey | null {
  return QUESTION_STEPS[stage] ?? null;
}

/** Речевой план у провайдера без липсинка: видео создаётся вне приложения, шаг запроса — ручная генерация без отправки. */
export function manualGeneration(pkg: PackageView | null, workflow: ProductionWorkflowView | null): boolean {
  return !!workflow?.manual || pkg?.request?.mode === 'manual';
}

/** Текущий шаг: незавершённая работа агента важнее этапа попытки, открытый вопрос — важнее фактов. */
function currentStep(shot: ShotProduction, pkg: PackageView | null, workflow: ProductionWorkflowView | null, newAttempt: boolean): PlanStepKey {
  const proposal = workflow?.proposal;
  if (proposal && proposal.status !== 'applied') return PROPOSAL_STEPS[proposal.stage];
  if (!pkg) return shot.asset && !newAttempt ? 'result' : 'description';
  const asked = pkg.pendingDecision ? questionStep(pkg.pendingDecision.stage) : null;
  if (asked) return asked;
  const { stage, request } = pkg;
  if (stage.startsWith('image_')) return 'frames';
  if (stage === 'downloaded' || stage === 'edit_review' || stage === 'accepted') return 'result';
  // Видео ручной генерации загружается заданием приложения: шага ожидания сервиса у такого плана нет.
  if (manualGeneration(pkg, workflow) && (stage === 'submitted' || stage === 'request_choice' || stage === 'ready')) return 'request';
  if (stage === 'submitted') return 'generation';
  if (request && request.kind !== 'image' && REQUEST_IN_FLIGHT.includes(request.attemptStatus ?? '')) return 'generation';
  if (stage === 'request_choice' || stage === 'ready') return 'request';
  // Возврат с замечанием остаётся на шаге, с которого вернули.
  const returned = stage === 'needs_revision' && pkg.decision ? questionStep(pkg.decision.stage) : null;
  if (returned) return returned;
  // Принятое описание оставляет этап прежним до первой опоры: путь идёт дальше по ответу.
  const descriptionAccepted = pkg.decision?.stage === 'description_review' && pkg.decision.verdict === 'approve';
  if ((stage === 'description_review' && !descriptionAccepted) || !pkg.keyframes.length) return 'description';
  if (pkg.keyframes.some((frame) => !frame.approved)) return 'frames';
  if (!pkg.prompt?.approved) return 'prompt';
  if (shot.lipsync && !pkg.speech) return 'speech';
  return 'request';
}

/** Итог шага в его свёрнутой строке. */
function stepSummary(key: PlanStepKey, pkg: PackageView | null, manual: boolean): string | null {
  const frames = pkg?.keyframes.length ?? 0;
  const approved = pkg?.keyframes.filter((frame) => frame.approved).length ?? 0;
  switch (key) {
    case 'description':
      return texts.descriptionSummary({ frames, seconds: pkg?.timing?.request_seconds });
    case 'frames':
      return texts.framesSummary({ approved, frames });
    case 'prompt':
      return texts.promptSummary({ characters: pkg?.prompt?.text.length ?? 0 });
    case 'speech':
      return pkg?.speech
        ? texts.speechSummary({
            start: formatClock(pkg.speech.start),
            end: formatClock(pkg.speech.end),
            seconds: productionTexts.productionSpeechPanel.seconds(pkg.speech.end - pkg.speech.start)
          })
        : null;
    case 'request':
      return manual ? texts.manualSummary : texts.requestSummary({ credits: pkg?.request?.creditsConsumed });
    case 'generation':
      return texts.generationSummary;
    case 'result':
      return texts.resultSummary;
  }
}

/** Фраза шапки: что происходит и чей сейчас ход. */
function nowState(
  current: PlanStepKey,
  pkg: PackageView | null,
  workflow: ProductionWorkflowView | null,
  receiving: boolean,
  manual: boolean
): { now: string; tone: PlanTone } {
  const action = (text: string): { now: string; tone: PlanTone } => ({ now: texts.now({ text }), tone: 'action' });
  const wait = (text: string): { now: string; tone: PlanTone } => ({ now: texts.now({ text }), tone: 'wait' });
  const proposal = workflow?.proposal;
  if (proposal?.status === 'running') return wait(proposal.stage === 'frames' ? texts.frameWorking : texts.agentWorking);
  if (proposal && proposal.status !== 'applied') return action(proposal.status === 'ready' && !proposal.stale ? texts.proposalReady : texts.proposalProblem);
  const pending = pkg?.pendingDecision;
  if (pending?.frame) return action(texts.frameQuestion({ frame: pending.frame }));
  if (pending && pending.stage === 'request_choice') return action(texts.sendRequest);
  if (pending && questionStep(pending.stage) === 'result') return action(texts.reviewResult);
  if (pending) return action(texts.questionOpen);
  switch (current) {
    case 'description':
      return action(texts.prepareDescription);
    case 'frames':
      return action(workflow?.nextFrame ? texts.chooseFrame({ frame: workflow.nextFrame }) : texts.questionOpen);
    case 'prompt':
      return action(texts.preparePrompt);
    case 'speech':
      return action(texts.prepareSpeech);
    case 'request':
      if (manual) return receiving ? wait(texts.manualUploading) : action(pkg?.request ? texts.uploadManual : texts.buildManual);
      return action(pkg?.request ? texts.sendRequest : texts.prepareRequest);
    case 'generation':
      if (pkg?.request?.attemptStatus === 'submission_unknown') return action(texts.unknownSubmission);
      // Без идущего получения приложение ничего не ждёт, даже если статус попытки ещё «отправлен».
      if (!receiving) return action(pkg?.request?.attemptStatus === 'submitting' ? texts.unknownSubmission : texts.receiveResult);
      return wait(texts.waitService);
    case 'result':
      return action(texts.reviewResult);
  }
}

/**
 * Шаги пути плана. Срез речи есть только у речевого плана; newAttempt — пользователь сам начал
 * новую попытку; receiving — приложение сейчас отправляет запрос или получает результат.
 */
export function planPath(
  shot: ShotProduction,
  pkg: PackageView | null,
  workflow: ProductionWorkflowView | null,
  newAttempt = false,
  receiving = false
): PlanPath {
  const manual = manualGeneration(pkg, workflow);
  const keys: PlanStepKey[] = [
    'description',
    'frames',
    'prompt',
    ...(shot.lipsync ? (['speech'] as const) : []),
    'request',
    ...(manual ? [] : (['generation'] as const)),
    'result'
  ];
  const current = currentStep(shot, pkg, workflow, newAttempt);
  const index = keys.indexOf(current);
  const finished = current === 'result' && (pkg ? pkg.stage === 'accepted' : !!shot.asset);
  const steps = keys.map((key, position): PlanStep => {
    const status: PlanStepStatus = position < index || finished ? 'done' : position === index ? 'current' : 'future';
    return {
      key,
      title: manual && key === 'request' ? texts.titles.manual : texts.titles[key],
      status,
      summary:
        status === 'future'
          ? manual && key === 'request'
            ? texts.after.manual
            : texts.after[key]
          : status === 'done' || (key === 'frames' && !!pkg?.keyframes.length)
            ? stepSummary(key, pkg, manual)
            : null
    };
  });
  return finished
    ? { steps, current, finished, now: texts.finished, tone: 'done' }
    : { steps, current, finished, ...nowState(current, pkg, workflow, receiving, manual) };
}

/** Какая попытка открывается сама: с открытым вопросом, иначе последняя. */
export function defaultAttempt(packages: PackageView[]): PackageView | null {
  return packages.find((pkg) => pkg.pendingDecision) ?? packages.at(-1) ?? null;
}

/** Подпись попытки: номер из имени папки, очередь называется очередью. */
export function attemptLabel(pkg: PackageView): string {
  const number = /attempt-(\d+)$/.exec(pkg.relative.replaceAll('\\', '/'))?.[1];
  return number ? texts.attempt({ number: String(Number(number)) }) : pkg.relative;
}
