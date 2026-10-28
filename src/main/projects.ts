/** Создание проекта из шаблона, открытие существующего, история и текущий проект. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AppState, CreateProjectInput, ProjectStatus } from '@shared/types';
import type { LocalState } from './state';
import { computeStatus, readProjectMarker } from './status';
import { readLocalJson, writeLocalJson } from './local-files';
import { copyTemplate } from './template';

export const TEMPLATE_DIR = join('templates', 'project');

/** Имя MP4 аниматика из названия: латиница, цифры и дефисы; для кириллических названий остаётся animatic.mp4. */
export function defaultAnimaticName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug ? `${slug}-animatic` : 'animatic') + '.mp4';
}

export function validateNewProject(input: CreateProjectInput): string[] {
  const problems: string[] = [];
  if (!input.name.trim()) problems.push('Укажите название проекта.');
  if (!input.path.trim()) problems.push('Укажите полный путь к папке проекта.');
  else if (!isAbsolute(input.path)) problems.push('Путь должен быть абсолютным.');
  else {
    const target = resolve(input.path);
    if (existsSync(target)) problems.push('Папка уже существует: выберите новый путь или откройте её как существующий проект.');
    const parent = dirname(target);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) problems.push(`Родительская папка не существует: ${parent}`);
  }
  const video = input.animaticVideo?.trim();
  if (video && !/^[A-Za-z0-9._-]+\.mp4$/.test(video)) problems.push('Имя MP4: латиница, цифры, точка, дефис, подчёркивание и расширение .mp4.');
  return problems;
}

export class Projects {
  private readonly problems: string[];
  constructor(
    private readonly state: LocalState,
    private readonly toolsRoot: string | null,
    private readonly platform: NodeJS.Platform,
    private readonly environment: { packaged?: boolean; problems?: string[] } = {}
  ) {
    this.problems = [...(environment.problems ?? [])];
  }

  appState(): AppState {
    const current = this.state.readCurrent();
    return {
      toolsRoot: this.toolsRoot,
      localDir: this.state.localDir,
      current: current && existsSync(current) ? current : null,
      history: this.state.readHistory(),
      platform: this.platform,
      packaged: this.environment.packaged ?? false,
      problems: this.problems
    };
  }

  status(path: string): ProjectStatus {
    return computeStatus(path);
  }

  /** Делает папку текущим проектом; папка должна быть проектом (plan/project.json). */
  open(path: string): ProjectStatus {
    const target = resolve(path);
    const marker = existsSync(target) ? readProjectMarker(target) : null;
    if (!marker) throw new Error(`В папке нет plan/project.json с названием проекта: ${target}`);
    this.state.readHistory();
    this.state.writeCurrent(target);
    this.state.touchHistory(target, marker.name);
    return this.status(target);
  }

  close(): void {
    this.state.clearCurrent();
  }

  /** Меняется только название: переименование не зависит от generation и не переносит папку или MP4. */
  rename(path: string, name: string): ProjectStatus {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Название проекта не может быть пустым.');
    if (/[\0\r\n]/.test(name)) throw new Error('Название проекта содержит недопустимый символ.');
    const target = resolve(path);
    const file = join(target, 'plan/project.json');
    const data = readLocalJson<Record<string, unknown>>(file);
    if (!data || Array.isArray(data) || !readProjectMarker(target)) throw new Error('В папке нет корректного plan/project.json с названием проекта.');
    this.state.readHistory();
    const next = name.trim();
    writeLocalJson(file, { ...data, name: next });
    this.state.renameHistory(target, next);
    return this.status(target);
  }

  forget(path: string): void {
    this.state.removeFromHistory(path);
    if (this.state.readCurrent() === path) this.state.clearCurrent();
  }

  create(input: CreateProjectInput): ProjectStatus {
    const problems = validateNewProject(input);
    if (problems.length) throw new Error(problems.join(' '));
    if (!this.toolsRoot) throw new Error('Корень комплекса не найден: шаблон проекта недоступен. Укажите его на странице «Среда».');
    const target = resolve(input.path);
    const name = input.name.trim();
    const values = { project_name: name, animatic_video: input.animaticVideo?.trim() || defaultAnimaticName(name) };
    mkdirSync(target, { recursive: true });
    copyTemplate(join(this.toolsRoot, TEMPLATE_DIR), target, values);
    const git = spawnSync('git', ['init', '-q', target], { encoding: 'utf-8' });
    // Отсутствие необязательного Git не мешает созданию обычного локального проекта.
    if (git.status !== 0 && (git.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      writeFileSync(join(target, 'GIT-INIT-FAILED.txt'), `git init не удался: ${git.stderr || git.error?.message || 'неизвестная ошибка'}\n`);
    }
    return this.open(target);
  }
}
