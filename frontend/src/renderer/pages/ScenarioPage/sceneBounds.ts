import { scenarioTexts } from '@shared/texts/scenario';
/**
 * Пересчёт границ планов по разметке песни без новой постановки. Каркас (`scene_scaffold --dry-run`) нарезает окна
 * по сохранённым трактовке и разметке; из него в реестр переносятся только окно плана, его строки песни и отметка
 * трека, а камера, действие, непрерывность, состояние и остальная постановка остаются прежними. Перенос идёт по коду
 * плана, поэтому состав планов должен совпасть: иначе коды сдвинулись бы и постановка попала бы в чужие окна.
 */
import type { LyricsLine, ScenesFile, SceneShot, TimingLine, TreatmentFile } from '@shared/types';

/** Поля окна: их задаёт каркас, а не постановка. */
const WINDOW_FIELDS = ['original', 'start_frame', 'end_frame_exclusive'] as const;

export type SceneBoundsResult = { scenes: ScenesFile; changed: string[] } | { problem: string };

/** Сохранённые трактовка и разметка, по которым каркас нарезал окна: из них объясняется расхождение числа планов. */
export interface SceneBoundsSource {
  treatment: TreatmentFile | null;
  lines: TimingLine[];
  /** Текст песни: по нему строки в `original` планов узнаются как строки разметки. */
  lyrics: LyricsLine[];
  duration: number | null;
}

/** Правила нарезки каркаса (`internal/scenescaffold`): пауза у края части от 2,5 с — отдельный план, шаг по умолчанию 6 с. */
const GAP_SECONDS = 2.5;
const DEFAULT_MAX_SHOT = 6;

/** Секунды для текста: как в полях трактовки, до сотых без хвостовых нулей. */
const seconds = (value: number, digits = 2): string => String(Number(value.toFixed(digits)));

/**
 * Причина и совет для части partId, где каркас дал другое число планов. Повторяет нарезку каркаса: в часть попадают
 * строки, середина которых внутри неё; пауза до первой или после последней строки от 2,5 с становится отдельным
 * планом; часть без строк делится по «Макс. план». Если у края пауз нет, причина — сами строки части.
 */
function countCause(partId: string, source: SceneBoundsSource, fps: number): { cause?: string; fix: string } | null {
  const parts = [...(source.treatment?.sequences ?? [])].sort((a, b) => a.start - b.start);
  const index = parts.findIndex((part) => part.id === partId);
  if (index < 0) return null;
  const part = parts[index];
  const frame = (value: number) => Math.round(value * fps);
  const within = (line: TimingLine, from: number, to: number) => {
    const middle = frame((line.start + line.end) / 2);
    return frame(from) <= middle && middle < frame(to);
  };
  const hasLines = (from: number, to: number) => source.lines.some((line) => within(line, from, to));
  const end = parts[index + 1]?.start ?? source.duration ?? part.end;
  const inside = [...source.lines].sort((a, b) => a.start - b.start).filter((line) => within(line, part.start, end));
  const texts = scenarioTexts.notice;
  if (!inside.length) {
    return {
      cause: texts.boundsCause.noLines({ length: seconds(end - part.start, 1), max: seconds(part.max_shot_seconds ?? DEFAULT_MAX_SHOT) }),
      fix: texts.boundsFix.maxShot
    };
  }
  const first = inside[0];
  const last = inside[inside.length - 1];
  const gap = frame(GAP_SECONDS);
  if (frame(first.start) - frame(part.start) >= gap) {
    // Сдвиг начала удлиняет предыдущую часть: без строк она может разделиться на другое число планов.
    const previous = parts[index - 1];
    const previousEmpty = previous && !hasLines(previous.start, part.start);
    return {
      cause: texts.boundsCause.leadPause({ seconds: seconds(first.start - part.start, 1), line: first.source_line }),
      fix:
        texts.boundsFix.moveStart({ at: seconds(first.start) }) +
        (previousEmpty ? texts.boundsFix.neighbourGrows({ title: previous.title || previous.id }) : '')
    };
  }
  if (frame(end) - frame(last.end) >= gap && index + 1 < parts.length) {
    const next = parts[index + 1];
    const nextEnd = parts[index + 2]?.start ?? source.duration ?? next.end;
    const nextEmpty = !hasLines(next.start, nextEnd);
    return {
      cause: texts.boundsCause.trailPause({ seconds: seconds(end - last.end, 1), line: last.source_line }),
      fix: texts.boundsFix.moveEnd({ at: seconds(last.end) }) + (nextEmpty ? texts.boundsFix.neighbourGrows({ title: next.title || next.id }) : '')
    };
  }
  return { cause: texts.boundsCause.lines({ count: inside.length, first: first.source_line, last: last.source_line }), fix: texts.boundsFix.lines };
}

/** Число планов каждой части в порядке реестра. */
function partCounts(shots: SceneShot[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const shot of shots) counts.set(shot.sequence, (counts.get(shot.sequence) ?? 0) + 1);
  return counts;
}

/** Разделитель строк песни в `original` плана — так их соединяет каркас. */
const ORIGINAL_SEPARATOR = ' / ';

/** Сколько раз каждая строка текста песни стоит в планах каждой части: подписи без строк песни не считаются. */
function linesByPart(shots: SceneShot[], lyricTexts: Set<string>): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  for (const shot of shots) {
    const counts = result.get(shot.sequence) ?? new Map<string, number>();
    result.set(shot.sequence, counts);
    for (const piece of shot.original.split(ORIGINAL_SEPARATOR).map((text) => text.trim()))
      if (lyricTexts.has(piece)) counts.set(piece, (counts.get(piece) ?? 0) + 1);
  }
  return result;
}

/**
 * Строка песни, которую каркас отнёс к другой части, чем реестр. Так бывает, когда новая разметка сдвинула строку
 * через границу части трактовки (середина строки решает, чья она), а граница осталась прежней: число планов может
 * совпасть, и без этой проверки пересчёт молча отдал бы строку плану соседней части с чужой постановкой. Строки
 * узнаются по тексту в `original` планов; повторяющиеся строки сравниваются числом вхождений в каждой части.
 */
function movedLine(current: ScenesFile, scaffold: ScenesFile, source: SceneBoundsSource): string | null {
  const lyricTexts = new Set(
    source.lyrics
      .filter((line) => !line.header)
      .map((line) => line.text.trim())
      .filter(Boolean)
  );
  if (!lyricTexts.size) return null;
  const before = linesByPart(current.scenes, lyricTexts);
  const after = linesByPart(scaffold.scenes, lyricTexts);
  const order = scaffold.sequences.map((sequence) => sequence.id);
  const title = (id: string) => scaffold.sequences.find((sequence) => sequence.id === id)?.title || id;
  const count = (map: Map<string, Map<string, number>>, part: string, text: string) => map.get(part)?.get(text) ?? 0;
  for (const to of order) {
    for (const [text, now] of after.get(to) ?? []) {
      if (now <= count(before, to, text)) continue;
      const from = order.find((part) => part !== to && count(before, part, text) > count(after, part, text));
      if (!from) continue;
      // Строка разметки с этим текстом, которая теперь попала в часть to.
      const numbers = new Set(source.lyrics.filter((line) => line.text.trim() === text).map((line) => line.number));
      const parts = [...(source.treatment?.sequences ?? [])].sort((a, b) => a.start - b.start);
      const target = parts.find((part) => part.id === to);
      const line = source.lines.find((item) => {
        const middle = (item.start + item.end) / 2;
        return numbers.has(item.source_line) && (!target || (middle >= target.start && middle < target.end));
      });
      if (!line) continue;
      const earlier = order.indexOf(to) < order.indexOf(from);
      const notice = scenarioTexts.notice;
      return notice.boundsLineMoved({
        line: line.source_line,
        text,
        start: seconds(line.start),
        end: seconds(line.end),
        to: title(to),
        from: title(from),
        fix: earlier
          ? notice.boundsFix.movePartStart({ part: title(from), at: seconds(line.start) })
          : notice.boundsFix.movePartEnd({ part: title(from), at: seconds(line.end) })
      });
    }
  }
  return null;
}

/**
 * Реестр current с окнами каркаса scaffold. changed — коды планов, у которых сдвинулись границы или изменились строки
 * песни. Если строка песни перешла в другую часть, части или число планов в них разошлись, возвращается объяснение
 * вместо реестра: какая строка и куда ушла или причина другого числа планов по сохранённым трактовке и разметке
 * source, и совет, что поправить в трактовке.
 */
export function recalculateSceneBounds(current: ScenesFile, scaffold: ScenesFile, source: SceneBoundsSource): SceneBoundsResult {
  // Строка, ушедшая в другую часть, — ошибка при любом числе планов: её проверяют первой, когда части те же.
  const sameSequences =
    current.sequences.length === scaffold.sequences.length && current.sequences.every((sequence, index) => sequence.id === scaffold.sequences[index].id);
  const moved = sameSequences ? movedLine(current, scaffold, source) : null;
  if (moved) return { problem: moved };
  const sameShots =
    current.scenes.length === scaffold.scenes.length &&
    current.scenes.every((shot, index) => shot.id === scaffold.scenes[index].id && shot.sequence === scaffold.scenes[index].sequence);
  if (!sameShots) {
    const was = partCounts(current.scenes);
    const now = partCounts(scaffold.scenes);
    const parts = new Set([...was.keys(), ...now.keys()]);
    const sameParts = parts.size === was.size && parts.size === now.size;
    const differing = sameParts ? [...parts].find((part) => was.get(part) !== now.get(part)) : undefined;
    if (!differing) return { problem: scenarioTexts.notice.boundsPartsChanged };
    const title = scaffold.sequences.find((sequence) => sequence.id === differing)?.title || differing;
    const explained = countCause(differing, source, scaffold.fps) ?? { fix: scenarioTexts.notice.boundsFix.lines };
    return {
      problem: scenarioTexts.notice.boundsCountChanged({ part: title, was: was.get(differing) ?? 0, now: now.get(differing) ?? 0, ...explained })
    };
  }
  const changed: string[] = [];
  const scenes = current.scenes.map((shot, index) => {
    const base = scaffold.scenes[index];
    if (WINDOW_FIELDS.every((key) => shot[key] === base[key])) return shot;
    changed.push(shot.id);
    return { ...shot, original: base.original, start_frame: base.start_frame, end_frame_exclusive: base.end_frame_exclusive };
  });
  const audioChanged = current.audio.end_seconds !== scaffold.audio.end_seconds;
  if (!changed.length && !audioChanged) return { scenes: current, changed };
  return { scenes: { ...current, audio: audioChanged ? { ...current.audio, end_seconds: scaffold.audio.end_seconds } : current.audio, scenes }, changed };
}
