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
 * Нарезка каркаса по сохранённым трактовке и разметке, нужная для объяснения отказа: какие строки попадают в часть
 * (по середине строки на сетке кадров) и на сколько планов каркас делит часть без строк. Повторяет правила
 * `internal/scenescaffold`; второй шаг каркаса (деление куска длиннее полутора шагов) части без строк не меняет числа
 * планов, потому что куски и так не длиннее шага с округлением.
 */
function slicing(source: SceneBoundsSource, fps: number) {
  const parts = [...(source.treatment?.sequences ?? [])].sort((a, b) => a.start - b.start);
  const frame = (value: number) => Math.round(value * fps);
  const within = (line: TimingLine, from: number, to: number) => {
    const middle = frame((line.start + line.end) / 2);
    return frame(from) <= middle && middle < frame(to);
  };
  const lines = [...source.lines].sort((a, b) => a.start - b.start);
  const step = (index: number) => parts[index].max_shot_seconds ?? DEFAULT_MAX_SHOT;
  return {
    parts,
    frame,
    end: (index: number) => parts[index + 1]?.start ?? source.duration ?? parts[index].end,
    inside: (from: number, to: number) => lines.filter((line) => within(line, from, to)),
    /** Число планов части index без строк на отрезке from–to: длина на сетке кадров, делённая на «Макс. план». */
    emptyCount: (index: number, from: number, to: number) => Math.max(1, Math.round((frame(to) - frame(from)) / fps / step(index))),
    length: (from: number, to: number) => (frame(to) - frame(from)) / fps
  };
}

/**
 * «Макс. план, с», при котором часть без строк длиной length делится ровно на count планов: значение строго внутри
 * интервала length/(count+½)…length/(count−½), чтобы округление каркаса дало count. Берётся целое не меньше 2 (как у
 * поля трактовки), иначе — десятые. null — подходящего значения нет.
 */
function keepStep(length: number, count: number): number | null {
  const lower = length / (count + 0.5);
  const upper = count > 1 ? length / (count - 0.5) : Infinity;
  const whole = Math.max(2, Math.floor(lower) + 1);
  if (whole < upper) return whole;
  const tenth = Math.floor(lower * 10 + 1) / 10;
  return tenth < upper && tenth >= 2 ? tenth : null;
}

/**
 * Совет сохранить число планов части index без строк, если её отрезок станет from–to (после сдвига общей границы):
 * каркас разделит её на другое число планов, чем в реестре (was), и пересчёт снова откажет. Пусто — часть со строками,
 * число планов не меняется или значения нет.
 */
function keepAdvice(cut: ReturnType<typeof slicing>, index: number, from: number, to: number, was: number | undefined): string {
  const part = cut.parts[index];
  if (!part || was === undefined || cut.inside(from, to).length || cut.emptyCount(index, from, to) === was) return '';
  const value = keepStep(cut.length(from, to), was);
  return value === null ? '' : scenarioTexts.notice.boundsFix.keepCount({ part: part.title || part.id, value: seconds(value, 1), count: was });
}

/**
 * Причина и совет для части partId, где каркас дал другое число планов. Повторяет нарезку каркаса: в часть попадают
 * строки, середина которых внутри неё; пауза до первой или после последней строки от 2,5 с становится отдельным
 * планом; часть без строк делится по «Макс. план». Если у края пауз нет, причина — сами строки части. Совет называет
 * конкретное значение «Макс. план, с», когда от него зависит число планов этой или соседней части без строк.
 */
function countCause(partId: string, source: SceneBoundsSource, fps: number, was: Map<string, number>): { cause?: string; fix: string } | null {
  const cut = slicing(source, fps);
  const index = cut.parts.findIndex((part) => part.id === partId);
  if (index < 0) return null;
  const part = cut.parts[index];
  const end = cut.end(index);
  const inside = cut.inside(part.start, end);
  const texts = scenarioTexts.notice;
  if (!inside.length) {
    const value = keepStep(cut.length(part.start, end), was.get(partId) ?? 0);
    return {
      cause: texts.boundsCause.noLines({ length: seconds(end - part.start, 1), max: seconds(part.max_shot_seconds ?? DEFAULT_MAX_SHOT) }),
      fix: value === null ? texts.boundsFix.maxShot : texts.boundsFix.maxShotValue({ value: seconds(value, 1), count: was.get(partId) ?? 0 })
    };
  }
  const first = inside[0];
  const last = inside[inside.length - 1];
  const gap = cut.frame(GAP_SECONDS);
  if (cut.frame(first.start) - cut.frame(part.start) >= gap) {
    // Сдвиг начала удлиняет предыдущую часть: без строк она может разделиться на другое число планов.
    const previous = cut.parts[index - 1];
    return {
      cause: texts.boundsCause.leadPause({ seconds: seconds(first.start - part.start, 1), line: first.source_line }),
      fix:
        texts.boundsFix.moveStart({ at: seconds(first.start) }) +
        (previous ? keepAdvice(cut, index - 1, previous.start, first.start, was.get(previous.id)) : '')
    };
  }
  if (cut.frame(end) - cut.frame(last.end) >= gap && index + 1 < cut.parts.length) {
    const next = cut.parts[index + 1];
    return {
      cause: texts.boundsCause.trailPause({ seconds: seconds(end - last.end, 1), line: last.source_line }),
      fix: texts.boundsFix.moveEnd({ at: seconds(last.end) }) + keepAdvice(cut, index + 1, last.end, cut.end(index + 1), was.get(next.id))
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
      // После совета строка вернётся в часть from, а часть to сожмётся до строки: без строк она может разделиться на
      // другое число планов, и пересчёт отказал бы снова. Значение «Макс. план, с» для неё называется сразу.
      const cut = slicing(source, scaffold.fps);
      const toIndex = cut.parts.findIndex((part) => part.id === to);
      const keep =
        toIndex < 0
          ? ''
          : earlier
            ? keepAdvice(cut, toIndex, cut.parts[toIndex].start, line.start, partCounts(current.scenes).get(to))
            : keepAdvice(cut, toIndex, line.end, cut.end(toIndex), partCounts(current.scenes).get(to));
      return notice.boundsLineMoved({
        line: line.source_line,
        text,
        start: seconds(line.start),
        end: seconds(line.end),
        to: title(to),
        from: title(from),
        fix:
          (earlier
            ? notice.boundsFix.movePartStart({ part: title(from), at: seconds(line.start) })
            : notice.boundsFix.movePartEnd({ part: title(from), at: seconds(line.end) })) + keep
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
    const explained = countCause(differing, source, scaffold.fps, was) ?? { fix: scenarioTexts.notice.boundsFix.lines };
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
