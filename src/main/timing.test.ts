/** Исправление служебных примечаний остаётся черновиком до явного сохранения разметки. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SourceManifest, TimingFile } from '@shared/types';
import { withTimingVerification } from '@shared/timing-verification';
import { buildSections, saveTiming, viewTiming } from './timing';

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-timing-'));
  mkdirSync(join(project, 'source'));
  mkdirSync(join(project, 'plan/audio'), { recursive: true });
  writeFileSync(join(project, 'source/text.md'), '[Куплет]\nПервая строка\nВторая строка\n');
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

/** Синтетический проект проверяет точность разметки без доступа к исходникам настоящих клипов. */
function writeMusicalTiming(): TimingFile {
  const duration = 91.123456789;
  const names = [
    'Вступление',
    'Куплет 1',
    'Переход',
    'Припев 1',
    'Проигрыш',
    'Куплет 2',
    'Переход 2',
    'Припев 2',
    'Бридж',
    'Соло',
    'Припев 3',
    'Кода',
    'Финал'
  ];
  const timing: TimingFile = {
    version: 2,
    status: 'Ручная музыкальная разметка.',
    source: 'source/track.mp3',
    sha256: 'synthetic-track',
    duration_decoded: 91.111111111,
    duration_container: duration,
    clock: 'Секунды',
    lines: [
      { id: 1, source_line: 2, start: 1, end: 3, note: 'Первый вокальный вход' },
      { id: 2, source_line: 3, start: 4, end: 6, note: 'Вторая строка' }
    ],
    sections: names.map((name, index) => ({
      name,
      start: index === 0 ? 0 : index * 7 + 0.123456789,
      end: index === names.length - 1 ? duration : (index + 1) * 7 + 0.123456789,
      note: `  Музыкальная граница ${index + 1}: сохранить паузу и хвост.  `
    }))
  };
  const manifest: SourceManifest = {
    schema_version: 1,
    track: { path: 'track.mp3', sha256: 'synthetic-track', bytes: 0, original_name: 'track.mp3', duration_seconds: 91.123 },
    lyrics: null,
    idea: null,
    cover: null,
    references: [],
    updated_at: '2026-01-01T00:00:00.000Z'
  };
  writeFileSync(join(project, 'source/manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(project, 'plan/audio/timing.json'), JSON.stringify(timing));
  return timing;
}

it('сохраняет после чтения все 13 музыкальных частей и точные длительности', () => {
  const original = writeMusicalTiming();
  const view = viewTiming(project);
  expect(view.duration).toBe(91.123);
  expect(view.timing?.sections).toHaveLength(13);

  const saved = saveTiming(project, view.timing!);
  const persisted = JSON.parse(readFileSync(join(project, 'plan/audio/timing.json'), 'utf-8')) as TimingFile;
  for (const result of [saved, persisted]) {
    expect(result.sections).toEqual(original.sections);
    expect(result.duration_container).toBe(original.duration_container);
    expect(result.duration_decoded).toBe(original.duration_decoded);
  }
});

it('сохраняет музыкальные границы при сдвиге вокальной строки', () => {
  const original = writeMusicalTiming();
  const loaded = viewTiming(project).timing!;
  const saved = saveTiming(project, {
    ...loaded,
    lines: loaded.lines.map((line) => (line.id === 1 ? { ...line, start: 1.5, end: 3.5 } : line))
  });

  expect(saved.lines[0]).toMatchObject({ start: 1.5, end: 3.5 });
  expect(viewTiming(project).timing?.sections).toEqual(original.sections);
});

it.each([undefined, []])('строит части прежним алгоритмом, если sections = %j', (sections) => {
  writeMusicalTiming();
  const loaded = viewTiming(project).timing!;
  // JSON.stringify удаляет undefined: проверяем и старый файл без массива sections.
  writeFileSync(join(project, 'plan/audio/timing.json'), JSON.stringify({ ...loaded, sections }));
  const saved = saveTiming(project, viewTiming(project).timing!);

  expect(saved.sections).toEqual([
    { name: 'Куплет', start: 1, end: 6, note: 'строки 1–2' },
    { name: 'Финал без вокала', start: 6, end: 91.123, note: 'до конца трека' }
  ]);
});

it('принимает части, явно пересчитанные вызывающим кодом', () => {
  const original = writeMusicalTiming();
  const view = viewTiming(project);
  const lines = view.timing!.lines.map((line) => (line.id === 1 ? { ...line, start: 2, end: 3 } : line));
  const recalculated = buildSections(view.lyrics, lines, original.duration_container);
  const saved = saveTiming(project, { ...view.timing!, lines, sections: recalculated });

  expect(recalculated).not.toEqual(original.sections);
  expect(recalculated[0]).toEqual({ name: 'Вступление', start: 0, end: 2, note: 'без вокала' });
  expect(saved.sections).toEqual(recalculated);
  expect(viewTiming(project).timing?.sections).toEqual(recalculated);
});

it('берёт длительность из манифеста, когда в разметке она не задана', () => {
  writeMusicalTiming();
  const loaded = viewTiming(project).timing!;
  const saved = saveTiming(project, { ...loaded, duration_container: null });

  expect(saved.duration_container).toBe(91.123);
  expect(saved.duration_decoded).toBe(loaded.duration_decoded);
});

it('нормализует старые подтверждённые строки при сохранении и сохраняет ручные заметки', () => {
  const timing: TimingFile = {
    version: 2,
    status: 'Разметка подтверждена на слух.',
    source: 'source/track.mp3',
    sha256: null,
    duration_decoded: 20,
    duration_container: 20,
    clock: 'Секунды',
    lines: [
      { id: 1, source_line: 2, start: 1, end: 3, verified: true, note: 'Совпали все 5 слов; сверка на слух не выполнена. Вход на вдохе.' },
      { id: 2, source_line: 3, start: 4, end: 6, verified: true, note: 'подтверждено на слух; оставить паузу' }
    ],
    sections: []
  };
  const target = join(project, 'plan/audio/timing.json');
  const original = JSON.stringify(timing);
  writeFileSync(target, original);
  const loaded = viewTiming(project).timing!;
  const draft = loaded.lines.map((line) => withTimingVerification(line));
  expect(draft[0].note).toBe('Совпали все 5 слов; сверка на слух выполнена. Вход на вдохе.');
  expect(readFileSync(target, 'utf-8')).toBe(original);

  // Сохранение через API тоже нормализует старое примечание, даже если вызывающий код этого не сделал.
  const saved = saveTiming(project, loaded);
  expect(saved.lines[0].note).toBe(draft[0].note);
  expect(saved.lines[1]).toEqual(timing.lines[1]);
  expect(JSON.parse(readFileSync(target, 'utf-8')).lines).toEqual(saved.lines);
  const unverified = saveTiming(project, { ...saved, lines: saved.lines.map((line) => ({ ...line, verified: false })) });
  expect(unverified.lines[0].note).toBe(timing.lines[0].note);
  expect(unverified.lines[1].note).toBe(timing.lines[1].note);
});
