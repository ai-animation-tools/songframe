/** Проверяет восстановление частично опубликованного монтажа без медиаинструментов. */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAtomicText, writeLocalJson } from './local-files';
import { recoverMontageApplications } from './montage-recovery';

const directories: string[] = [];
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
function fixture(): { project: string; history: string } {
  const project = mkdtempSync(join(tmpdir(), 'songframe-montage-recovery-'));
  directories.push(project);
  const id = 'a'.repeat(32);
  const history = join(project, 'plan/montage-history', id);
  writeAtomicText(join(project, 'plan/scenes.json'), 'новый реестр');
  writeAtomicText(join(project, 'assets/shots/M01/manifest.json'), 'старый монтаж');
  writeAtomicText(join(history, 'before/plan/scenes.json'), 'старый реестр');
  writeAtomicText(join(history, 'before/assets/shots/M01/manifest.json'), 'старый монтаж');
  writeAtomicText(join(project, 'plan/edit-list.md'), 'новое представление');
  writeLocalJson(join(history, 'journal.json'), {
    schema_version: 1,
    id,
    state: 'publishing',
    files: [
      { path: 'plan/scenes.json', before: sha('старый реестр'), after: sha('новый реестр') },
      { path: 'assets/shots/M01/manifest.json', before: sha('старый монтаж'), after: sha('новый монтаж') },
      { path: 'plan/edit-list.md', before: null, after: sha('новое представление') }
    ]
  });
  return { project, history };
}
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('восстановление ручного монтажа', () => {
  it('возвращает согласованные старые файлы после прерывания и допускает повторный запуск', () => {
    const { project, history } = fixture();
    recoverMontageApplications(project);
    expect(readFileSync(join(project, 'plan/scenes.json'), 'utf8')).toBe('старый реестр');
    expect(readFileSync(join(project, 'assets/shots/M01/manifest.json'), 'utf8')).toBe('старый монтаж');
    expect(existsSync(join(project, 'plan/edit-list.md'))).toBe(false);
    expect(JSON.parse(readFileSync(join(history, 'journal.json'), 'utf8')).state).toBe('rolled_back');
    expect(() => recoverMontageApplications(project)).not.toThrow();
  });

  it('проверяет весь набор до отката и сохраняет последующую ручную правку', () => {
    const { project } = fixture();
    writeAtomicText(join(project, 'assets/shots/M01/manifest.json'), 'ручная правка');
    expect(() => recoverMontageApplications(project)).toThrow('изменён');
    expect(readFileSync(join(project, 'plan/scenes.json'), 'utf8')).toBe('новый реестр');
    expect(readFileSync(join(project, 'assets/shots/M01/manifest.json'), 'utf8')).toBe('ручная правка');
  });

  it('не затирает файлы при повреждении резервной копии', () => {
    const { project, history } = fixture();
    writeAtomicText(join(history, 'before/plan/scenes.json'), 'повреждённый резерв');
    expect(() => recoverMontageApplications(project)).toThrow('Повреждён резерв');
    expect(readFileSync(join(project, 'plan/scenes.json'), 'utf8')).toBe('новый реестр');
  });
});
