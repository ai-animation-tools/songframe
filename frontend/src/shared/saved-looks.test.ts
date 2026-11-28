import { describe, expect, it } from 'vitest';
import {
  descriptionLooksQuestion,
  defaultSavedLookKind,
  insertSavedLookMark,
  defaultSavedLookName,
  savedLookNameLength,
  savedLookState,
  type SavedLookRules,
  type SavedLooksView,
  type ShotLooksView
} from './saved-looks';

const rules: SavedLookRules = { nameMaxChars: 5, extraMin: 1, extraMax: 3, kinds: ['character', 'prop', 'costume'], coverFixed: true };

describe('сохранённые образы', () => {
  it('берёт статус референса из отчёта, без отчёта или поддержки — null', () => {
    const view: SavedLooksView = {
      supported: true,
      provider: 'test',
      rules,
      report: { account: 'a', count: 1, states: [{ reference: 'hero', status: 'ready', look: '1', name: 'Герой' }], looks: [] },
      error: ''
    };
    expect(savedLookState(view, 'hero')?.status).toBe('ready');
    expect(savedLookState(view, 'cup')).toEqual({ reference: 'cup', status: 'none' });
    expect(savedLookState({ ...view, report: null, error: 'Нет входа.' }, 'hero')).toBeNull();
    expect(savedLookState({ ...view, supported: false }, 'hero')).toBeNull();
    expect(savedLookState(null, 'hero')).toBeNull();
  });

  it('вид по умолчанию — вид референса, если провайдер его хранит, иначе первый', () => {
    expect(defaultSavedLookKind('prop', rules)).toBe('prop');
    expect(defaultSavedLookKind('style', rules)).toBe('character');
  });

  it('имя по умолчанию укорачивается по символам, а не по единицам UTF-16', () => {
    expect(defaultSavedLookName('  Мальчик в плаще ', rules)).toBe('Мальчи'.slice(0, 5));
    expect(defaultSavedLookName('🙂🙂🙂🙂🙂🙂', rules)).toBe('🙂🙂🙂🙂🙂');
    expect(savedLookNameLength(' 🙂я ')).toBe(2);
  });
});

describe('метка героя в своём видеопромпте', () => {
  it('встаёт за курсором с пробелами по краям и курсором за меткой', () => {
    expect(insertSavedLookMark('The man walks.', 7, 7, 'hero')).toEqual({ text: 'The man [@hero] walks.', caret: 15 });
    expect(insertSavedLookMark('The man walks.', 8, 8, 'hero')).toEqual({ text: 'The man [@hero] walks.', caret: 15 });
    expect(insertSavedLookMark('The man, tired.', 7, 7, 'hero')).toEqual({ text: 'The man [@hero], tired.', caret: 15 });
    expect(insertSavedLookMark('', 0, 0, 'hero')).toEqual({ text: '[@hero]', caret: 7 });
  });

  it('не удаляет выделенное упоминание: метка встаёт после него', () => {
    expect(insertSavedLookMark('The gull flies.', 4, 8, 'gull')).toEqual({ text: 'The gull [@gull] flies.', caret: 16 });
  });
});

describe('вопрос об образах перед описанием плана', () => {
  const view = (heroes: ShotLooksView['heroes'], extra: Partial<ShotLooksView> = {}): ShotLooksView => ({
    supported: true,
    model: 'test-video',
    limit: 2,
    kinds: ['character', 'prop'],
    heroes,
    error: '',
    ...extra
  });
  const hero = (code: string, kind: string, status: ShotLooksView['heroes'][number]['status']) => ({ code, name: code, kind, status });

  it('спрашивает о сущностях принимаемых видов без образа или с удалённым образом', () => {
    const question = descriptionLooksQuestion(
      view([hero('mira', 'character', 'none'), hero('lamp', 'prop', 'missing'), hero('pier', 'location', 'none'), hero('lev', 'character', 'ready')])
    );
    expect(question?.without.map((item) => item.code)).toEqual(['mira', 'lamp']);
    expect(question?.over).toBe(0);
  });

  it('считает образы принимаемых видов сверх предела модели, устаревший образ — тоже образ', () => {
    const question = descriptionLooksQuestion(view([hero('a', 'character', 'ready'), hero('b', 'character', 'stale'), hero('c', 'prop', 'ready')]));
    expect(question).toEqual({ model: 'test-video', limit: 2, without: [], over: 3 });
    // Образ вида, который модель не принимает, в запрос не пойдёт и предел не занимает.
    expect(descriptionLooksQuestion(view([hero('a', 'character', 'ready'), hero('b', 'prop', 'ready'), hero('c', 'location', 'ready')]))).toBeNull();
  });

  it('не спрашивает, если модель образы не принимает, статусы неизвестны или всё в порядке', () => {
    const missing = [hero('mira', 'character', 'none')];
    expect(descriptionLooksQuestion(view(missing, { limit: 0 }))).toBeNull();
    expect(descriptionLooksQuestion(view(missing, { supported: false }))).toBeNull();
    expect(descriptionLooksQuestion(view(missing, { error: 'Нет входа.' }))).toBeNull();
    expect(descriptionLooksQuestion(view([hero('lev', 'character', 'ready')]))).toBeNull();
  });
});
