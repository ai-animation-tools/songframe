import { describe, expect, it } from 'vitest';
import { sourcesTexts } from '@shared/texts/sources';
import type { SourceKind } from '@shared/types';
import { kindChangeNotice, kindForId } from './helpers';
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
