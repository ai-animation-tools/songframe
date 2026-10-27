/** Модели CTranslate2 и простые рекомендации по ресурсам; это ориентиры, а не гарантия качества песни. */
export const WHISPER_MODELS = [
  { id: 'small', repository: 'Systran/faster-whisper-small', size: 'около 0,5 ГБ', description: 'Для небольшого объёма памяти и быстрого черновика.' },
  {
    id: 'medium',
    repository: 'Systran/faster-whisper-medium',
    size: 'около 1,5 ГБ',
    description: 'Разумный вариант для CPU: умеренные скорость и расход памяти.'
  },
  {
    id: 'large-v3-turbo',
    repository: 'dropbox-dash/faster-whisper-large-v3-turbo',
    size: 'около 1,6 ГБ',
    description: 'Быстрее полной large-v3, с компромиссом по точности.'
  },
  {
    id: 'large-v3',
    repository: 'Systran/faster-whisper-large-v3',
    size: 'около 3,1 ГБ',
    description: 'Более крупная модель для приоритета точности; на CPU заметно медленнее.'
  }
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
    return { model: gpuSuggestion, reason: `Доступно ускорение CUDA, видеопамять ${(hardware.vramMiB / 1024).toFixed(1)} ГБ.`, gpuSuggestion };
  const model = hardware.ramGiB >= 8 && hardware.cpuThreads >= 4 ? 'medium' : 'small';
  return {
    model,
    reason: `Обработка на CPU: ${hardware.cpuThreads} потоков, ${hardware.ramGiB.toFixed(1)} ГБ RAM. ${model === 'medium' ? 'Medium подходит для обычной локальной работы.' : 'Small требует меньше ресурсов.'}`,
    gpuSuggestion
  };
}
