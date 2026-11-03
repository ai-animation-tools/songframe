/** Общие типизированные снимки предложений: применение записывает материалы, согласование остаётся отдельным действием. */
import type { AgentJob } from '@shared/agents';
import type { ProductionPass, ProductionProposal, ProductionStageProposal, ProductionWorkflowView } from '@shared/production-workflow';

export const WORKFLOW_STORY_PROJECT = '/mock/Клип у старых ворот';
export const WORKFLOW_STORY_PACKAGE = `${WORKFLOW_STORY_PROJECT}/plan/batches/M02-attempt-01`;
export const WORKFLOW_STORY_DESCRIPTION = 'Герой останавливается у старых ворот. Вечерний свет падает слева; одежда и положение машины сохраняются.';

export function workflowProposal(stage: ProductionPass = 'description', overrides: Partial<ProductionProposal> = {}): ProductionProposal {
  const after: Record<ProductionPass, ProductionStageProposal> = {
    description: {
      schemaVersion: 1,
      stage: 'description',
      description: WORKFLOW_STORY_DESCRIPTION,
      requestSeconds: 8,
      keyframes: [
        { id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Герой перед воротами, машина слева.', referencePaths: ['source/heroes/story-image.png'] },
        { id: 'K02', role: 'last', timeSeconds: 8, prompt: 'Герой поворачивается к освещённому окну.', referencePaths: ['source/heroes/story-image.png'] }
      ]
    },
    frames: {
      schemaVersion: 1,
      stage: 'frames',
      images: ['K01', 'K02'].map((id) => ({ id, path: `${WORKFLOW_STORY_PROJECT}/candidates/${id}/story-image.png` }))
    },
    prompt: { schemaVersion: 1, stage: 'prompt', prompt: 'Камера плавно приближается к герою. Сохранять тёплый свет слева, одежду и положение машины.' },
    request: {
      schemaVersion: 1,
      stage: 'request',
      request: {
        model: 'Демонстрационная модель',
        command: 'image_to_video',
        parameters: { duration: 8, aspect_ratio: '16:9' },
        inputs: [{ flag: 'image', slot: 'first_frame', path: 'frames/K01.png', role: 'first' }],
        outputs: 1
      }
    }
  };
  return {
    id: `proposal-${stage}-1`,
    jobId: `job-${stage}-1`,
    stage,
    status: 'ready',
    stale: false,
    before:
      stage === 'request'
        ? JSON.stringify({ stage: 'prompt_review', keyframes: [{ id: 'K01' }, { id: 'K02' }], prompt: { approved: true } })
        : stage === 'description'
          ? 'Герой стоит перед воротами.'
          : stage === 'prompt'
            ? 'Камера неподвижна, герой перед воротами.'
            : '',
    after: after[stage],
    ...overrides
  };
}

export function workflowView(overrides: Partial<ProductionWorkflowView> = {}): ProductionWorkflowView {
  return {
    project: WORKFLOW_STORY_PROJECT,
    shot: 'M02',
    packageDir: null,
    busy: false,
    stage: null,
    canPrepare: true,
    canContinue: false,
    canRevise: false,
    canGenerateFrames: false,
    paid: false,
    reasons: { prepare: null, continue: 'Сначала примените и согласуйте описание.', frames: 'Сначала примените и согласуйте описание.' },
    derivedFrom: null,
    imageProvider: 'test',
    videoProvider: 'test',
    framePrompts: [],
    nextFrame: null,
    approvedFrameIds: [],
    problems: [],
    proposal: null,
    job: null,
    ...overrides
  };
}

export function workflowAgentJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    schemaVersion: 1,
    id: 'job-description-1',
    sequence: 1,
    project: WORKFLOW_STORY_PROJECT,
    provider: 'codex',
    task: 'Подготовка описания M02',
    permissions: 'read-only',
    inputHashes: { prompt: 'a'.repeat(64), context: 'b'.repeat(64) },
    status: 'running',
    phase: 'Подготовка предложения',
    startedAt: '2026-10-30T09:00:00.000Z',
    finishedAt: null,
    exitCode: null,
    result: '',
    log: '',
    ...overrides
  };
}
