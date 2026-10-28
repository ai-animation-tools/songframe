import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from './format';
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
