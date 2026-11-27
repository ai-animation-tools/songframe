import { describe, expect, it } from 'vitest';
import { sourcesTexts } from '@shared/texts/sources';
import type { SourceKind } from '@shared/types';
import { kindChangeNotice, kindForId, savedLookReference } from './helpers';
import type { ReferenceForm } from './types';

const kinds: SourceKind[] = [
  { id: 'character', label: 'Персонаж', dir: 'heroes' },
  { id: 'prop', label: 'Предмет', dir: 'props' }
];
const reference = (patch: Partial<ReferenceForm> = {}): ReferenceForm => ({
  key: 1,
  id: 'lopata',
  kind: 'character',
  name: 'Лопата',
  short_name: '',
  description: '',
  prompt: '',
  files: [],
  ...patch
});
const saved = { key: 2, existingPath: 'heroes/lopata.png', view: 'full' as const, note: '', prompt: '' };

/** Новый референс с кодом сущности кастинга берёт её тип; сохранённый тип не меняется. */
describe('kindForId', () => {
  it('берёт тип сущности кастинга только у нового референса и только известный', () => {
    expect(kindForId(reference(), 'lopata', { lopata: 'prop' }, kinds)).toBe('prop');
    expect(kindForId(reference(), 'lopata', { lopata: 'animal' }, kinds)).toBe('character');
    expect(kindForId(reference(), 'other', { lopata: 'prop' }, kinds)).toBe('character');
    expect(kindForId(reference({ files: [saved] }), 'lopata', { lopata: 'prop' }, kinds)).toBe('character');
  });
});

/** Подсказка о переносе видна только после смены типа сохранённого референса. */
describe('kindChangeNotice', () => {
  it('сообщает о переносе или о том, что закреплённые файлы остаются', () => {
    const changed = reference({ savedKind: 'character', kind: 'prop', files: [saved] });
    expect(kindChangeNotice(changed, kinds, undefined)).toBe(sourcesTexts.kindMovesFiles({ dir: 'props' }));
    expect(kindChangeNotice(changed, kinds, ['M03'])).toBe(sourcesTexts.kindKeepsFiles({ dir: 'heroes', shots: ['M03'] }));
    expect(kindChangeNotice(reference({ savedKind: 'character', files: [saved] }), kinds, undefined)).toBeNull();
    expect(kindChangeNotice(reference({ kind: 'prop', files: [saved] }), kinds, undefined)).toBeNull();
  });
});

describe('референс для окна образа', () => {
  const manifest = {
    schema_version: 1 as const,
    track: null,
    lyrics: null,
    idea: null,
    cover: null,
    updated_at: '',
    references: [
      {
        id: 'hero',
        kind: 'character' as const,
        name: 'Герой',
        short_name: '',
        description: '',
        prompt: null,
        files: [
          { path: 'heroes/a.png', sha256: 's1', bytes: 1, view: 'front' as const, note: '' },
          { path: 'heroes/b.png', sha256: 's2', bytes: 1, view: 'side' as const, note: '' }
        ]
      }
    ]
  };
  const form = (files: { existingPath?: string; sourcePath?: string }[], id = 'hero') => ({
    key: 1,
    id,
    kind: 'character' as const,
    name: 'Герой',
    short_name: '',
    description: '',
    prompt: '',
    files: files.map((file, key) => ({ key, view: 'front' as const, note: '', prompt: '', ...file }))
  });

  it('доступен только сохранённый референс с теми же снимками', () => {
    expect(savedLookReference(form([{ existingPath: 'heroes/b.png' }, { existingPath: 'heroes/a.png' }]), manifest)?.id).toBe('hero');
    expect(savedLookReference(form([{ existingPath: 'heroes/a.png' }]), manifest)).toBeNull();
    expect(savedLookReference(form([{ existingPath: 'heroes/a.png' }, { existingPath: 'heroes/b.png' }, { sourcePath: '/tmp/c.png' }]), manifest)).toBeNull();
    expect(savedLookReference(form([{ existingPath: 'heroes/a.png' }, { existingPath: 'heroes/b.png' }], 'new_hero'), manifest)).toBeNull();
    expect(savedLookReference(form([]), null)).toBeNull();
  });
});
