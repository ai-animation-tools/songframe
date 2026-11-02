/** Применение предложения сохраняет подтверждённые строки и пользовательские правки вне найденных совпадений. */
import { expect, it } from 'vitest';
import { mergeTimingAgentReport, type TimingAgentReport, type TimingAgentSource } from './timing-agent';
import type { TimingLine } from './types';
it('обновляет неподтверждённые строки, добавляет новые и сохраняет все остальные', () => {
  const source: TimingAgentSource = {
    audioSha256: 'a',
    lyricsSha256: 't',
    duration: 30,
    lyrics: [2, 3, 4].map((number) => ({ number, text: `Строка ${number}` }))
  };
  const report: TimingAgentReport = {
    schemaVersion: 1,
    status: 'completed',
    audioSha256: 'a',
    lyricsSha256: 't',
    engine: 'ASR',
    summary: 'Готово',
    segments: [],
    matches: [2, 3, 4].map((sourceLine) => ({ sourceLine, start: sourceLine * 3, end: sourceLine * 3 + 1, segmentIndexes: [], note: 'Заметка ASR' })),
    unmatchedSourceLines: [],
    limitations: []
  };
  const lines: TimingLine[] = [
    { id: 5, source_line: 2, start: 0, end: 1, verified: true, note: 'Проверено человеком' },
    { id: 8, source_line: 3, start: 2, end: 3, verified: false, note: 'Моя заметка' },
    { id: 10, source_line: 90, start: NaN, end: 5, verified: false, note: 'Скрытый черновик' }
  ];
  const before = structuredClone(lines);
  const result = mergeTimingAgentReport(lines, report, source);
  expect(lines).toEqual(before);
  expect(result.appliedIds).toEqual([8, 11]);
  expect(result.lines[0]).toEqual(before[0]);
  expect(result.lines[2]).toEqual(before[2]);
  expect(result.lines[1]).toEqual({ ...before[1], start: 9, end: 10 });
  expect(result.lines[3]).toEqual({ id: 11, source_line: 4, start: 12, end: 13, verified: false, note: 'Заметка ASR' });
});
