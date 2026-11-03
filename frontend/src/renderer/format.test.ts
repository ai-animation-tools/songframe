import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatBytes, formatDateTime, formatDuration } from './format';
import { DateTime } from './components/DateTime';

describe('дата и время для человека', () => {
  // Дата строится из локальных компонентов, поэтому результат не зависит от часового пояса машины.
  const moment = new Date(2026, 9, 28, 11, 20, 30);

  it('пишет месяц словом в родительном падеже и время с секундами', () => {
    expect(formatDateTime(moment)).toBe('28 октября 2026 11:20:30');
    expect(formatDateTime(new Date(2026, 0, 3, 7, 5, 9))).toBe('3 января 2026 07:05:09');
  });

  it('принимает ISO и миллисекунды, неразборчивое значение оставляет как есть', () => {
    expect(formatDateTime(moment.toISOString())).toBe('28 октября 2026 11:20:30');
    expect(formatDateTime(moment.getTime())).toBe('28 октября 2026 11:20:30');
    expect(formatDateTime('не дата')).toBe('не дата');
    expect(formatDateTime('')).toBe('');
  });

  it('компонент хранит машинное значение в time', () => {
    expect(renderToStaticMarkup(createElement(DateTime, { value: moment.toISOString() }))).toBe(
      `<time dateTime="${moment.toISOString()}">28 октября 2026 11:20:30</time>`
    );
  });
});

// Значения фиксируют прежние единицы и округление по обе стороны границ размера.
describe('форматирование размера и длительности', () => {
  it.each([
    [0, '0 Б'],
    [1, '1 Б'],
    [1023, '1023 Б'],
    [1024, '1.0 КБ'],
    [1536, '1.5 КБ'],
    [1048575, '1024.0 КБ'],
    [1048576, '1.0 МБ'],
    [-1, '-1 Б'],
    [0.5, '0.5 Б']
  ] as const)('сохраняет размер %s', (bytes, expected) => expect(formatBytes(bytes)).toBe(expected));

  it.each([null, NaN, Infinity, -Infinity])('объясняет неопределённую длительность %s', (value) => {
    expect(formatDuration(value)).toBe('длительность не определена');
  });
});
