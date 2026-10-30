/** Одна диагностика для окна установки; пути данных вычисляются на компьютере пользователя. */
import { cpus, totalmem } from 'node:os';
import { timingTexts } from '@shared/texts/timing';
import { WHISPER_MODELS, recommendWhisper, type WhisperHardware, type WhisperModelId, type WhisperSetup } from '@shared/whisper-models';
import { missingModelFiles, modelDirectory } from './media-runtime';
import type { PythonLauncher } from './python-launcher';

export async function whisperSetup(launcher: PythonLauncher): Promise<WhisperSetup> {
  const processors = cpus();
  const hardware: WhisperHardware = {
    cpuName: processors[0]?.model ?? 'CPU',
    cpuThreads: processors.length || 1,
    ramGiB: totalmem() / 1024 ** 3,
    gpuName: null,
    vramMiB: 0,
    cudaReady: false,
    device: 'cpu',
    computeType: 'int8',
    reason: timingTexts.main.whisper.cpuDefault
  };
  try {
    const result = await launcher.execute(
      ['-c', 'import json; from tools.transcribe_local.hardware import detect_hardware; print(json.dumps(detect_hardware()))'],
      { timeoutMs: 15000 }
    );
    if (result.code !== 0) throw new Error(result.stderr.trim() || timingTexts.main.whisper.pythonNoResponse);
    Object.assign(hardware, JSON.parse(result.stdout));
  } catch (error) {
    hardware.reason = timingTexts.main.whisper.cudaCheckFailed({ reason: error instanceof Error ? error.message : String(error) });
  }
  const recommended = recommendWhisper(hardware);
  const directories = Object.fromEntries(WHISPER_MODELS.map(({ id }) => [id, modelDirectory(launcher.options, id)])) as Record<WhisperModelId, string>;
  const installed = Object.fromEntries(WHISPER_MODELS.map(({ id }) => [id, missingModelFiles(directories[id]).length === 0])) as Record<
    WhisperModelId,
    boolean
  >;
  return {
    hardware,
    recommended: recommended.model,
    recommendation: recommended.reason,
    gpuSuggestion: recommended.gpuSuggestion,
    platform: launcher.options.platform ?? process.platform,
    directories,
    installed
  };
}
