import { timingTexts } from './texts/timing';
/** Модели CTranslate2 и простые рекомендации по ресурсам; это ориентиры, а не гарантия качества песни. */
export const WHISPER_MODELS = [
  { id: 'small', repository: 'Systran/faster-whisper-small', ...timingTexts.whisperModels.small },
  { id: 'medium', repository: 'Systran/faster-whisper-medium', ...timingTexts.whisperModels.medium },
  { id: 'large-v3-turbo', repository: 'dropbox-dash/faster-whisper-large-v3-turbo', ...timingTexts.whisperModels.turbo },
  { id: 'large-v3', repository: 'Systran/faster-whisper-large-v3', ...timingTexts.whisperModels.large }
] as const;
export type WhisperModelId = (typeof WHISPER_MODELS)[number]['id'];
export interface WhisperHardware {
  cpuName: string;
  cpuThreads: number;
  ramGiB: number;
  gpuName: string | null;
  vramMiB: number;
  cudaReady: boolean;
  device: 'cpu' | 'cuda';
  computeType: string;
  reason: string;
}
export interface WhisperSetup {
  hardware: WhisperHardware;
  recommended: WhisperModelId;
  recommendation: string;
  gpuSuggestion: WhisperModelId | null;
  platform: string;
  directories: Record<WhisperModelId, string>;
  installed: Record<WhisperModelId, boolean>;
}
export function recommendWhisper(hardware: WhisperHardware): { model: WhisperModelId; reason: string; gpuSuggestion: WhisperModelId | null } {
  const gpuSuggestion: WhisperModelId | null =
    hardware.vramMiB >= 8192 ? 'large-v3' : hardware.vramMiB >= 4096 ? 'large-v3-turbo' : hardware.vramMiB >= 2048 ? 'small' : null;
  if (hardware.cudaReady && gpuSuggestion)
    return { model: gpuSuggestion, reason: timingTexts.cudaRecommendation({ vramGiB: (hardware.vramMiB / 1024).toFixed(1) }), gpuSuggestion };
  const model = hardware.ramGiB >= 8 && hardware.cpuThreads >= 4 ? 'medium' : 'small';
  return {
    model,
    reason: timingTexts.cpuRecommendation({ threads: hardware.cpuThreads, ramGiB: hardware.ramGiB.toFixed(1), model }),
    gpuSuggestion
  };
}
