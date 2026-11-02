/** Модель ASR хранит запрос и ответ отдельно от сохранённого timing.json; никаких настоящих инструментов. */
import type { AgentJob } from '@shared/agents';
import {
  TIMING_AGENT_PROMPT,
  timingAgentContext,
  type TimingAgentApi,
  type TimingAgentReport,
  type TimingAgentSource,
  type TimingAgentView
} from '@shared/timing-agent';
import { timingAgentTexts as texts } from '@shared/texts/timing-agent';
import { createStoryApi, type StoryOptions } from './storybook';
import { storyAccess } from './commonStories';

export type TimingAgentVariant = 'regular' | 'unsupported' | 'invalid' | 'stale' | 'running' | 'fail-start' | 'fail-read' | 'missing-api';
const source: TimingAgentSource = {
  audioSha256: 'timing-regular',
  lyricsSha256: 'lyrics',
  duration: 30,
  lyrics: [
    { number: 2, text: 'У старых ворот начинается утро' },
    { number: 3, text: 'Сосед торопливо заводит мотор' },
    { number: 4, text: 'И снова зовёт нас знакомая дорога' }
  ]
};
export const TIMING_ASR_START_ERROR = 'Не удалось запустить агентное распознавание. Проверьте выбранного агента и повторите.';
interface Inspection {
  starts: number;
  cancels: number;
  proposals: number;
}
let inspect: (() => Inspection) | null = null;
export function timingAgentInspection(): Inspection {
  if (!inspect) throw new Error('Модель ASR не открыта.');
  return inspect();
}
export function createTimingAgentModel(variant: TimingAgentVariant = 'regular') {
  const calls: Inspection = { starts: 0, cancels: 0, proposals: 0 };
  let remaining = 0;
  let job: AgentJob | null = null;
  const report: TimingAgentReport = {
    schemaVersion: 1,
    status: 'completed',
    audioSha256: source.audioSha256,
    lyricsSha256: source.lyricsSha256,
    engine: 'Демонстрационный ASR · model-test',
    summary: 'Вокал найден по аудио; первая строка начинается с 12 секунды.',
    segments: [
      { start: 12, end: 16, text: source.lyrics[0].text },
      { start: 17, end: 19, text: source.lyrics[1].text },
      { start: 20, end: 23, text: source.lyrics[2].text }
    ],
    matches: [2, 3, 4].map((sourceLine, index) => ({
      sourceLine,
      start: [12, 17, 20][index],
      end: [16, 19, 23][index],
      segmentIndexes: [index],
      note: 'Проверьте границы на слух'
    })),
    unmatchedSourceLines: [],
    limitations: ['Результат требует проверки человеком.']
  };
  let value: TimingAgentView = {
    status: 'idle',
    source,
    prompt: TIMING_AGENT_PROMPT,
    context: timingAgentContext(source),
    job,
    report: null,
    stale: false,
    error: null
  };
  const start = (): TimingAgentView => {
    calls.starts++;
    remaining = 2;
    if (variant === 'fail-start' && calls.starts === 1) throw new Error(TIMING_ASR_START_ERROR);
    job = {
      schemaVersion: 1,
      id: `asr-${calls.starts}`,
      sequence: 1,
      project: '/mock/timing-project',
      task: texts.task,
      provider: 'codex',
      permissions: 'workspace-write',
      inputHashes: { prompt: 'p', context: 'c' },
      status: 'running',
      phase: 'Чтение MP3 инструментом ASR',
      startedAt: '2026-11-02T00:00:00Z',
      finishedAt: null,
      exitCode: null,
      result: '',
      log: ''
    };
    value = { ...value, status: 'running', job, report: null, stale: false, error: null };
    return structuredClone(value);
  };
  if (variant === 'running') start();
  const snapshot = (): Inspection => structuredClone(calls);
  inspect = snapshot;
  let firstRead = true;
  const api: TimingAgentApi = {
    view: async () => {
      if (variant === 'fail-read' && firstRead) {
        firstRead = false;
        throw new Error('Не удалось прочитать запрос. Повторите чтение.');
      }
      if (value.status === 'running' && variant !== 'running' && --remaining <= 0) {
        const unsupported = variant === 'unsupported';
        value = {
          ...value,
          status: variant === 'invalid' ? 'failed' : unsupported ? 'unsupported' : 'completed',
          job: { ...job!, status: 'completed' },
          stale: variant === 'stale',
          error: variant === 'invalid' ? texts.invalidReport : null,
          report:
            variant === 'invalid'
              ? null
              : unsupported
                ? { ...report, status: 'unsupported', engine: null, summary: texts.unsupported, matches: [], segments: [], unmatchedSourceLines: [2, 3, 4] }
                : report
        };
      }
      return structuredClone(value);
    },
    start: async () => start(),
    cancel: async () => {
      calls.cancels++;
      value = { ...value, status: 'cancelled', job: { ...job!, status: 'cancelled' }, report: null };
      return structuredClone(value);
    },
    proposal: async (_project, jobId) => {
      calls.proposals++;
      if (value.stale || value.job?.id !== jobId || value.status !== 'completed') throw new Error(texts.noProposal);
      return structuredClone(report);
    }
  };
  return {
    api,
    cleanup: () => {
      if (inspect === snapshot) inspect = null;
    }
  };
}
export function timingAgentOptions(variant: TimingAgentVariant = 'regular'): StoryOptions {
  return {
    app: { agentProvider: 'codex', aiAccess: storyAccess },
    createApi: () => {
      const model = createTimingAgentModel(variant);
      const session = createStoryApi({ timingAgent: model.api });
      if (variant === 'missing-api') Reflect.deleteProperty(session.api, 'timingAgent');
      session.onCleanup(model.cleanup);
      return session;
    }
  };
}
