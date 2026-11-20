import { describe, expect, it } from 'vitest';
import { draftEnvelope, parseDraft } from './drafts';

describe('черновики страниц', () => {
  it('конверт хранит документ и сохранённую основу', () => {
    const content = draftEnvelope({ a: 2 }, { a: 1 }, new Date('2026-11-20T10:00:00Z'));
    expect(parseDraft(content)).toEqual({ savedAt: '2026-11-20T10:00:00.000Z', base: '{"a":1}', document: { a: 2 } });
  });

  it('пустой, повреждённый и чужой черновик не разбирается', () => {
    expect(parseDraft('')).toBeNull();
    expect(parseDraft('{')).toBeNull();
    expect(parseDraft('{"document":1}')).toBeNull();
    expect(parseDraft('null')).toBeNull();
  });
});
