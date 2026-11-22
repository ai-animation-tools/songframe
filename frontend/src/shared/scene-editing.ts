import type { LyricsLine, SceneShot, StateDelta, StateFrom, TimingLine } from './types';

/**
 * Объединение и деление планов в черновике сценария. Коды планов не перенумеровываются: к коду привязаны принятые
 * видео (`assets/shots/<код>`), попытки (`plan/batches/<код>-attempt-NN`), статусы производства и отчёты, которые
 * лежат вне `scenes.json` и при сдвиге кодов достались бы чужим планам. Объединённый план сохраняет код первого,
 * коды остальных исчезают; новая половина при делении получает свободный код с номером через точку.
 */

/** Наименьшая длина каждой половины при делении и плана у сдвигаемой границы, кадров. */
export const MIN_SHOT_FRAMES = 15;

/** Разделитель строк песни в `original` объединённого плана и склеенных текстов постановки. */
export const JOIN_SEPARATOR = ' / ';

/**
 * Пометка незаполненного места постановки — та же, что у заготовок каркаса (`internal/scenescaffold`). Проверка
 * готовности сценария (`internal/scenarioworkflow`) ищет её в любом регистре и держит план незаполненным, пока
 * пометка есть; агент доработки получает задание заполнить постановку без неё. Объединение и деление ставят её
 * в поля, которые автор должен свести или разделить сам, оставляя прежний текст после пояснения.
 */
// eslint-disable-next-line no-restricted-syntax -- Маркер в данных проекта, а не подпись интерфейса.
export const FILL_MARKER = 'ЗАПОЛНИТЬ';

/** Поля постановки, которые проверка готовности требует заполненными. */
const STAGING_FIELDS = ['camera', 'action', 'continuity'] as const;

/** Текстовые поля плана, в которых ищется пометка. */
const MARKED_FIELDS = ['original', 'title', ...STAGING_FIELDS, 'notes'] as const;

/** Пометка в тексте, в любом регистре — как в проверке готовности. */
export function hasFillMarker(text: string | undefined): boolean {
  return (text ?? '').toLocaleUpperCase('ru').includes(FILL_MARKER);
}

/** План незаполнен: пустое поле постановки или пометка в тексте — те же условия, что у проверки готовности. */
export function shotUnfilled(shot: SceneShot): boolean {
  return STAGING_FIELDS.some((key) => !shot[key].trim()) || MARKED_FIELDS.some((key) => hasFillMarker(shot[key]));
}

/* eslint-disable no-restricted-syntax -- Пояснения пометки записываются в данные проекта и читаются агентом доработки. */
const MERGE_NOTE = `${FILL_MARKER}: свести в одну постановку — `;
const splitNote = (first: string, second: string): string => `${FILL_MARKER}: разделить между ${first} и ${second} — `;
const EDIT_NOTE = new RegExp(`^${FILL_MARKER}: (свести в одну постановку|разделить между \\S+ и \\S+) — `);
/* eslint-enable no-restricted-syntax */

/** Текст без пояснения, поставленного прежним объединением или делением: пометки не вкладываются друг в друга. */
function withoutEditNote(text: string): string {
  return text.replace(EDIT_NOTE, '');
}

/** Свободный код для новой половины плана id: базовый код с первым незанятым номером через точку (M23 → M23.1, M23.2…). */
export function nextShotId(list: readonly SceneShot[], id: string): string {
  const base = id.split('.')[0];
  const used = new Set(list.map((shot) => shot.id));
  for (let number = 1; ; number += 1) {
    const candidate = `${base}.${number}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Строки разметки внутри окна плана: середина строки на сетке кадров попадает в окно, как при нарезке каркаса. */
export function linesInside(shot: SceneShot, lines: readonly TimingLine[], fps: number): TimingLine[] {
  return [...lines]
    .sort((a, b) => a.start - b.start)
    .filter((line) => {
      const middle = Math.round(((line.start + line.end) / 2) * fps);
      return shot.start_frame <= middle && middle < shot.end_frame_exclusive;
    });
}

/** Где и как делится план: кадр начала второй половины и строки песни каждой половины. */
export interface SplitPlan {
  at: number;
  /** Деление идёт по началу строки песни; false — посередине окна (строк внутри меньше двух). */
  byLine: boolean;
  first: string;
  second: string;
}

/**
 * Точка деления плана: начало строки песни внутри окна, ближайшее к середине и не ближе MIN_SHOT_FRAMES к краям;
 * без такой строки — середина окна. Строки песни делятся между половинами, если `original` состоит из строк окна;
 * иначе (инструментал, ручной текст) обе половины сохраняют прежний текст. null — план слишком короткий.
 */
export function splitPlan(shot: SceneShot, lines: readonly TimingLine[], lyrics: readonly LyricsLine[], fps: number): SplitPlan | null {
  const { start_frame: start, end_frame_exclusive: end } = shot;
  if (end - start < MIN_SHOT_FRAMES * 2) return null;
  const middle = Math.round((start + end) / 2);
  const inside = linesInside(shot, lines, fps);
  const boundaries = inside
    .slice(1)
    .map((line, index) => ({ at: Math.round(line.start * fps), index: index + 1 }))
    .filter(({ at }) => at - start >= MIN_SHOT_FRAMES && end - at >= MIN_SHOT_FRAMES)
    .sort((a, b) => Math.abs(a.at - middle) - Math.abs(b.at - middle));
  const best = boundaries[0];
  if (!best) return { at: middle, byLine: false, first: shot.original, second: shot.original };
  const texts = inside.map((line) => lyrics.find((item) => item.number === line.source_line)?.text ?? '');
  const own = shot.original.split(JOIN_SEPARATOR).map((part) => part.trim());
  // Строки делятся, только если текст плана — ровно строки его окна; ручной текст остаётся у обеих половин.
  const matches = own.length === texts.length && own.every((part, index) => part === texts[index].trim());
  return {
    at: best.at,
    byLine: true,
    first: matches ? texts.slice(0, best.index).join(JOIN_SEPARATOR) : shot.original,
    second: matches ? texts.slice(best.index).join(JOIN_SEPARATOR) : shot.original
  };
}

/**
 * Делит план index по плану деления: первая половина сохраняет код, постановку и все изменения состояния, вторая
 * получает свободный код, ту же постановку и продолжает итог первой половины без своих изменений. Действие
 * и непрерывность обеих половин получают пометку FILL_MARKER: их автор делит сам. Так первый кадр,
 * итог и фаза `same` прежнего кода остаются прежними: ссылки других планов не переписываются, и ни постановка,
 * ни состояние последующих планов (а значит, их отпечатки приёмки) не меняются. Если изменение состояния происходит
 * во второй половине, автор переносит его вручную. Возвращает новый список и код второй половины.
 */
export function splitShot(list: readonly SceneShot[], index: number, plan: SplitPlan): { scenes: SceneShot[]; id: string } {
  const shot = list[index];
  const id = nextShotId(list, shot.id);
  // Действие и непрерывность у половин разные по смыслу: обе получают пометку разделить их вручную.
  const marked = (text: string): string => (text.trim() ? splitNote(shot.id, id) + withoutEditNote(text) : text);
  const staging = { action: marked(shot.action), continuity: marked(shot.continuity) };
  const first: SceneShot = { ...shot, ...staging, end_frame_exclusive: plan.at, original: plan.first };
  const second: SceneShot = {
    ...shot,
    ...staging,
    id,
    start_frame: plan.at,
    original: plan.second,
    state_from: shot.id,
    state_changes: {}
  };
  const scenes = [...list];
  scenes.splice(index, 1, first, second);
  return { scenes, id };
}

/** Непустые различные тексты по порядку без прежних пояснений пометки. */
function distinctTexts(values: readonly (string | undefined)[]): string[] {
  const seen: string[] = [];
  for (const value of values) {
    const text = withoutEditNote(value?.trim() ?? '');
    if (text && !seen.includes(text)) seen.push(text);
  }
  return seen;
}

/** Непустые различные тексты по порядку, склеенные разделителем. */
function joinTexts(values: readonly (string | undefined)[]): string {
  return distinctTexts(values).join(JOIN_SEPARATOR);
}

/** Склейка поля постановки: два и больше разных текста получают пометку свести их в один. */
function joinStaging(values: readonly string[]): string {
  const texts = distinctTexts(values);
  return texts.length > 1 ? MERGE_NOTE + texts.join(JOIN_SEPARATOR) : (texts[0] ?? '');
}

/** Слияние изменений состояния по свойствам: поздние значения заменяют ранние того же свойства той же сущности. */
function mergeDeltas(deltas: readonly (StateDelta | undefined)[]): StateDelta | undefined {
  const result: StateDelta = {};
  for (const delta of deltas) {
    for (const [entity, values] of Object.entries(delta ?? {})) result[entity] = { ...(result[entity] ?? {}), ...values };
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * Объединяет план index с count следующими. Окно — от начала первого до конца последнего; строки песни, название
 * и заметки склеиваются по порядку, разные камера, действие и непрерывность склеиваются с пометкой FILL_MARKER,
 * чтобы ничего не потерялось и план оставался незаполненным, пока автор не сведёт их; референсы объединяются, липсинк включён, если он был хоть у одного. Состояние
 * первого кадра — от первого плана, итог — изменения всех планов по порядку (первые кадры и итоги последующих),
 * слитые по свойствам. Код первого плана сохраняется, ссылки остальных планов на исчезнувшие коды переходят к нему.
 */
export function mergeShots(list: readonly SceneShot[], index: number, count: number): SceneShot[] {
  const group = list.slice(index, index + count + 1);
  if (group.length < 2) return [...list];
  const [first] = group;
  const last = group[group.length - 1];
  const removed = new Set(group.slice(1).map((shot) => shot.id));
  const references = [...new Set(group.flatMap((shot) => shot.references).filter((id) => id !== '—'))];
  const after = mergeDeltas([first.state_changes.after, ...group.slice(1).flatMap((shot) => [shot.state_changes.before, shot.state_changes.after])]);
  const title = joinTexts(group.map((shot) => shot.title));
  const notes = joinTexts(group.map((shot) => shot.notes));
  const merged: SceneShot = {
    ...first,
    end_frame_exclusive: last.end_frame_exclusive,
    original: joinTexts(group.map((shot) => shot.original)),
    camera: joinStaging(group.map((shot) => shot.camera)),
    action: joinStaging(group.map((shot) => shot.action)),
    continuity: joinStaging(group.map((shot) => shot.continuity)),
    references: references.length ? references : ['—'],
    lipsync: group.some((shot) => shot.lipsync),
    state_changes: { ...(first.state_changes.before ? { before: first.state_changes.before } : {}), ...(after ? { after } : {}) }
  };
  // Статичным объединённый план остаётся, только если статичны все части и липсинка нет.
  if (group.every((shot) => shot.static_shot) && !merged.lipsync) merged.static_shot = true;
  else delete merged.static_shot;
  if (title) merged.title = title;
  else delete merged.title;
  if (notes) merged.notes = notes;
  else delete merged.notes;
  // Производный план не может ссылаться на материал, ставший его же частью.
  if (merged.derived_from && (merged.derived_from.shot === first.id || removed.has(merged.derived_from.shot))) delete merged.derived_from;
  const target = (id: string): string => (removed.has(id) ? first.id : id);
  const remap = (from: StateFrom): StateFrom => (typeof from === 'string' ? target(from) : from ? { ...from, scene: target(from.scene) } : from);
  const rest = list.map((shot) => ({
    ...shot,
    state_from: remap(shot.state_from),
    ...(shot.derived_from ? { derived_from: { shot: target(shot.derived_from.shot) } } : {})
  }));
  return [...rest.slice(0, index), merged, ...rest.slice(index + count + 1)];
}
