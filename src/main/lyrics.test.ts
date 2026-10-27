/** Интеграция проверки текста с чтением файла, сохранением исходников и устаревшей разметкой. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSources, validateSources } from './sources';
import { viewTiming } from './timing';
import { selectLyricTimings } from '@shared/lyrics';
import type { SourcesInput } from '@shared/types';

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-lyrics-'));
  mkdirSync(join(project, 'source'));
  mkdirSync(join(project, 'plan/audio'), { recursive: true });
  writeFileSync(join(project, 'source/manifest.json'), JSON.stringify({ schema_version: 1, track: {}, lyrics: { path: 'text.md' }, idea: {}, references: [] }));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));
const input = (): SourcesInput => ({ track: null, lyrics: null, idea: null, cover: null, references: [] });

describe('проверка текста песни', () => {
  it('одинаково проверяет ввод и импорт и не перезаписывает исходник при ошибке', () => {
    const saved = join(project, 'source/text.md');
    const imported = join(project, 'import.txt');
    writeFileSync(saved, '[Припев]\nВерная строка\n');
    writeFileSync(imported, '[Припев\nСлова\n');
    const textInput = { ...input(), lyrics: { text: '[Припев\nСлова\n' } };
    const fileInput = { ...input(), lyrics: { path: imported } };
    expect(validateSources(project, textInput)).toEqual(validateSources(project, fileInput));
    expect(() => saveSources(project, fileInput)).toThrow('Строка 1');
    expect(readFileSync(saved, 'utf8')).toBe('[Припев]\nВерная строка\n');
  });

  it('проверяет сохранённый текст, даже если поле не меняли', () => {
    writeFileSync(join(project, 'source/text.md'), 'Припев:\nСлова');
    expect(validateSources(project, input()).join(' ')).toContain('без скобок');
  });

  it('объясняет старые привязки к заголовку и оставляет файл разметки нетронутым', () => {
    writeFileSync(join(project, 'source/text.md'), '[Припев]\nСлова');
    const file = join(project, 'plan/audio/timing.json');
    const original = JSON.stringify({
      lines: [
        { id: 1, source_line: 1 },
        { id: 2, source_line: 2 }
      ]
    });
    writeFileSync(file, original);
    const view = viewTiming(project);
    expect(view.problems.join(' ')).toContain('После изменения текста');
    expect(selectLyricTimings(view.timing!.lines, view.lyrics).lines.map((line) => line.id)).toEqual([2]);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
});
