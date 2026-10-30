/** Откат целой папки и документов повторяется без Python и не трогает неизвестные данные. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverDerivedApplications } from './derived-recovery';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const id = 'a'.repeat(32);
let project: string;
const history = `plan/derived-history/${id}`;
const target = 'assets/shots/M01';
const retired = `assets/replaced/M01/${id}`;
function write(path: string, text: string): void {
  mkdirSync(dirname(join(project, path)), { recursive: true });
  writeFileSync(join(project, path), text);
}
function journal(first = false) {
  const value = {
    schema_version: 1,
    id,
    shot: 'M01',
    state: 'publishing',
    files: [{ path: 'plan/production-status.json', before: first ? null : hash('Прежний статус'), after: hash('Новый статус') }],
    directory: {
      path: target,
      backup: `${history}/before-kit`,
      retired,
      before_files: first ? null : { 'video.mp4': hash('Прежнее видео'), 'manifest.json': hash('Прежний манифест') },
      after_files: { 'video.mp4': hash('Новое видео'), 'manifest.json': hash('Новый манифест') }
    }
  };
  write(`${history}/journal.json`, JSON.stringify(value));
  return value;
}
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-derived-recovery-'));
  write(`${target}/video.mp4`, 'Новое видео');
  write(`${target}/manifest.json`, 'Новый манифест');
  write(`${history}/before-kit/video.mp4`, 'Прежнее видео');
  write(`${history}/before-kit/manifest.json`, 'Прежний манифест');
  cpSync(join(project, history, 'before-kit'), join(project, retired), { recursive: true });
  write(`${history}/before/plan/production-status.json`, 'Прежний статус');
  write('plan/production-status.json', 'Новый статус');
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe('восстановление производной приёмки', () => {
  it('возвращает прежний комплект и статус после публикации и допускает повторный запуск', () => {
    journal();
    recoverDerivedApplications(project);
    recoverDerivedApplications(project);
    expect(readFileSync(join(project, target, 'video.mp4'), 'utf8')).toBe('Прежнее видео');
    expect(readFileSync(join(project, 'plan/production-status.json'), 'utf8')).toBe('Прежний статус');
    expect(existsSync(join(project, retired))).toBe(false);
    expect(JSON.parse(readFileSync(join(project, history, 'journal.json'), 'utf8')).state).toBe('rolled_back');
  });
  it('восстанавливает после переноса старой папки, когда новая ещё не появилась', () => {
    journal();
    rmSync(join(project, target), { recursive: true });
    recoverDerivedApplications(project);
    expect(readFileSync(join(project, target, 'manifest.json'), 'utf8')).toBe('Прежний манифест');
  });
  it('откатывает первую приёмку к отсутствующему комплекту и отсутствующему статусу', () => {
    journal(true);
    rmSync(join(project, retired), { recursive: true });
    recoverDerivedApplications(project);
    expect(existsSync(join(project, target))).toBe(false);
    expect(existsSync(join(project, 'plan/production-status.json'))).toBe(false);
  });
  it.each(['asset', 'backup', 'status'])('при изменённом %s отказывает до первой записи', (kind) => {
    journal();
    if (kind === 'asset') write(`${target}/video.mp4`, 'Чужая новая версия');
    if (kind === 'backup') write(`${history}/before-kit/video.mp4`, 'Порча резерва');
    if (kind === 'status') write('plan/production-status.json', 'Чужой статус');
    const before = readFileSync(join(project, 'plan/production-status.json'));
    expect(() => recoverDerivedApplications(project)).toThrow('Не удалось восстановить');
    expect(readFileSync(join(project, 'plan/production-status.json'))).toEqual(before);
    expect(existsSync(join(project, retired))).toBe(true);
  });
  it('отвергает посторонний путь в журнале, сохраняя исходники', () => {
    const value = journal();
    value.files[0].path = 'source/track.mp3';
    write('source/track.mp3', 'Песня');
    write(`${history}/journal.json`, JSON.stringify(value));
    expect(() => recoverDerivedApplications(project)).toThrow();
    expect(readFileSync(join(project, 'source/track.mp3'), 'utf8')).toBe('Песня');
  });
});
