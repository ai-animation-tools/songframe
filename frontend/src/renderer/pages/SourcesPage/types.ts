/** Локальное состояние редактирования исходников до сохранения проекта. */
import type { ReferenceKind, ReferenceView } from '@shared/types';

export interface FileForm {
  key: number;
  sourcePath?: string;
  existingPath?: string;
  view: ReferenceView;
  note: string;
  prompt: string;
  promptError?: { path: string; message: string };
}

export interface ReferenceForm {
  key: number;
  id: string;
  kind: ReferenceKind;
  name: string;
  short_name: string;
  description: string;
  prompt: string;
  promptError?: { path: string; message: string };
  files: FileForm[];
}

export interface KindForm {
  label: string;
  id: string;
  dir: string;
}
