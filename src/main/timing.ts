/**
 * Разметка песни plan/audio/timing.json: чтение вместе с текстом, проверка и запись из редактора таймингов.
 * Сохраняет ручные части и сомнительные предложения; автоматическую карту обновляет по строкам и кандидатам.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeLyrics, selectLyricTimings } from '@shared/lyrics';
import { timingTexts } from '@shared/texts/timing';
import type { LyricsLine, TimingFile, TimingLine, TimingView } from '@shared/types';
import { readManifest } from './sources';
import { writeLocalJson } from './local-files';
import { resolveTimingSections } from '@shared/timing-sections';
import { withTimingVerification } from '@shared/timing-verification';
export { buildSections } from '@shared/timing-sections';

import { validateTiming, validTimingCandidates } from '@shared/timing-validation';
export { validateTiming } from '@shared/timing-validation';

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
  else problems.push(timingTexts.main.lyricsRequired);
  const trackPath = join(project, 'source', 'track.mp3');
  const manifest = readManifest(project);
  let timing = readJson<TimingFile>(join(project, 'plan', 'audio', 'timing.json'));
  // Повреждённый формат разметки не должен прерывать открытие монтажа и других страниц.
  if (timing && (!Array.isArray(timing.lines) || timing.lines.some((line) => !line || typeof line !== 'object'))) timing = false;
  if (timing && timing.candidates !== undefined && !validTimingCandidates(timing.candidates)) timing = false;
  if (timing && timing.line_order !== undefined && (!Array.isArray(timing.line_order) || timing.line_order.some((number) => !Number.isSafeInteger(number))))
    timing = false;
  if (
    timing &&
    timing.sections !== undefined &&
    (!Array.isArray(timing.sections) ||
      timing.sections.some(
        (section) =>
          !section ||
          typeof section !== 'object' ||
          typeof section.name !== 'string' ||
          !Number.isFinite(section.start) ||
          !Number.isFinite(section.end) ||
          (section.origin !== undefined && !['auto', 'manual'].includes(section.origin))
      ))
  )
    timing = false;
  if (timing === false) problems.push(timingTexts.main.unreadableTiming);
  if (timing && manifest?.track && timing.sha256 && timing.sha256 !== manifest.track.sha256) problems.push(timingTexts.main.trackChanged);
  if (timing) {
    const { invalidIds } = selectLyricTimings(timing.lines, lyrics);
    if (invalidIds.length) problems.push(timingTexts.main.lyricsChanged);
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

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/* eslint-disable no-restricted-syntax -- Сохраняемый status в timing.json разбирается регуляркой и остаётся данными разметки. */
export function timingStatus(lines: TimingLine[], previous: string, expectedCount = lines.length): string {
  const verified = lines.filter((l) => l.verified).length;
  if (lines.length && verified === expectedCount && lines.length === expectedCount) return 'Разметка подтверждена на слух.';
  // Прежнее полное подтверждение больше не действует после удаления строки или снятия отметки.
  const base = previous
    .replace(/^Разметка подтверждена на слух\.?$/, 'Разметка')
    .replace(/;\s*подтверждено на слух.*$/, '')
    .replace(/\.$/, '');
  return `${base || 'Разметка'}; подтверждено на слух ${verified} из ${expectedCount} строк.`;
}

/* eslint-enable no-restricted-syntax */

/** Перенумеровывает принятые строки, сохраняет порядок редактора и пересчитывает только автоматические части. */
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
  const candidates = (timing.candidates ?? []).filter((candidate) => !lines.some((line) => line.source_line === candidate.source_line && line.verified));
  const sourceOrder = view.lyrics.filter((line) => !line.header && !!line.text.trim()).map((line) => line.number);
  const lineOrder = [...new Set([...(timing.line_order ?? []), ...sourceOrder])];
  const result: TimingFile = {
    version: 2,
    status: timingStatus(lines, timing.status, view.lyrics.filter((line) => !line.header && !!line.text.trim()).length),
    source: 'source/track.mp3',
    sha256: manifest?.track?.sha256 ?? timing.sha256 ?? null,
    duration_decoded: timing.duration_decoded ?? duration,
    duration_container: duration,
    // eslint-disable-next-line no-restricted-syntax -- Сохраняемое описание clock принадлежит формату timing.json, а не текстам интерфейса.
    clock: 'Секунды от начала декодированного звука, не SMPTE',
    lines,
    sections: resolveTimingSections(timing.sections, view.lyrics, lines, duration, candidates),
    candidates,
    line_order: lineOrder
  };
  const target = join(project, 'plan', 'audio', 'timing.json');
  // Публикуем целый JSON через временный файл: отказ записи не обнуляет прежнюю разметку.
  writeLocalJson(target, result);
  return result;
}
