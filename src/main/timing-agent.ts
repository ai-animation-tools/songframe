/** Предложения ASR живут вне проекта; агент получает отдельную копию MP3, применение принадлежит редактору. */
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentManager } from './agent-manager';
import type { TimingAgentReport, TimingAgentSource, TimingAgentView } from '@shared/timing-agent';
import { TIMING_AGENT_PROMPT, timingAgentContext } from '@shared/timing-agent';
import { timingAgentTexts as texts } from '@shared/texts/timing-agent';
import { viewTiming } from './timing';

const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown, max = 2000): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;

/** Строгий ответ связывает сопоставление с реальными ASR-сегментами и снимком аудио/песни. */
export function parseTimingAgentReport(value: unknown, source: TimingAgentSource): TimingAgentReport {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 1024 * 1024) throw new Error(texts.invalidReport);
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(texts.invalidReport);
    }
  }
  if (
    !record(value) ||
    !exact(value, [
      'schemaVersion',
      'status',
      'audioSha256',
      'lyricsSha256',
      'engine',
      'summary',
      'segments',
      'matches',
      'unmatchedSourceLines',
      'limitations'
    ]) ||
    value.schemaVersion !== 1 ||
    !['completed', 'unsupported'].includes(String(value.status)) ||
    value.audioSha256 !== source.audioSha256 ||
    value.lyricsSha256 !== source.lyricsSha256 ||
    !text(value.summary) ||
    !Array.isArray(value.segments) ||
    value.segments.length > 10000 ||
    !Array.isArray(value.matches) ||
    value.matches.length > source.lyrics.length ||
    !Array.isArray(value.unmatchedSourceLines) ||
    !Array.isArray(value.limitations) ||
    value.limitations.length > 30 ||
    !value.limitations.every((item) => text(item))
  )
    throw new Error(texts.invalidReport);
  const range = (item: Record<string, unknown>): boolean =>
    typeof item.start === 'number' &&
    typeof item.end === 'number' &&
    Number.isFinite(item.start) &&
    Number.isFinite(item.end) &&
    item.start >= 0 &&
    item.end > item.start &&
    item.end <= source.duration + 0.001;
  const segments: TimingAgentReport['segments'] = value.segments.map((item: unknown) => {
    if (!record(item) || !exact(item, ['start', 'end', 'text']) || !range(item) || !text(item.text, 6000)) throw new Error(texts.invalidReport);
    return { start: item.start as number, end: item.end as number, text: item.text };
  });
  const valid = new Set(source.lyrics.map((line) => line.number));
  const seen = new Set<number>();
  const matches: TimingAgentReport['matches'] = value.matches.map((item: unknown) => {
    if (
      !record(item) ||
      !exact(item, ['sourceLine', 'start', 'end', 'segmentIndexes', 'note']) ||
      typeof item.sourceLine !== 'number' ||
      !valid.has(item.sourceLine) ||
      seen.has(item.sourceLine) ||
      !range(item) ||
      !Array.isArray(item.segmentIndexes) ||
      !item.segmentIndexes.length ||
      item.segmentIndexes.length > 100 ||
      new Set(item.segmentIndexes).size !== item.segmentIndexes.length ||
      !item.segmentIndexes.every((index) => Number.isInteger(index) && index >= 0 && index < segments.length) ||
      typeof item.note !== 'string' ||
      item.note.length > 2000
    )
      throw new Error(texts.invalidReport);
    const evidence = (item.segmentIndexes as number[]).map((index) => segments[index]);
    if (
      (item.start as number) < Math.min(...evidence.map((segment) => segment.start)) - 0.05 ||
      (item.end as number) > Math.max(...evidence.map((segment) => segment.end)) + 0.05
    )
      throw new Error(texts.invalidReport);
    seen.add(item.sourceLine);
    return {
      sourceLine: item.sourceLine,
      start: item.start as number,
      end: item.end as number,
      segmentIndexes: item.segmentIndexes as number[],
      note: item.note
    };
  });
  for (const number of value.unmatchedSourceLines) {
    if (typeof number !== 'number' || !valid.has(number) || seen.has(number)) throw new Error(texts.invalidReport);
    seen.add(number);
  }
  if (
    seen.size !== valid.size ||
    (value.status === 'unsupported' ? value.engine !== null || segments.length || matches.length : !text(value.engine, 400) || !segments.length)
  )
    throw new Error(texts.invalidReport);
  return {
    schemaVersion: 1,
    status: value.status as TimingAgentReport['status'],
    audioSha256: source.audioSha256,
    lyricsSha256: source.lyricsSha256,
    engine: value.engine as string | null,
    summary: value.summary,
    segments,
    matches,
    unmatchedSourceLines: value.unmatchedSourceLines as number[],
    limitations: value.limitations as string[]
  };
}

interface Options {
  localDir: string;
  agents: Pick<AgentManager, 'startAudio' | 'get' | 'cancel'>;
}
interface Session {
  source: TimingAgentSource;
  jobId: string;
  directory: string;
}
export class TimingAgent {
  private sessions = new Map<string, Session>();
  constructor(private readonly options: Options) {}
  private source(project: string): TimingAgentSource {
    const view = viewTiming(project);
    const lyrics = view.lyrics.filter((line) => !line.header && line.text.trim()).map(({ number, text }) => ({ number, text }));
    if (!view.trackPath || !view.duration || !Number.isFinite(view.duration) || view.duration <= 0 || !lyrics.length) throw new Error(texts.sourceRequired);
    const audioSha256 = hash(readFileSync(view.trackPath));
    if (view.trackSha256 && view.trackSha256 !== audioSha256) throw new Error(texts.trackChanged);
    const result = { audioSha256, lyricsSha256: hash(readFileSync(join(project, 'source/text.md'))), duration: view.duration, lyrics };
    if (Buffer.byteLength(timingAgentContext(result)) > 256 * 1024) throw new Error(texts.requestTooLarge);
    return result;
  }
  view(project: string): TimingAgentView {
    const root = realpathSync(project);
    const stored = this.sessions.get(root);
    let source: TimingAgentSource;
    let stale = false,
      error: string | null = null;
    try {
      source = this.source(root);
    } catch (failure) {
      if (!stored) throw failure;
      source = stored.source;
      stale = true;
      error = failure instanceof Error ? failure.message : texts.stale;
    }
    if (
      stored &&
      (source.audioSha256 !== stored.source.audioSha256 || source.lyricsSha256 !== stored.source.lyricsSha256 || source.duration !== stored.source.duration)
    )
      stale = true;
    const job = stored ? this.options.agents.get(stored.jobId) : null;
    let status: TimingAgentView['status'] = 'idle';
    let report: TimingAgentReport | null = null;
    if (job?.status === 'running') status = 'running';
    else if (job?.status === 'cancelled') status = 'cancelled';
    else if (job?.status === 'completed') {
      try {
        report = parseTimingAgentReport(job.result, stored!.source);
        status = report.status;
      } catch {
        status = 'failed';
        error = texts.invalidReport;
      }
    } else if (job) {
      status = 'failed';
      error = job.message || texts.failure;
    }
    return {
      status,
      source: stored?.source ?? source,
      prompt: TIMING_AGENT_PROMPT,
      context: timingAgentContext(stored?.source ?? source),
      job,
      report,
      stale,
      error: error ?? (stale ? texts.stale : null)
    };
  }
  start(project: string): TimingAgentView {
    const root = realpathSync(project);
    if (this.view(root).status === 'running') throw new Error(texts.busy);
    const source = this.source(root);
    const directory = join(this.options.localDir, 'audio-jobs', randomUUID());
    mkdirSync(directory, { recursive: true });
    try {
      copyFileSync(join(root, 'source/track.mp3'), join(directory, 'track.mp3'));
      if (hash(readFileSync(join(directory, 'track.mp3'))) !== source.audioSha256) throw new Error(texts.trackChanged);
      const job = this.options.agents.startAudio(
        { project: root, task: texts.task, prompt: TIMING_AGENT_PROMPT, context: timingAgentContext(source) },
        directory
      );
      this.sessions.set(root, { source, jobId: job.id, directory });
      return this.view(root);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async cancel(project: string): Promise<TimingAgentView> {
    const root = realpathSync(project),
      session = this.sessions.get(root);
    if (session && this.options.agents.get(session.jobId)?.status === 'running') await this.options.agents.cancel(session.jobId);
    return this.view(root);
  }
  proposal(project: string, jobId: string): TimingAgentReport {
    const value = this.view(project);
    if (value.stale || value.status !== 'completed' || value.job?.id !== jobId || !value.report) throw new Error(value.stale ? texts.stale : texts.noProposal);
    return structuredClone(value.report);
  }
}
