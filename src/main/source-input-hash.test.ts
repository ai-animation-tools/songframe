/** Содержательные изменения остаются значимыми, оформление на отпечаток не влияет. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourceInputDigest, sourceInputDigestFromBytes } from './source-input-hash';

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
  it('повреждённый JSON не совпадает с прежним корректным', () => {
    expect(sourceInputDigestFromBytes('{')).not.toBe(sourceInputDigestFromBytes(JSON.stringify(value)));
    expect(sourceInputDigest(project)).toBeNull();
  });
});
