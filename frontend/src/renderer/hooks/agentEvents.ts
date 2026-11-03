/** Номер события защищает список от старого IPC-снимка и повторной доставки при начальной загрузке. */
import type { AgentEvent, AgentJob } from '@shared/agents';

export function mergeAgentJobs(current: AgentJob[], loaded: AgentJob[]): AgentJob[] {
  const jobs = new Map(current.map((job) => [job.id, job]));
  for (const job of loaded) if (!jobs.has(job.id) || jobs.get(job.id)!.sequence < job.sequence) jobs.set(job.id, job);
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function applyAgentEvent(jobs: AgentJob[], event: AgentEvent): AgentJob[] {
  if (event.job) return mergeAgentJobs(jobs, [event.job]);
  return jobs.map((job) =>
    job.id !== event.jobId || job.sequence >= event.sequence
      ? job
      : {
          ...job,
          sequence: event.sequence,
          phase: event.phase,
          result: event.type === 'text_delta' ? job.result + (event.text ?? '') : job.result
        }
  );
}
