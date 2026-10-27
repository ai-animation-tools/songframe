/**
 * Разметка песни plan/audio/timing.json: чтение вместе с текстом, проверка и запись из редактора таймингов.
 * Сохраняет музыкальные части независимо от вокальных строк; без частей строит их по заголовкам текста.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeLyrics, selectLyricTimings } from '@shared/lyrics';
import type { LyricsLine, TimingFile, TimingLine, TimingView } from '@shared/types';
import { readManifest } from './sources';
import { resolveTimingSections } from '@shared/timing-sections';
import { withTimingVerification } from '@shared/timing-verification';
export { buildSections } from '@shared/timing-sections';

const MIN_LENGTH = 0.3;

export function parseLyricsLines(text: string): LyricsLine[] {
  return analyzeLyrics(text).rows;
}

function readJson<T>(path: string): T | null | false {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return false;
  }
}

export function viewTiming(project: string): TimingView {
  const problems: string[] = [];
  const textPath = join(project, 'source', 'text.md');
  const hasText = existsSync(textPath);
  const parsed = analyzeLyrics(hasText ? readFileSync(textPath, 'utf-8') : '');
  const lyrics = hasText ? parsed.rows : [];
  if (hasText) problems.push(...parsed.problems);
  else problems.push('Сначала добавьте текст песни на странице «Исходники».');
  const trackPath = join(project, 'source', 'track.mp3');
  const manifest = readManifest(project);
  let timing = readJson<TimingFile>(join(project, 'plan', 'audio', 'timing.json'));
  // Повреждённый формат разметки не должен прерывать открытие монтажа и других страниц.
  if (timing && (!Array.isArray(timing.lines) || timing.lines.some((line) => !line || typeof line !== 'object'))) timing = false;
  if (timing === false) problems.push('Не удалось прочитать сохранённую разметку. Восстановите её из копии или выполните автоматическую разметку заново.');
  if (timing && manifest?.track && timing.sha256 && timing.sha256 !== manifest.track.sha256)
    problems.push('Разметка сделана для другого трека: трек заменён после разметки.');
  if (timing) {
    const { invalidIds } = selectLyricTimings(timing.lines, lyrics);
    if (invalidIds.length)
      problems.push(
        `После изменения текста часть строк разметки больше не соответствует словам песни и скрыта в редакторе. Повторите автоматическую разметку, чтобы восстановить соответствие. Сохранённая разметка пока не изменена.`
      );
  }
  return {
    timing: timing || null,
    lyrics,
    trackPath: existsSync(trackPath) ? trackPath : null,
    trackSha256: manifest?.track?.sha256 ?? null,
    duration: manifest?.track?.duration_seconds ?? null,
    problems
  };
}

export function validateTiming(timing: TimingFile, lyrics: LyricsLine[], duration: number | null): string[] {
  const problems: string[] = [];
  const byNumber = new Map(lyrics.map((l) => [l.number, l]));
  const ids = new Set<number>();
  const numbers = new Set<number>();
  for (const line of timing.lines) {
    const label = `строка ${line.id}`;
    if (ids.has(line.id)) problems.push(`Повторяется id ${line.id}.`);
    ids.add(line.id);
    if (numbers.has(line.source_line)) problems.push(`${label}: строка текста ${line.source_line} размечена дважды.`);
    numbers.add(line.source_line);
    const lyric = byNumber.get(line.source_line);
    if (!lyric || lyric.header || !lyric.text) problems.push(`${label}: в тексте нет строки песни с номером ${line.source_line}.`);
    if (!Number.isFinite(line.start) || !Number.isFinite(line.end)) problems.push(`${label}: границы не числа.`);
    else if (line.end - line.start < MIN_LENGTH) problems.push(`${label}: длиннее ${MIN_LENGTH} с должна быть каждая строка.`);
    else if (line.start < 0) problems.push(`${label}: начало раньше нуля.`);
    else if (duration && line.end > duration + 0.5) problems.push(`${label}: конец за пределами трека.`);
  }
  const ordered = [...timing.lines].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end - 0.001) problems.push(`Строки ${ordered[i - 1].id} и ${ordered[i].id} пересекаются.`);
  }
  return problems;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function timingStatus(lines: TimingLine[], previous: string): string {
  const verified = lines.filter((l) => l.verified).length;
  if (lines.length && verified === lines.length) return 'Разметка подтверждена на слух.';
  const base = previous.replace(/;\s*подтверждено на слух.*$/, '').replace(/\.$/, '');
  return `${base || 'Разметка'}; подтверждено на слух ${verified} из ${lines.length} строк.`;
}

/** Перенумеровывает строки и обновляет статус, сохраняя переданные музыкальные части без пересчёта. */
export function saveTiming(project: string, timing: TimingFile): TimingFile {
  const view = viewTiming(project);
  const problems = validateTiming(timing, view.lyrics, view.duration);
  if (problems.length) throw new Error(problems.join(' '));
  const manifest = readManifest(project);
  const lines = [...timing.lines]
    .sort((a, b) => a.start - b.start)
    .map((line, index) =>
      withTimingVerification({
        ...line,
        id: index + 1,
        start: round(line.start),
        end: round(line.end),
        note: (line.note ?? '').trim()
      })
    );
  // Манифест может содержать округлённую длительность: точность исходной разметки сохраняется.
  const duration = timing.duration_container ?? view.duration;
  const result: TimingFile = {
    version: 2,
    status: timingStatus(lines, timing.status),
    source: 'source/track.mp3',
    sha256: manifest?.track?.sha256 ?? timing.sha256 ?? null,
    duration_decoded: timing.duration_decoded ?? duration,
    duration_container: duration,
    clock: 'Секунды от начала декодированного звука, не SMPTE',
    lines,
    sections: resolveTimingSections(timing.sections, view.lyrics, lines, duration)
  };
  const target = join(project, 'plan', 'audio', 'timing.json');
  mkdirSync(join(project, 'plan', 'audio'), { recursive: true });
  writeFileSync(target, JSON.stringify(result, null, 2) + '\n', 'utf-8');
  return result;
}
