/** Содержательные изменения остаются значимыми; оформление и прежние доказанные снимки обрабатываются отдельно. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourceInputDigest, sourceInputDigestFromBytes, upgradeSourceInputSnapshot } from './source-input-hash';

let project: string;
const value = {
  schema_version: 1,
  track: { path: 'track.mp3', sha256: 'track' },
  lyrics: { path: 'text.md' },
  idea: { path: 'description.md' },
  references: [{ id: 'hero', files: [{ path: 'heroes/hero.png' }] }],
  cover: { path: 'cover.png' },
  updated_at: 'вчера'
};
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-source-input-'));
  mkdirSync(join(project, 'source'));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe('содержательные входы проекта', () => {
  it('смена, удаление и добавление обложки не меняют отпечаток входов', () => {
    const expected = sourceInputDigestFromBytes(JSON.stringify(value));
    for (const cover of [null, { path: 'another.jpg', sha256: 'new' }])
      expect(sourceInputDigestFromBytes(JSON.stringify({ ...value, cover, updated_at: 'сегодня' }))).toBe(expected);
    const withoutCover = JSON.parse(JSON.stringify(value));
    delete withoutCover.cover;
    expect(sourceInputDigestFromBytes(JSON.stringify(withoutCover))).toBe(expected);
  });
  it.each(['track', 'lyrics', 'idea', 'references', 'kinds', 'new_field'])('изменение %s не скрывается', (field) => {
    expect(sourceInputDigestFromBytes(JSON.stringify({ ...value, [field]: 'изменено' }))).not.toBe(sourceInputDigestFromBytes(JSON.stringify(value)));
  });
  it('переводит только точно совпадающий старый снимок', () => {
    const bytes = JSON.stringify(value);
    writeFileSync(join(project, 'source/manifest.json'), bytes);
    const old = { 'source/manifest.json': createHash('sha256').update(bytes).digest('hex') };
    expect(upgradeSourceInputSnapshot(old, project)).toBe(true);
    expect(old['source/manifest.json']).toBe(sourceInputDigest(project));
    const unrelated = { 'source/manifest.json': 'f'.repeat(64) };
    expect(upgradeSourceInputSnapshot(unrelated, project)).toBe(false);
    expect(unrelated['source/manifest.json']).toBe('f'.repeat(64));
  });
  it('повреждённый JSON не совпадает с прежним корректным', () => {
    expect(sourceInputDigestFromBytes('{')).not.toBe(sourceInputDigestFromBytes(JSON.stringify(value)));
    expect(sourceInputDigest(project)).toBeNull();
  });
});
