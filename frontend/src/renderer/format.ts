/** Форматирование чисел и дат для интерфейса. */

import { commonTexts } from '@shared/texts/common';
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return commonTexts.format.bytes(bytes);
  if (bytes < 1024 * 1024) return commonTexts.format.kilobytes((bytes / 1024).toFixed(1));
  return commonTexts.format.megabytes((bytes / 1024 / 1024).toFixed(1));
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return commonTexts.format.unknownDuration;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

// Месяц в родительном падеже даёт только формат вместе с днём; части собираются без «г.» и «в».
const DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

/** Дата и время для человека в локальном часовом поясе: «28 октября 2026 11:20:30». Неразборчивое значение возвращается как есть. */
export function formatDateTime(value: string | number | Date): string {
  if (value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const part = Object.fromEntries(DATE_TIME.formatToParts(date).map(({ type, value: text }) => [type, text]));
  return `${part.day} ${part.month} ${part.year} ${part.hour}:${part.minute}:${part.second}`;
}

/** Соединяет путь проекта с относительным путём внутри него; разделитель берётся из пути проекта. */
export function joinPath(base: string, ...parts: string[]): string {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts.map((p) => p.replace(/^[\\/]+/, ''))].join(separator);
}

/** Время трека как м:сс.сс для таблиц и подписей. */
export function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}
