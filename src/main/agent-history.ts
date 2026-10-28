/** История агента хранится отдельно от Python Jobs, без промптов и сырых событий провайдера. */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentJob } from '@shared/agents';
import { isAgentProvider } from '@shared/agent-providers';
import { readLocalJson, writeLocalJson } from './local-files';

export class AgentHistory {
  private readonly directory: string;
  constructor(localDir: string) {
    this.directory = join(localDir, 'jobs');
  }

  read(): AgentJob[] {
    if (!existsSync(this.directory)) return [];
    const jobs: AgentJob[] = [];
    for (const name of readdirSync(this.directory)) {
      if (!/^agent-[\da-f-]{36}\.json$/.test(name)) continue;
      const file = join(this.directory, name);
      try {
        if (statSync(file).size > 1024 * 1024) throw new Error('размер');
        const job = readLocalJson<AgentJob>(file);
        if (
          !job ||
          job.schemaVersion !== 1 ||
          name !== `agent-${job.id}.json` ||
          !isAgentProvider(job.provider) ||
          !['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(job.status) ||
          !Number.isSafeInteger(job.sequence) ||
          job.sequence < 0 ||
          typeof job.project !== 'string' ||
          typeof job.task !== 'string' ||
          typeof job.phase !== 'string' ||
          typeof job.result !== 'string' ||
          typeof job.log !== 'string' ||
          typeof job.startedAt !== 'string' ||
          !(job.finishedAt === null || typeof job.finishedAt === 'string') ||
          !(job.exitCode === null || Number.isInteger(job.exitCode)) ||
          (job.permissions !== 'read-only' && job.permissions !== 'workspace-write') ||
          !/^[a-f0-9]{64}$/.test(job.inputHashes?.prompt ?? '') ||
          !/^[a-f0-9]{64}$/.test(job.inputHashes?.context ?? '')
        )
          throw new Error('формат');
        jobs.push(job);
      } catch {
        // Повреждённая запись сохраняется для разбора и не блокирует остальные проекты/задания.
        console.warn(`Не удалось прочитать запись агента ${file}. Файл сохранён.`);
      }
    }
    return jobs;
  }

  write(job: AgentJob): void {
    writeLocalJson(join(this.directory, `agent-${job.id}.json`), job);
  }
}
