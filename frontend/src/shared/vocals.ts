/** Локальные результаты выделения привязаны к исходному аудио; выбор не запускает разметку. */
export type VocalModelId = 'voc-ft';
/** Модель выделения вокала — Voc FT; сохранённые результаты других моделей не читаются. */
export const VOCAL_MODELS: readonly { id: VocalModelId; label: string }[] = [{ id: 'voc-ft', label: 'Voc FT' }];
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
