/** Рекомендация использует общий PythonLauncher; отсутствие GPU не мешает получить инструкцию. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { whisperSetup } from './whisper-setup';
import { PythonLauncher } from './python-launcher';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-model-setup-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});
it('предлагает large-v3 при готовой CUDA, находит внешние веса и возвращает каталог для команды', async () => {
  const launcher = new PythonLauncher({ toolsRoot: work, platform: 'linux', env: { XDG_DATA_HOME: work } });
  const path = join(work, 'songframe/models/faster-whisper-large-v3');
  mkdirSync(path, { recursive: true });
  for (const name of ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.json']) writeFileSync(join(path, name), 'fixture');
  vi.spyOn(launcher, 'execute').mockResolvedValue({
    code: 0,
    command: '',
    stderr: '',
    stdout: JSON.stringify({ gpuName: 'NVIDIA', vramMiB: 8192, cudaReady: true, device: 'cuda', computeType: 'int8_float16', reason: 'CUDA доступна' })
  });
  const result = await whisperSetup(launcher);
  expect(result.recommended).toBe('large-v3');
  expect(result.installed['large-v3']).toBe(true);
  expect(result.installed.medium).toBe(false);
  expect(result.directories['large-v3']).toBe(path);
  expect(launcher.execute).toHaveBeenCalledWith(expect.arrayContaining(['-c']), { timeoutMs: 15000 });
});
it('при ошибке Python всё равно возвращает рекомендацию для CPU и объяснение', async () => {
  const launcher = new PythonLauncher({ toolsRoot: work, platform: 'linux', env: { XDG_DATA_HOME: work } });
  vi.spyOn(launcher, 'execute').mockRejectedValue(new Error('Нет Python'));
  const result = await whisperSetup(launcher);
  expect(result.hardware.device).toBe('cpu');
  expect(result.hardware.reason).toContain('Нет Python');
  expect(result.recommended).toMatch(/small|medium/);
});
