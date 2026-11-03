/** Локальная модель панели сохраняет предложения отдельно от пакета; реальный hook продолжает штатный опрос. */
import { productionTexts } from '@shared/texts/production';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Button, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import type { Api } from '@shared/api';
import type { PackageView } from '@shared/types';
import type { ProductionWorkflowView } from '@shared/production-workflow';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { TEST_AGENT_PROVIDER, testAgentProviderInfo } from '@shared/testing/media-provider';
import { ProductionWorkflowPanel } from '../pages/ProductionPage/components/ProductionWorkflowPanel';
import { storyAccess } from './commonStories';
import { createStoryApi, STORY_IMAGE_PATH, type StoryOptions } from './storybook';
import { WORKFLOW_STORY_PACKAGE, WORKFLOW_STORY_PROJECT, workflowAgentJob, workflowProposal, workflowView } from './productionWorkflowStories';

export type WorkflowPanelMode =
  | 'empty'
  | 'loading'
  | 'readFailure'
  | 'ready'
  | 'applyFailure'
  | 'invalid'
  | 'stale'
  | 'refused'
  | 'failedJob'
  | 'revision'
  | 'paid'
  | 'derived'
  | 'blocked'
  | 'offline'
  | 'missing'
  | 'late'
  | 'frames';
export const PANEL_SAVED_NOTE = 'Сохранить свет слева, убрать лишнее движение камеры.';
interface PanelModel {
  mode: WorkflowPanelMode;
  shot: string;
  dir: string | undefined;
  question: number;
  view: ProductionWorkflowView;
  starts: number;
  applies: number;
  discards: number;
  callbacks: number;
  busy: boolean;
  busySeen: boolean;
  saved: string;
  note: string;
  reads: number;
  lateFinished: boolean;
  images: Record<string, string>;
  jobFault: number;
  breakJob(): void;
  subscribe(listener: () => void): () => void;
  revision(): number;
  publish(): void;
  reset(): void;
  switchContext(): void;
  release(): void;
}
const models = new WeakMap<Api, PanelModel>();

export function workflowPanelOptions(mode: WorkflowPanelMode = 'empty'): StoryOptions {
  return {
    app: {
      online: mode !== 'offline',
      agentProvider: mode === 'missing' ? null : 'codex',
      aiAccess:
        mode === 'missing'
          ? { ...storyAccess, agent: { ...storyAccess.agent, selected: false, available: false, message: 'Выберите агента на странице «Среда».' } }
          : { ...storyAccess, image: { ...storyAccess.image, provider: TEST_AGENT_PROVIDER } }
    },
    createApi: () => {
      const listeners = new Set<() => void>();
      const pending = new Set<() => void>();
      let version = 0;
      let generation = 0;
      let disposed = false;
      let failedRead = false;
      let failedApply = false;
      let running = false;
      const snapshot = () => structuredClone(model.view);
      const initial = (): ProductionWorkflowView => {
        const ready = ['ready', 'applyFailure', 'invalid', 'stale', 'refused'].includes(mode);
        const hasPackage = ['revision', 'paid', 'frames'].includes(mode);
        const view = workflowView({ packageDir: hasPackage ? WORKFLOW_STORY_PACKAGE : null, imageProvider: TEST_AGENT_PROVIDER });
        if (ready) {
          view.canPrepare = mode === 'invalid' || mode === 'refused';
          view.proposal = workflowProposal(
            'description',
            mode === 'invalid'
              ? { status: 'invalid', after: null, message: 'В ответе нет плана опор.', agentText: '{"description":"Без опор"}' }
              : mode === 'refused'
                ? { status: 'invalid', refused: true, after: null, agentText: 'Положение машины противоречит утверждённой сцене: уточните постановку.' }
                : { stale: mode === 'stale' }
          );
          view.job = workflowAgentJob({ status: 'completed', exitCode: 0 });
        }
        if (mode === 'failedJob') view.job = workflowAgentJob({ status: 'failed', exitCode: 1, message: 'Программа завершилась до ответа.' });
        if (mode === 'revision') Object.assign(view, { canRevise: true, canPrepare: false, stage: 'needs_revision' });
        if (mode === 'paid') Object.assign(view, { paid: true, canPrepare: false, stage: 'submitted' });
        if (mode === 'derived' || mode === 'blocked') {
          view.canPrepare = false;
          view.reasons.prepare =
            mode === 'derived'
              ? 'План собирается из материала M01. Измените производный план на странице «Сценарий».'
              : 'Согласуйте сценарий на странице «Сценарий».';
          view.derivedFrom = mode === 'derived' ? 'M01' : null;
          view.problems = [view.reasons.prepare];
        }
        if (mode === 'frames') {
          const proposal = workflowProposal().after;
          Object.assign(view, {
            canPrepare: false,
            canGenerateFrames: true,
            stage: 'keyframes_review',
            nextFrame: 'K02',
            approvedFrameIds: ['K01'],
            framePrompts: proposal?.stage === 'description' ? proposal.keyframes : [],
            reasons: { ...view.reasons, frames: null }
          });
        }
        return view;
      };
      const model: PanelModel = {
        mode,
        shot: 'M02',
        dir: undefined,
        question: 1,
        view: workflowView(),
        starts: 0,
        applies: 0,
        discards: 0,
        callbacks: 0,
        busy: false,
        busySeen: false,
        saved: '',
        note: '',
        reads: 0,
        lateFinished: false,
        images: {},
        jobFault: 0,
        breakJob() {
          model.jobFault++;
          model.view = {
            ...model.view,
            job:
              model.jobFault === 1
                ? null
                : workflowAgentJob(model.jobFault === 2 ? { id: 'other-job', status: 'completed', exitCode: 0 } : { status: 'running' })
          };
          model.publish();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        revision: () => version,
        publish() {
          version++;
          listeners.forEach((listener) => listener());
        },
        reset() {
          generation++;
          pending.forEach((resolve) => resolve());
          pending.clear();
          failedRead = false;
          failedApply = false;
          running = false;
          model.shot = 'M02';
          model.view = initial();
          model.dir = model.view.packageDir ?? undefined;
          model.question = 1;
          model.starts = 0;
          model.applies = 0;
          model.discards = 0;
          model.callbacks = 0;
          model.busy = false;
          model.busySeen = false;
          model.saved = '';
          model.note = '';
          model.reads = 0;
          model.lateFinished = false;
          model.images = mode === 'frames' ? { K01: `${STORY_IMAGE_PATH}?frame=K01` } : {};
          model.jobFault = 0;
          model.publish();
        },
        switchContext() {
          model.shot = 'M03';
          model.dir = `${WORKFLOW_STORY_PROJECT}/plan/batches/M03-attempt-02`;
          model.view = workflowView({ shot: model.shot, packageDir: model.dir, canPrepare: false, problems: ['Выбран новый пакет M03.'] });
          model.publish();
        },
        release() {
          pending.forEach((resolve) => resolve());
          pending.clear();
        }
      };
      model.reset();
      const validate = (project: string, shot: string, dir: string | undefined): void => {
        if (disposed || project !== WORKFLOW_STORY_PROJECT || shot !== model.shot || dir !== model.dir) throw new Error('Контекст предложения изменился.');
      };
      const hasPending = (): boolean => !!model.view.proposal && ['running', 'ready'].includes(model.view.proposal.status);
      const complete = (): void => {
        running = false;
        model.view = {
          ...model.view,
          busy: false,
          proposal: workflowProposal(model.mode === 'frames' ? 'frames' : 'description', {
            id: model.view.proposal?.id,
            jobId: `job-${model.mode === 'frames' ? 'frames' : 'description'}-${model.starts}`,
            ...(model.mode === 'frames'
              ? { after: { schemaVersion: 1 as const, stage: 'frames' as const, images: [{ id: 'K02', path: STORY_IMAGE_PATH }] } }
              : {})
          }),
          job: workflowAgentJob({ id: `job-${model.mode === 'frames' ? 'frames' : 'description'}-${model.starts}`, status: 'completed', exitCode: 0 })
        };
        model.publish();
      };
      const wait = () => new Promise<void>((resolve) => pending.add(resolve));
      const session = createStoryApi({
        productionWorkflow: {
          view: async (project, shot, dir) => {
            validate(project, shot, dir);
            model.reads++;
            model.publish();
            if (mode === 'readFailure' && !failedRead) {
              failedRead = true;
              throw new Error('Не удалось прочитать пакет. Опрос повторит чтение.');
            }
            if ((mode === 'loading' || mode === 'late') && model.reads === 1) {
              const saved = snapshot();
              const epoch = generation;
              await wait();
              if (epoch !== generation) throw new Error('Модель сброшена.');
              model.lateFinished = true;
              model.publish();
              return mode === 'late' ? { ...saved, proposal: workflowProposal('description', { id: 'late-old-proposal' }) } : saved;
            }
            if (running) complete();
            return snapshot();
          },
          start: async (input) => {
            validate(input.project, input.shot, input.packageDir);
            if (
              model.view.busy ||
              model.view.paid ||
              hasPending() ||
              !(input.action === 'prepare'
                ? model.view.canPrepare
                : input.action === 'revise'
                  ? model.view.canRevise && !!input.note?.trim()
                  : model.view.canContinue)
            )
              throw new Error('Подготовка этого этапа недоступна.');
            model.starts++;
            model.note = input.note ?? '';
            running = true;
            model.view = {
              ...model.view,
              busy: true,
              canPrepare: false,
              proposal: workflowProposal('description', {
                id: `proposal-description-${model.starts}`,
                jobId: `job-description-${model.starts}`,
                status: 'running',
                after: null
              }),
              job: workflowAgentJob({ id: `job-description-${model.starts}` })
            };
            model.publish();
            return snapshot();
          },
          apply: async (project, shot, dir, id) => {
            validate(project, shot, dir);
            const proposal = model.view.proposal;
            if (model.view.busy || proposal?.id !== id || proposal.status !== 'ready' || proposal.stale || !proposal.after)
              throw new Error('Предложение больше нельзя применить.');
            if (
              proposal.jobId &&
              (!model.view.job || model.view.job.id !== proposal.jobId || model.view.job.status !== 'completed' || model.view.job.exitCode !== 0)
            )
              throw new Error('Нет успешно завершённого задания этого предложения.');
            model.applies++;
            model.publish();
            if (mode === 'applyFailure' && !failedApply) {
              failedApply = true;
              throw new Error('Не удалось записать пакет. Предложение и материалы сохранены.');
            }
            const after = proposal.after;
            if (after.stage === 'frames') {
              for (const image of after.images) {
                if (model.view.approvedFrameIds.includes(image.id)) throw new Error('Утверждённую опору нельзя заменить без возврата.');
                model.images[image.id] = image.path;
              }
            }
            model.saved =
              after.stage === 'description'
                ? after.description
                : after.stage === 'frames'
                  ? `Кандидат ${after.images[0]?.id}; K01 сохранена`
                  : 'Материалы сохранены';
            model.view = {
              ...model.view,
              packageDir: dir ?? WORKFLOW_STORY_PACKAGE,
              stage: after.stage === 'frames' ? 'keyframes_review' : 'description_review',
              proposal: null,
              canPrepare: false,
              canGenerateFrames: false,
              nextFrame: null
            };
            model.publish();
            return snapshot();
          },
          discard: async (project, shot, dir, id) => {
            validate(project, shot, dir);
            if (model.view.busy || !model.view.proposal || model.view.proposal.id !== id) throw new Error('Предложение уже изменилось.');
            model.discards++;
            model.view = {
              ...model.view,
              proposal: null,
              canPrepare: ['ready', 'applyFailure', 'stale'].includes(mode) || initial().canPrepare,
              canGenerateFrames: initial().canGenerateFrames
            };
            model.publish();
            return snapshot();
          },
          generateFrames: async (project, shot, dir) => {
            validate(project, shot, dir);
            if (!model.view.canGenerateFrames || model.view.busy || hasPending() || model.view.nextFrame !== 'K02')
              throw new Error('Нет следующей доступной опоры.');
            model.starts++;
            running = true;
            model.view = {
              ...model.view,
              busy: true,
              canGenerateFrames: false,
              proposal: workflowProposal('frames', {
                id: `proposal-frames-${model.starts}`,
                jobId: `job-frames-${model.starts}`,
                status: 'running',
                after: null
              }),
              job: workflowAgentJob({ id: `job-frames-${model.starts}`, task: 'Кандидат K02' })
            };
            model.publish();
            return snapshot();
          },
          importFrames: async (project, shot, dir, images) => {
            validate(project, shot, dir);
            if (!model.view.canGenerateFrames || model.view.busy || hasPending() || images.length !== 1 || images[0]?.id !== 'K02' || !images[0].path)
              throw new Error('Импорт доступен только для неутверждённой K02.');
            model.view = {
              ...model.view,
              canGenerateFrames: false,
              proposal: workflowProposal('frames', { jobId: '', after: { schemaVersion: 1, stage: 'frames', images } })
            };
            model.publish();
            return snapshot();
          }
        },
        agents: {
          cancel: async (id) => {
            if (!model.view.job || model.view.job.id !== id || model.view.job.status !== 'running') throw new Error('Задание уже завершено.');
            running = false;
            const job = { ...model.view.job, status: 'cancelled' as const };
            model.view = {
              ...model.view,
              busy: false,
              canPrepare: initial().canPrepare,
              canGenerateFrames: initial().canGenerateFrames,
              proposal: workflowProposal(mode === 'frames' ? 'frames' : 'description', {
                id: model.view.proposal?.id,
                jobId: job.id,
                status: 'cancelled',
                message: productionTexts.main.workflow.jobCancelled,
                after: null
              }),
              job
            };
            model.publish();
            return job;
          }
        },
        dialog: { pickFiles: async () => [STORY_IMAGE_PATH] }
      });
      models.set(session.api, model);
      session.onCleanup(registerMediaProviderForTests(TEST_AGENT_PROVIDER, testAgentProviderInfo));
      session.onCleanup(() => {
        disposed = true;
        generation++;
        model.release();
        listeners.clear();
        models.delete(session.api);
      });
      return session;
    }
  };
}

/** Стабильные callbacks показывают занятость и обновление пакета, не перезапуская опрос при каждой отрисовке. */
export function WorkflowPanelStory() {
  const model = models.get(window.api);
  if (!model) throw new Error('Для панели нужна локальная API-сессия.');
  useSyncExternalStore(model.subscribe, model.revision);
  const [epoch, setEpoch] = useState(0);
  const onBusyChange = useCallback(
    (busy: boolean) => {
      if (model.busy === busy) return;
      model.busy = busy;
      model.busySeen ||= busy;
      model.publish();
    },
    [model]
  );
  const onApplied = useCallback(
    async (dir: string | null) => {
      model.callbacks++;
      model.dir = dir ?? undefined;
      model.publish();
    },
    [model]
  );
  const decision: PackageView['decision'] =
    model.mode === 'revision'
      ? {
          stage: model.question === 3 ? 'keyframes_review' : 'description_review',
          verdict: 'revise',
          note: model.question === 1 ? PANEL_SAVED_NOTE : 'Новое замечание для другого вопроса.',
          at: '2026-10-30T09:00:00.000Z'
        }
      : null;
  return (
    <Stack spacing={2}>
      <ProductionWorkflowPanel
        key={epoch}
        project={WORKFLOW_STORY_PROJECT}
        shot={model.shot}
        packageDir={model.dir}
        decisionToken={`question-${model.question}`}
        decision={decision}
        packageBusy={false}
        onBusyChange={onBusyChange}
        onApplied={onApplied}
      />
      <Typography data-testid="workflow-counts">
        Запусков: {model.starts}. Применений: {model.applies}. Отклонений: {model.discards}. Обновлений пакета: {model.callbacks}.
      </Typography>
      <Typography data-testid="workflow-busy">
        Занятость: {model.busy ? 'да' : 'нет'}. Занятость наблюдалась: {model.busySeen ? 'да' : 'нет'}.
      </Typography>
      <Typography data-testid="workflow-saved">
        {model.saved ? `Сохранено: ${model.saved}. Согласование требуется отдельно.` : 'Исходные материалы сохранены.'}
      </Typography>
      {model.mode === 'frames' && (
        <Typography data-testid="workflow-frames">
          {Object.entries(model.images)
            .map(([id, path]) => `${id}: ${model.view.approvedFrameIds.includes(id) ? 'утверждена' : 'кандидат'}; ${path}`)
            .join(' | ')}
        </Typography>
      )}
      {model.note && <Typography data-testid="workflow-note">Отправленное замечание: {model.note}</Typography>}
      {model.lateFinished && <Typography data-testid="workflow-late">Поздний ответ получен.</Typography>}
      <Stack direction="row" useFlexGap flexWrap="wrap" spacing={1}>
        {model.mode === 'ready' && (
          <Button startIcon={<SwapHorizIcon />} onClick={model.breakJob}>
            Повредить результат задания
          </Button>
        )}
        {model.mode === 'late' && (
          <Button startIcon={<SwapHorizIcon />} onClick={model.switchContext}>
            Выбрать M03 и другой пакет
          </Button>
        )}
        {['loading', 'late'].includes(model.mode) && (
          <Button startIcon={<RefreshIcon />} onClick={model.release}>
            Завершить отложенное чтение
          </Button>
        )}
        {model.mode === 'revision' && (
          <Button
            startIcon={<SwapHorizIcon />}
            onClick={() => {
              model.question++;
              model.publish();
            }}
          >
            Показать другой вопрос
          </Button>
        )}
        <Button
          startIcon={<RefreshIcon />}
          onClick={() => {
            model.reset();
            setEpoch((value) => value + 1);
          }}
        >
          Сбросить модель
        </Button>
      </Stack>
    </Stack>
  );
}
