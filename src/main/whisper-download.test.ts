/** Фоновая загрузка переиспользует Jobs: повторный клик не создаёт вторую операцию, ошибка допускает повтор. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '@shared/types';
import { PythonLauncher } from './python-launcher';
import { Jobs } from './jobs';
import { startWhisperDownload } from './whisper-download';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-model-download-job-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

function harness() {
  const launcher = new PythonLauncher({ toolsRoot: work, localDir: join(work, 'local'), platform: 'linux', env: { XDG_DATA_HOME: work } });
  vi.spyOn(launcher, 'runtime').mockReturnValue({ source: 'system-dev', command: process.execPath, argsPrefix: [], cwd: work, env: {}, version: 'test' });
  const pending: ((value: ToolResult) => void)[] = [];
  const run = vi.spyOn(launcher, 'run').mockImplementation((_project, _tool, _args, options) => {
    options?.onOutput?.('Загружено 1 МБ\n', true);
    return new Promise<ToolResult>((resolve) => pending.push(resolve));
  });
  return { jobs: new Jobs(work, join(work, 'local'), launcher), run, pending };
}
const result = (code: number): ToolResult => ({ code, stdout: '', stderr: '', command: 'test' });

describe('Фоновая загрузка модели', () => {
  it('запускает глобальный загрузчик на общем launcher и сохраняет журнал, путь и завершение', async () => {
    const { jobs, run, pending } = harness();
    const job = startWhisperDownload(jobs, 'medium');
    expect(job.status).toBe('running');
    const directory = join(work, 'songframe/models/faster-whisper-medium');
    expect(job.modelDownload).toEqual({ model: 'medium', directory });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledWith(
      null,
      'download_whisper_model',
      ['--repository', 'Systran/faster-whisper-medium', '--output', directory],
      expect.any(Object)
    );
    expect(job.log).toContain('Загружено 1 МБ');
    pending[0](result(0));
    await vi.waitFor(() => expect(job.status).toBe('done'));
    expect(jobs.get(job.id)?.modelDownload).toEqual(job.modelDownload);
    expect(readFileSync(join(work, 'local/jobs', `${job.id}.log`), 'utf8')).toContain('Загружено 1 МБ');
  });

  it('повторный запуск той же модели возвращает выполняющееся задание', async () => {
    const { jobs, run, pending } = harness();
    const first = startWhisperDownload(jobs, 'small');
    expect(startWhisperDownload(jobs, 'small')).toBe(first);
    expect(jobs.list()).toHaveLength(1);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    pending[0](result(0));
    await vi.waitFor(() => expect(first.status).toBe('done'));
  });

  it('после ошибки позволяет повтор без удаления частично скачанных файлов', async () => {
    const { jobs, run, pending } = harness();
    const first = startWhisperDownload(jobs, 'small');
    const directory = first.modelDownload!.directory;
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'model.bin.incomplete'), 'Скачанная часть');
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    pending[0](result(1));
    await vi.waitFor(() => expect(first.status).toBe('failed'));
    const second = startWhisperDownload(jobs, 'small');
    expect(second.id).not.toBe(first.id);
    expect(second.modelDownload?.directory).toBe(directory);
    expect(readFileSync(join(directory, 'model.bin.incomplete'), 'utf8')).toBe('Скачанная часть');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    pending[1](result(0));
    await vi.waitFor(() => expect(second.status).toBe('done'));
  });

  it('не создаёт задание для неизвестной модели', () => {
    const { jobs, run } = harness();
    expect(() => startWhisperDownload(jobs, '../unknown')).toThrow('поддерживаемую модель');
    expect(jobs.list()).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });
});
