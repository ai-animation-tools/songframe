/** Рекомендации остаются приблизительными и не обещают CUDA при одних лишь ресурсах NVIDIA. */
import { describe, expect, it } from 'vitest';
import { recommendWhisper, type WhisperHardware } from './whisper-models';

const cpu: WhisperHardware = {
  cpuName: 'CPU',
  cpuThreads: 8,
  ramGiB: 16,
  gpuName: null,
  vramMiB: 0,
  cudaReady: false,
  device: 'cpu',
  computeType: 'int8',
  reason: ''
};
describe('Выбор модели faster-whisper', () => {
  it('предлагает medium для CPU и small при недостатке ресурсов', () => {
    expect(recommendWhisper(cpu).model).toBe('medium');
    expect(recommendWhisper({ ...cpu, ramGiB: 4 }).model).toBe('small');
    expect(recommendWhisper({ ...cpu, cpuThreads: 2 }).model).toBe('small');
  });
  it.each([
    [2048, 'small'],
    [4096, 'large-v3-turbo'],
    [8192, 'large-v3']
  ] as const)('учитывает видеопамять %s МиБ при готовой CUDA', (vramMiB, expected) => {
    expect(recommendWhisper({ ...cpu, cudaReady: true, vramMiB, device: 'cuda' }).model).toBe(expected);
  });
  it('объясняет потенциал мощной NVIDIA, но оставляет CPU без готовой CUDA', () => {
    expect(recommendWhisper({ ...cpu, gpuName: 'NVIDIA', vramMiB: 12288 })).toMatchObject({ model: 'medium', gpuSuggestion: 'large-v3' });
    expect(recommendWhisper({ ...cpu, vramMiB: 1024 }).gpuSuggestion).toBeNull();
  });
});
