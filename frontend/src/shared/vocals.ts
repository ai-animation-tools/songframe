/** Локальные результаты выделения привязаны к исходному аудио; выбор не запускает распознавание. */
export type VocalModelId = 'voc-ft' | 'kim-vocal-1' | 'kim-vocal-2';
export const KNOWN_VOCAL_MODELS: readonly { id: VocalModelId; label: string }[] = [
  { id: 'voc-ft', label: 'Voc FT' },
  { id: 'kim-vocal-1', label: 'Kim Vocal 1' },
  { id: 'kim-vocal-2', label: 'Kim Vocal 2' }
];
/** Новая подготовка использует Voc FT; прежние WAV других моделей остаются доступными для чтения и удаления. */
export const VOCAL_MODELS = KNOWN_VOCAL_MODELS.filter((model) => model.id === 'voc-ft');
export interface VocalModelStatus {
  id: VocalModelId;
  label: string;
  installed: boolean;
  totalBytes: number;
}
export interface VocalResult {
  id: string;
  modelId: VocalModelId;
  modelLabel: string;
  path: string;
  sha256: string;
  createdAt: string;
  duration: number;
}
export interface VocalPreparationView {
  sourcePath: string | null;
  sourceSha256: string | null;
  models: VocalModelStatus[];
  results: VocalResult[];
  selectedId: string | null;
  problems: string[];
}
