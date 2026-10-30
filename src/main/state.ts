/**
 * Локальное состояние: текущий проект (тот же файл, что читают инструменты и скиллы) и история проектов.
 * Файлы лежат в постоянном userData (либо SONGFRAME_LOCAL_DIR), общем с CLI.
 */

import { projectsTexts } from '@shared/texts/projects';
import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readLocalJson, writeLocalJson } from './local-files';
import type { ProjectHistoryEntry } from '@shared/types';

export const CURRENT_FILE = 'current-project.json';
export const HISTORY_FILE = 'projects.json';
const HISTORY_LIMIT = 30;

interface CurrentProjectFile {
  schema_version: 1;
  path: string;
  selected_at: string;
}

interface HistoryFile {
  schema_version: 1;
  projects: { path: string; name: string; last_opened: string }[];
}

export class LocalState {
  constructor(readonly localDir: string) {}

  get currentFile(): string {
    return join(this.localDir, CURRENT_FILE);
  }

  get historyFile(): string {
    return join(this.localDir, HISTORY_FILE);
  }

  readCurrent(): string | null {
    const data = readLocalJson<CurrentProjectFile>(this.currentFile);
    if (data && (data.schema_version !== 1 || typeof data.path !== 'string' || !data.path))
      throw new Error(projectsTexts.main.invalidCurrentFile({ path: this.currentFile }));
    return data?.path ?? null;
  }

  writeCurrent(path: string): void {
    this.readCurrent();
    writeLocalJson(this.currentFile, {
      schema_version: 1,
      path,
      selected_at: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
    } satisfies CurrentProjectFile);
  }

  clearCurrent(): void {
    rmSync(this.currentFile, { force: true });
  }

  readHistory(): ProjectHistoryEntry[] {
    const data = readLocalJson<HistoryFile>(this.historyFile);
    if (data && (data.schema_version !== 1 || !Array.isArray(data.projects) || data.projects.some((entry) => !entry || typeof entry.path !== 'string')))
      throw new Error(projectsTexts.main.invalidHistoryFile({ path: this.historyFile }));
    const projects = data?.projects ?? [];
    return projects
      .filter((p) => typeof p.path === 'string' && p.path)
      .map((p) => ({
        path: p.path,
        name: p.name || basename(p.path),
        lastOpened: p.last_opened || '',
        exists: existsSync(p.path)
      }));
  }

  /** Переносит проект в начало истории; название обновляется, прежняя запись с тем же путём удаляется. */
  touchHistory(path: string, name: string): void {
    const rest = this.readHistory().filter((p) => p.path !== path);
    const projects = [{ path, name, last_opened: new Date().toISOString() }, ...rest.map((p) => ({ path: p.path, name: p.name, last_opened: p.lastOpened }))];
    writeLocalJson(this.historyFile, { schema_version: 1, projects: projects.slice(0, HISTORY_LIMIT) } satisfies HistoryFile);
  }

  /** Переименование не считается повторным открытием: порядок и время истории сохраняются. */
  renameHistory(path: string, name: string): void {
    const history = this.readHistory();
    if (!history.some((entry) => entry.path === path)) return;
    const projects = history.map((entry) => ({
      path: entry.path,
      name: entry.path === path ? name : entry.name,
      last_opened: entry.lastOpened
    }));
    writeLocalJson(this.historyFile, { schema_version: 1, projects } satisfies HistoryFile);
  }

  removeFromHistory(path: string): void {
    const projects = this.readHistory()
      .filter((p) => p.path !== path)
      .map((p) => ({ path: p.path, name: p.name, last_opened: p.lastOpened }));
    writeLocalJson(this.historyFile, { schema_version: 1, projects } satisfies HistoryFile);
  }
}
