/** Агент распознаёт копию MP3, возвращает свидетельства ASR и предложение без записи timing.json. */
import type { AgentJob } from './agents';
import type { TimingLine } from './types';

export interface TimingAgentSource {
  audioSha256: string;
  lyricsSha256: string;
  duration: number;
  lyrics: { number: number; text: string }[];
}
export interface TimingAgentReport {
  schemaVersion: 1;
  status: 'completed' | 'unsupported';
  audioSha256: string;
  lyricsSha256: string;
  engine: string | null;
  summary: string;
  segments: { start: number; end: number; text: string }[];
  matches: { sourceLine: number; start: number; end: number; segmentIndexes: number[]; note: string }[];
  unmatchedSourceLines: number[];
  limitations: string[];
}
export interface TimingAgentView {
  status: 'idle' | 'running' | 'completed' | 'unsupported' | 'failed' | 'cancelled';
  source: TimingAgentSource;
  prompt: string;
  context: string;
  job: AgentJob | null;
  report: TimingAgentReport | null;
  stale: boolean;
  error: string | null;
}
export interface TimingAgentApi {
  view(project: string): Promise<TimingAgentView>;
  start(project: string): Promise<TimingAgentView>;
  cancel(project: string): Promise<TimingAgentView>;
  /** Проверяет актуальность исходников перед переносом предложения в форму; файлов не пишет. */
  proposal(project: string, jobId: string): Promise<TimingAgentReport>;
}

/* eslint-disable no-restricted-syntax -- Инструкция и JSON-пример принадлежат протоколу распознавания, а не UI-подписям. */
export const TIMING_AGENT_PROMPT = `Распознай вокал из файла audio.path с помощью уже доступного тебе ASR-инструмента и предложи границы строк песни.
Файл MP3 будет в текущей рабочей папке; его байты не закодированы в тексте запроса. Сначала действительно обработай аудио инструментом ASR. Текст lyrics дан только для сопоставления после распознавания: он не является расшифровкой и не доказывает время звучания. Не используй прежнюю разметку, не угадывай длительности по длине строк или порядку слов.
Не запускай скрыто прежний align_lyrics или текущую слабую модель Whisper. Разрешены уже имеющиеся ASR-инструменты/модели с реальным чтением аудио. Не устанавливай программы, не скачивай модели, не ищи секреты и не отправляй платные запросы либо файлы в новый внешний сервис без отдельного разрешения. Если доступного разрешённого ASR нет, верни status="unsupported", engine=null, пустые segments/matches и все номера строк в unmatchedSourceLines; объясни причину в summary/limitations. Не изображай успешное распознавание.
Для успешного ответа укажи реальное имя ASR-инструмента и модели в engine, его распознанные сегменты с текстом и временем. В matches для каждой уверенно сопоставленной строки укажи физический номер sourceLine из lyrics, границы и индексы сегментов-свидетельств. Повторы припева сопоставляй разным номерам строк по реальному звучанию. Не сопоставленные строки перечисли отдельно; не сочиняй для них времена. Каждый номер lyrics должен встретиться ровно один раз: в matches либо unmatchedSourceLines.
Все времена — конечные числа в секундах от начала декодированного MP3, 0 <= start < end <= audio.duration. Границы matches должны лежать в пределах указанных ASR-сегментов. segmentIndexes — уникальные индексы segments с нуля. Строки не подтверждаются на слух агентом. Музыкальные секции, текст песни и файлы исходного проекта не меняй. Для временных файлов используй только текущую рабочую папку.
Верни ровно JSON без Markdown и без дополнительных ключей:
{"schemaVersion":1,"status":"completed","audioSha256":"из audio.sha256","lyricsSha256":"из lyricsSha256","engine":"имя инструмента и модели","summary":"итог","segments":[{"start":12.0,"end":16.0,"text":"действительно распознанные слова"}],"matches":[{"sourceLine":2,"start":12.0,"end":16.0,"segmentIndexes":[0],"note":"сомнения и отличия от исходного текста"}],"unmatchedSourceLines":[],"limitations":["ограничения и сомнения"]}`;
/* eslint-enable no-restricted-syntax */

export function timingAgentContext(source: TimingAgentSource): string {
  return JSON.stringify(
    { audio: { path: 'track.mp3', sha256: source.audioSha256, duration: source.duration }, lyricsSha256: source.lyricsSha256, lyrics: source.lyrics },
    null,
    2
  );
}

/** Явный перенос затрагивает только найденные неподтверждённые строки; остальные правки и секции остаются. */
export function mergeTimingAgentReport(
  lines: TimingLine[],
  report: TimingAgentReport,
  source: TimingAgentSource
): { lines: TimingLine[]; appliedIds: number[] } {
  const next = lines.map((line) => ({ ...line }));
  const appliedIds: number[] = [];
  let id = Math.max(0, ...next.map((line) => line.id));
  for (const match of report.matches) {
    const text = source.lyrics.find((line) => line.number === match.sourceLine)?.text;
    if (!text || next.some((line) => line.source_line === match.sourceLine && line.verified)) continue;
    const existing = next.find((line) => line.source_line === match.sourceLine);
    const value: TimingLine = {
      ...(existing ?? { id: ++id }),
      source_line: match.sourceLine,
      start: match.start,
      end: match.end,
      verified: false,
      note: existing?.note?.trim() ? existing.note : match.note
    };
    if (existing) next[next.indexOf(existing)] = value;
    else next.push(value);
    appliedIds.push(value.id);
  }
  return { lines: next, appliedIds };
}
