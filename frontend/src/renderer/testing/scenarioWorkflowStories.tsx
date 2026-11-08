/** Витрина проходит настоящий hook сценария, а предложения и документы хранятся только в памяти. */
import { scenarioTexts } from '@shared/texts/scenario';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/material';
import type { Api } from '@shared/api';
import type { AgentJob } from '@shared/agents';
import type { BriefResult, EntityState, ScenesFile } from '@shared/types';
import type { ScenarioDocuments, ScenarioPass, ScenarioProposal, ScenarioWorkflowView } from '@shared/scenario-workflow';
import { ScenarioWorkflowPanel } from '../pages/ScenarioPage/components/ScenarioWorkflowPanel';
import { ScenarioProposalDialog } from '../pages/ScenarioPage/components/ScenarioProposalDialog';
import { useScenarioWorkflow } from '../pages/ScenarioPage/useScenarioWorkflow';
import { createStoryApi, type StoryOptions } from './storybook';
import { storyAccess } from './commonStories';

export const SCENARIO_STORY_PROJECT = '/mock/Сценарий у старых ворот';
export const SCENARIO_APPLY_FAILURE = 'Не удалось записать сценарий. Исходные документы и предложение сохранены; повторите применение.';
export const SCENARIO_APPLY_CONFLICT = 'Изменился plan/treatment.json во время применения. Подготовьте новое предложение.';
export type ScenarioStoryMode =
  'prepare' | 'inputs' | 'ready' | 'stale' | 'applyConflict' | 'applyFailure' | 'readFailure' | 'manual' | 'drafts' | 'scenes' | 'revise';

/** Небольшой цельный клип позволяет читать сравнение и проследить наследование состояния от M01 к M02. */
export function scenarioDocuments(proposed = false): ScenarioDocuments {
  return {
    cast: {
      schema_version: 1,
      properties: { character: [{ key: 'coat', label: 'Куртка' }] },
      entities: [
        {
          id: 'hero',
          kind: 'character',
          name: 'Герой у ворот',
          short_name: 'Герой',
          role: 'Возвращается домой',
          appearance: proposed ? 'Тёмная куртка, короткие волосы; силуэт сохраняется во всех частях.' : 'Тёмная куртка, короткие волосы.',
          images: ['heroes/story-image.png'],
          initial_state: { coat: 'сухая' }
        },
        ...(proposed
          ? [
              {
                id: 'gate',
                kind: 'location',
                name: 'Старые ворота',
                short_name: 'Ворота',
                role: 'Место возвращения',
                appearance: 'Деревянные ворота в тёплом вечернем свете.',
                images: [] as string[],
                initial_state: {}
              }
            ]
          : [])
      ]
    },
    treatment: {
      schema_version: 1,
      logline: proposed ? 'Герой возвращается к старым воротам и замечает свет в знакомом окне.' : 'Герой возвращается к старым воротам.',
      sequences: [
        {
          id: 'intro',
          title: 'Возвращение',
          start: 0,
          end: 8,
          entities: proposed ? ['hero', 'gate'] : ['hero'],
          direction: proposed ? 'Герой останавливается, поднимает взгляд на окно. Камера медленно приближается.' : 'Герой подходит к воротам.',
          lipsync: false,
          max_shot_seconds: 5
        }
      ]
    },
    scenes: {
      schema_version: 1,
      fps: 30,
      audio: { path: 'source/track.wav', end_seconds: '8.000' },
      visual_direction: 'Объёмная 3D-анимация, тёплый вечерний свет слева.',
      references: { hero: { name: 'Герой у ворот', path: 'source/heroes/story-image.png' } },
      sequences: [{ id: 'intro', title: 'Возвращение', direction: 'Герой подходит к воротам.' }],
      scenes: [
        {
          id: 'M01',
          title: 'У ворот',
          original: 'Я снова у ворот',
          sequence: 'intro',
          start_frame: 0,
          end_frame_exclusive: 120,
          camera: proposed ? 'Плавное приближение, средний план.' : 'Общий неподвижный план.',
          action: proposed ? 'Герой останавливается под дождём и смотрит на окно.' : 'Герой подходит к воротам.',
          continuity: 'Свет слева, герой смотрит вправо.',
          references: ['hero'],
          lipsync: false,
          card: { primary_reference: 'hero' },
          state_from: null,
          state_changes: proposed ? { after: { hero: { coat: 'мокрая' } } } : {}
        },
        {
          id: 'M02',
          title: 'Свет в окне',
          original: 'В окне горит огонь',
          sequence: 'intro',
          start_frame: 120,
          end_frame_exclusive: 240,
          camera: 'Крупный план.',
          action: 'Герой поворачивает голову к окну.',
          continuity: 'Положение героя сохраняется.',
          references: ['hero'],
          lipsync: false,
          card: { primary_reference: 'hero' },
          state_from: 'M01',
          state_changes: {}
        }
      ]
    }
  };
}

export function scenarioProposal(pass: ScenarioPass = 'treatment', overrides: Partial<ScenarioProposal> = {}): ScenarioProposal {
  const before = structuredClone(overrides.before ?? scenarioDocuments());
  const proposed = scenarioDocuments(true);
  const after = structuredClone(before);
  // Следующий проход продолжает сохранённые документы, а не восстанавливает исходную фикстуру.
  // Как в main/scenario-workflow.ts, трактовка владеет парой, а сценарий и доработка — только реестром.
  if (pass === 'treatment') {
    after.cast = proposed.cast;
    after.treatment = proposed.treatment;
  } else if (after.scenes) {
    after.scenes.scenes = after.scenes.scenes.map((shot) => {
      if (shot.id !== 'M01') return shot;
      const next = proposed.scenes!.scenes[0];
      return { ...shot, action: next.action, camera: next.camera, state_changes: next.state_changes };
    });
  } else after.scenes = proposed.scenes;
  return {
    id: 'scenario-proposal-1',
    jobId: 'scenario-job-1',
    pass,
    selectedIds: pass === 'revise' ? ['M01'] : [],
    status: 'ready',
    warnings: pass === 'treatment' ? ['Для «Старые ворота» ещё нет изображения. Перед подробным сценарием добавьте референс.'] : [],
    stale: false,
    before,
    after,
    changedIds: pass === 'treatment' ? [] : ['M01'],
    ...overrides
  };
}

export function scenarioJob(status: AgentJob['status'] = 'completed'): AgentJob {
  return {
    schemaVersion: 1,
    id: 'scenario-job-1',
    sequence: 1,
    project: SCENARIO_STORY_PROJECT,
    provider: 'codex',
    task: 'Предложение сценария',
    permissions: 'read-only',
    inputHashes: { prompt: 'story-prompt', context: 'story-context' },
    status,
    phase: 'Подготовка предложения',
    startedAt: '2026-10-30T09:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-10-30T09:01:00.000Z',
    exitCode: status === 'completed' ? 0 : null,
    result: '',
    log: ''
  };
}

interface ScenarioModel {
  view: ScenarioWorkflowView;
  documents: ScenarioDocuments;
  dirty: boolean;
  inputsReady: boolean;
  readsBroken: boolean;
  completeRequested: boolean;
  starts: number;
  applies: number;
  discards: number;
  approvals: number;
  callbacks: number;
  note: string;
  savedDraft: string;
  subscribe(listener: () => void): () => void;
  revision(): number;
  publish(): void;
  reset(): void;
}
const models = new WeakMap<Api, ScenarioModel>();

export function scenarioWorkflowOptions(mode: ScenarioStoryMode = 'prepare'): StoryOptions {
  return {
    app: { online: true, agentProvider: 'codex', aiAccess: storyAccess },
    createApi: () => {
      const listeners = new Set<() => void>();
      let version = 0;
      let failedApply = false;
      const base = (): ScenarioWorkflowView => ({
        project: SCENARIO_STORY_PROJECT,
        busy: false,
        canStartTreatment: true,
        canStartScenes: false,
        canRevise: false,
        canApproveCurrent: true,
        canApproveScenes: false,
        treatmentApproved: false,
        scenesNeedReview: false,
        problems: [],
        proposal: null,
        job: null
      });
      const model: ScenarioModel = {
        view: base(),
        documents: scenarioDocuments(),
        dirty: false,
        inputsReady: true,
        readsBroken: false,
        completeRequested: false,
        starts: 0,
        applies: 0,
        discards: 0,
        approvals: 0,
        callbacks: 0,
        note: '',
        savedDraft: '',
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
          model.view = base();
          model.documents = scenarioDocuments();
          model.dirty = mode === 'drafts';
          model.inputsReady = mode !== 'inputs';
          model.readsBroken = mode === 'readFailure';
          model.completeRequested = false;
          model.starts = 0;
          model.applies = 0;
          model.discards = 0;
          model.approvals = 0;
          model.callbacks = 0;
          model.note = '';
          model.savedDraft = '';
          failedApply = false;
          if (['scenes', 'revise', 'drafts'].includes(mode))
            Object.assign(model.view, { treatmentApproved: true, canApproveCurrent: false, canStartScenes: true, canRevise: true });
          if (mode === 'inputs') {
            model.view.canStartTreatment = false;
            model.view.canApproveCurrent = false;
            model.view.problems = [
              'Нет утверждённой разметки песни.',
              'Для сущности «Ворота» нет изображения.',
              'Разметка должна покрывать весь трек.',
              'Кастинг и трактовка требуют повторной проверки после исправления входов.'
            ];
          }
          if (mode === 'manual') Object.assign(model.view, { canApproveCurrent: true, scenesNeedReview: true });
          if (['ready', 'stale', 'applyConflict', 'applyFailure', 'scenes', 'revise'].includes(mode))
            Object.assign(model.view, {
              proposal: scenarioProposal(mode === 'scenes' ? 'scenes' : mode === 'revise' ? 'revise' : 'treatment', { stale: mode === 'stale' }),
              job: scenarioJob()
            });
          model.publish();
        }
      };
      model.reset();
      const validate = (project: string): void => {
        if (project !== SCENARIO_STORY_PROJECT) throw new Error('Неизвестный демонстрационный проект.');
      };
      const snapshot = () => structuredClone(model.view);
      const capabilities = (): void => {
        Object.assign(model.view, {
          canStartTreatment: !model.view.busy && model.inputsReady,
          canStartScenes: !model.view.busy && model.view.treatmentApproved,
          canRevise: !model.view.busy && model.view.treatmentApproved && !!model.documents.scenes
        });
      };
      const session = createStoryApi({
        scenarioWorkflow: {
          view: async (project) => {
            validate(project);
            if (model.readsBroken) throw new Error('Не удалось прочитать сценарий. Восстановите чтение в модели.');
            if (model.view.busy && model.completeRequested && model.view.proposal) {
              model.view.proposal = {
                ...model.view.proposal,
                status: 'ready',
                after: scenarioProposal(model.view.proposal.pass, { before: model.view.proposal.before }).after,
                message: 'Предложение готово; документы ещё не изменены.'
              };
              model.view.job = scenarioJob();
              model.view.busy = false;
              model.completeRequested = false;
              capabilities();
              model.publish();
            }
            return snapshot();
          },
          start: async ({ project, pass, note, selectedIds }) => {
            validate(project);
            if (
              model.view.busy ||
              !model.inputsReady ||
              !(pass === 'treatment' ? model.view.canStartTreatment : pass === 'scenes' ? model.view.canStartScenes : model.view.canRevise)
            )
              throw new Error('Сначала согласуйте входы сценария.');
            if (pass === 'revise' && (!note?.trim() || selectedIds?.join(',') !== 'M01')) throw new Error('Выберите M01 и заполните замечание.');
            model.starts++;
            model.note = note?.trim() ?? '';
            model.completeRequested = false;
            model.view.proposal = scenarioProposal(pass, {
              id: `scenario-proposal-${model.starts + 1}`,
              status: 'running',
              selectedIds: selectedIds ?? [],
              before: structuredClone(model.documents),
              after: { cast: null, treatment: null, scenes: null },
              warnings: [],
              message: 'Агент готовит предложение.'
            });
            model.view.job = scenarioJob('running');
            model.view.busy = true;
            capabilities();
            model.publish();
            return snapshot();
          },
          apply: async (project, id) => {
            validate(project);
            const proposal = model.view.proposal;
            if (
              model.view.busy ||
              proposal?.id !== id ||
              proposal.status !== 'ready' ||
              proposal.stale ||
              model.view.job?.id !== proposal.jobId ||
              model.view.job.status !== 'completed' ||
              model.view.job.exitCode !== 0
            )
              throw new Error('Предложение больше нельзя применить.');
            model.applies++;
            model.publish();
            if (mode === 'applyConflict' && !failedApply) {
              failedApply = true;
              proposal.stale = true;
              model.publish();
              throw new Error(SCENARIO_APPLY_CONFLICT);
            }
            if (mode === 'applyFailure' && !failedApply) {
              failedApply = true;
              throw new Error(SCENARIO_APPLY_FAILURE);
            }
            model.documents = structuredClone(proposal.after);
            proposal.status = 'applied';
            proposal.message = 'Предложение применено.';
            model.view.treatmentApproved = true;
            model.view.scenesNeedReview = proposal.pass === 'treatment' && !!model.documents.scenes;
            model.view.canApproveScenes = model.view.scenesNeedReview;
            model.view.canApproveCurrent = false;
            capabilities();
            model.publish();
            return snapshot();
          },
          discard: async (project, id) => {
            validate(project);
            if (model.view.busy || model.view.proposal?.id !== id) throw new Error('Предложение уже изменилось.');
            model.discards++;
            model.view.proposal = null;
            model.publish();
            return snapshot();
          },
          approveCurrent: async (project) => {
            validate(project);
            if (!model.view.canApproveCurrent) throw new Error('Трактовка пока не готова к согласованию.');
            model.approvals++;
            model.view.treatmentApproved = true;
            model.view.canApproveCurrent = false;
            model.view.canApproveScenes = model.view.scenesNeedReview;
            capabilities();
            model.publish();
            return snapshot();
          },
          approveScenes: async (project) => {
            validate(project);
            if (!model.view.canApproveScenes) throw new Error('Сценарий пока не готов к согласованию.');
            model.approvals++;
            model.view.canApproveScenes = false;
            model.view.scenesNeedReview = false;
            model.publish();
            return snapshot();
          }
        },
        agents: {
          cancel: async (id) => {
            if (model.view.job?.id !== id || !model.view.busy) throw new Error('Задание уже завершено.');
            model.view.job = scenarioJob('cancelled');
            if (model.view.proposal) Object.assign(model.view.proposal, { status: 'cancelled', message: scenarioTexts.main.proposalCancelled });
            model.view.busy = false;
            model.completeRequested = false;
            capabilities();
            model.publish();
            return structuredClone(model.view.job);
          }
        },
        scenario: {
          brief: async (project, scenes: ScenesFile, shot, phase): Promise<BriefResult> => {
            validate(project);
            // Для двух демонстрационных планов достаточно применить after предыдущего плана; настоящий расчёт остаётся в main.
            const state: EntityState = { hero: { coat: scenes.scenes[0]?.state_changes.after?.hero?.coat ?? 'сухая' } };
            return { shot, phase, state, inherited: structuredClone(state), sources: {}, labels: {}, paragraph: '', checklist: [], text: '' };
          }
        }
      });
      models.set(session.api, model);
      session.onCleanup(() => {
        listeners.clear();
        models.delete(session.api);
      });
      return session;
    }
  };
}

function useModel(): ScenarioModel {
  const model = models.get(window.api);
  if (!model) throw new Error('Для сценария нужна локальная API-сессия.');
  useSyncExternalStore(model.subscribe, model.revision);
  return model;
}

/** Наблюдаемый сохранённый результат: счётчики сами по себе не доказывают запись нужного прохода. */
function SavedScenarioSnapshot({ model }: { model: ScenarioModel }) {
  return (
    <Stack spacing={0.5}>
      <Typography data-testid="scenario-cast">Сохранённые сущности: {model.documents.cast?.entities.map((entity) => entity.id).join(', ')}.</Typography>
      {model.documents.scenes?.scenes.map((shot) => (
        <Typography key={shot.id} data-testid={`scenario-scene-${shot.id}`} sx={{ overflowWrap: 'anywhere' }}>
          {shot.id}: {shot.start_frame}–{shot.end_frame_exclusive}. {shot.camera} {shot.action}
        </Typography>
      ))}
      <Typography data-testid="scenario-review">Сценарий требует пересмотра: {model.view.scenesNeedReview ? 'да' : 'нет'}.</Typography>
    </Stack>
  );
}

function ScenarioPanelContent({ model }: { model: ScenarioModel }) {
  const onApplied = useCallback(
    async (_pass: ScenarioPass) => {
      model.callbacks++;
      model.publish();
    },
    [model]
  );
  const workflow = useScenarioWorkflow(SCENARIO_STORY_PROJECT, onApplied);
  return (
    <ScenarioWorkflowPanel
      project={SCENARIO_STORY_PROJECT}
      workflow={workflow}
      selected="M01"
      treatmentDirty={model.dirty}
      scenesDirty={model.dirty}
      editorBusy={false}
      scenesInputProblem={model.inputsReady ? null : 'Согласуйте разметку и добавьте изображения кастинга.'}
      onResolveDrafts={async (action) => {
        model.savedDraft = action === 'save' ? 'Черновики сохранены' : 'Черновики сброшены';
        model.dirty = false;
        model.publish();
        return true;
      }}
    />
  );
}

export function ScenarioWorkflowStory() {
  const model = useModel();
  const [epoch, setEpoch] = useState(0);
  return (
    <Stack spacing={2}>
      <ScenarioPanelContent key={epoch} model={model} />
      <Typography data-testid="scenario-counts">
        Запусков: {model.starts}. Применений: {model.applies}. Отклонений: {model.discards}. Согласований: {model.approvals}. Обновлений редакторов:{' '}
        {model.callbacks}.
      </Typography>
      <Typography data-testid="scenario-saved">Сохранённый логлайн: {model.documents.treatment?.logline}</Typography>
      <SavedScenarioSnapshot model={model} />
      <Typography data-testid="scenario-drafts">
        {model.savedDraft || (model.dirty ? 'В обоих редакторах есть несохранённые правки.' : 'Черновики не изменены.')}
      </Typography>
      {model.note && <Typography data-testid="scenario-note">Отправленное замечание для M01: {model.note}</Typography>}
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        {model.view.busy && (
          <Button
            onClick={() => {
              model.completeRequested = true;
              model.publish();
            }}
          >
            Завершить демонстрационное задание
          </Button>
        )}
        {!model.inputsReady && (
          <Button
            onClick={() => {
              model.inputsReady = true;
              model.view.problems = [];
              model.view.canStartTreatment = true;
              model.view.canApproveCurrent = true;
              model.publish();
            }}
          >
            Согласовать демонстрационные входы
          </Button>
        )}
        {model.readsBroken && (
          <Button
            onClick={() => {
              model.readsBroken = false;
              model.publish();
            }}
          >
            Восстановить чтение
          </Button>
        )}
        <Button
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

/** Отдельная витрина полного сравнения использует тот же hook и API: закрытие не применяет предложение. */
export function ScenarioComparisonStory() {
  const model = useModel();
  const [open, setOpen] = useState(true);
  const onApplied = useCallback(
    async (_pass: ScenarioPass) => {
      model.callbacks++;
      model.publish();
    },
    [model]
  );
  const workflow = useScenarioWorkflow(SCENARIO_STORY_PROJECT, onApplied);
  return (
    <Stack spacing={2}>
      <Alert severity="info">Изменения существуют только в предложении. Сравните документы, затем примените или отклоните через подтверждение.</Alert>
      <Button onClick={() => setOpen(true)} disabled={!workflow.view?.proposal}>
        Открыть сравнение повторно
      </Button>
      <Typography data-testid="scenario-counts">
        Применений: {model.applies}. Отклонений: {model.discards}. Обновлений редакторов: {model.callbacks}.
      </Typography>
      <Typography data-testid="scenario-saved">Сохранённый логлайн: {model.documents.treatment?.logline}</Typography>
      <SavedScenarioSnapshot model={model} />
      {workflow.view?.proposal && (
        <ScenarioProposalDialog
          project={SCENARIO_STORY_PROJECT}
          proposal={workflow.view.proposal}
          provider="codex"
          open={open}
          busy={workflow.busy}
          error={workflow.error}
          onClose={() => setOpen(false)}
          onApply={() => {
            void workflow.apply().then((ok) => {
              if (ok) setOpen(false);
            });
          }}
          onDiscard={() => {
            void workflow.discard().then((ok) => {
              if (ok) setOpen(false);
            });
          }}
        />
      )}
    </Stack>
  );
}
