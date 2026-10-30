/** Ожидания независимы от словаря: первый перенос сохраняет фразы, числа и служебные поля. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { timingTexts } from '@shared/texts/timing';
import { LinkedText } from '../../components/LinkedText';
import { TimingLinesTable } from './components/TimingLinesTable';
import { UnassignedLyrics } from './components/UnassignedLyrics';
import { emptyTiming } from './timing';

const numbers = [
  [0, '0', '0.00'],
  [1, '1', '1.00'],
  [2, '2', '2.00'],
  [5, '5', '5.00'],
  [11, '11', '11.00'],
  [21, '21', '21.00'],
  [-2, '-2', '-2.00'],
  [1.5, '1.5', '1.50']
] as const;

describe('целые фразы разметки', () => {
  it.each(numbers)('сохраняет прежнюю грамматику числа %s', (value, written, fixed) => {
    expect(timingTexts.missingSourceLine({ line: value })).toBe(`(строка ${written} отсутствует)`);
    expect(timingTexts.exitCode({ code: value })).toBe(`код ${written}`);
    expect(timingTexts.lineStart({ id: value })).toBe(`Начало строки ${written}`);
    expect(timingTexts.lineEnd({ id: value })).toBe(`Конец строки ${written}`);
    expect(timingTexts.verifyLine({ id: value })).toBe(`Подтвердить на слух строку ${written}`);
    expect(timingTexts.lineNote({ id: value })).toBe(`Примечание к строке ${written}`);
    expect(timingTexts.removeLine({ id: value })).toBe(`Убрать строку ${written} из разметки`);
    expect(timingTexts.verifiedCount({ verified: value, total: 21 })).toBe(`подтверждено ${written} из 21`);
    expect(timingTexts.addLine({ line: value })).toBe(`Добавить строку ${written}`);
    expect(timingTexts.unassignedTitle({ count: value })).toBe(`Строки текста без оценки (${written})`);
    expect(timingTexts.volumePercent({ value })).toBe(`${written}%`);
    expect(timingTexts.invalidBoundary({ min: value, max: Infinity })).toBe(`От ${fixed} с. Граница не изменена.`);
    expect(timingTexts.invalidBoundary({ min: 0, max: value })).toBe(`От 0.00 до ${fixed} с. Граница не изменена.`);
    expect(timingTexts.sectionsHelp({ count: value })).toBe(
      `Секций: ${written}. Секции песни сохраняются отдельно от границ строк; «Пересчитать секции» заменяет их границы, названия и заметки по текущей разметке.`
    );
  });

  it('сохраняет видимую диагностику, пути и пробелы условий', () => {
    expect(timingTexts.exitCode({ code: null })).toBe('код null');
    expect(timingTexts.sourceProblems({ trackMissing: true, problems: ['«Текст» <ошибка>', 'C:\\Клип\\track.mp3'] })).toBe(
      'Сначала добавьте трек на странице «Исходники». «Текст» <ошибка> C:\\Клип\\track.mp3'
    );
    expect(timingTexts.sourceProblems({ trackMissing: false, problems: [] })).toBe('');
    expect(timingTexts.recommendationFailed({ reason: '<CUDA> & «драйвер»' })).toBe('Не удалось получить рекомендацию: <CUDA> & «драйвер»');
    expect(timingTexts.downloadRefreshFailed({ reason: 'C:\\Модели\\<файл>' })).toBe('Не удалось обновить загрузку: C:\\Модели\\<файл>');
    expect(timingTexts.removeLineDescription({ text: '«А» <script>&' })).toBe(
      'Будут удалены временные границы и заметка строки ««А» <script>&». Исходный текст песни сохранится.'
    );
    expect(timingTexts.fileStatus({ status: '0 строк; «черновик»' })).toBe('В файле: 0 строк; «черновик»');
    expect(timingTexts.totalDuration({ duration: '1:03' })).toBe('из 1:03');
  });

  it('сохраняет информацию об установленной и ещё не скачанной модели', () => {
    expect(timingTexts.modelDirectory({ installed: false, size: 'около 1,5 ГБ', directory: 'C:\\Модели\\A & Б' })).toBe(
      'Размер загрузки: около 1,5 ГБ. Папка: C:\\Модели\\A & Б'
    );
    expect(timingTexts.modelDirectory({ installed: true, size: 'около 1,5 ГБ', directory: '/модель «А»' })).toBe('Папка: /модель «А»');
    expect(timingTexts.modelInstalled({ model: 'medium', selected: true })).toBe('Модель medium установлена. Выбрана для распознавания.');
    expect(timingTexts.modelInstalled({ model: 'medium', selected: false })).toBe('Модель medium установлена.');
    expect(timingTexts.modelOption({ model: 'medium', size: 'около 1,5 ГБ', recommended: true })).toBe('medium — около 1,5 ГБ (рекомендуется)');
    expect(timingTexts.modelOption({ model: 'small', size: 'около 0,5 ГБ', recommended: false })).toBe('small — около 0,5 ГБ');
    expect(timingTexts.hardwareSummary({ cpuName: 'CPU «А»', ramGiB: '16.0', gpuName: null, vramGiB: '' })).toBe('CPU «А»; RAM 16.0 ГБ.');
    expect(timingTexts.hardwareSummary({ cpuName: 'CPU «А»', ramGiB: '16.0', gpuName: 'GPU <А>', vramGiB: '8.0' })).toBe(
      'CPU «А»; RAM 16.0 ГБ. NVIDIA: GPU <А>, 8.0 ГБ видеопамяти.'
    );
  });

  it('не переносит сохраняемые статус и описание времени в UI-словарь', () => {
    expect(emptyTiming(null)).toEqual({
      version: 2,
      status: 'Разметка вручную; подтверждено на слух 0 из 0 строк.',
      source: 'source/track.mp3',
      sha256: null,
      duration_decoded: null,
      duration_container: null,
      clock: 'Секунды от начала декодированного звука, не SMPTE',
      lines: [],
      sections: []
    });
  });
});

describe('разметка текста в таблице и ссылках', () => {
  it('сохраняет подсказку строки и рендерит непустую таблицу без конфликта title', () => {
    const line = { id: 1, source_line: 1, start: 0, end: 2 };
    const callbacks = { onSelect: vi.fn(), onUpdate: vi.fn(), onPlay: vi.fn(), onRemove: vi.fn() };
    // MUI сообщает именно о title дочерней кнопки; допустимый title Tooltip не запрещаем.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const html = renderToStaticMarkup(
        createElement(TimingLinesTable, { lines: [line], selected: 1, duration: 3, textOf: () => 'Строка песни', ...callbacks })
      );
      expect(html).toContain('Строка песни');
      expect(html).toContain('aria-label="Воспроизвести строку"');
      expect(error.mock.calls.filter((args) => args.some((value) => String(value).includes('`title` prop to the child of <Tooltip />')))).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it('показывает прежние заголовки и пустое состояние', () => {
    const html = renderToStaticMarkup(
      createElement(TimingLinesTable, {
        lines: [],
        selected: null,
        duration: 0,
        textOf: () => '',
        onSelect: vi.fn(),
        onUpdate: vi.fn(),
        onPlay: vi.fn(),
        onRemove: vi.fn()
      })
    );
    for (const text of [
      '№',
      'Строка',
      'Начало',
      'Конец',
      'Длит.',
      'Слух',
      'Примечание',
      'Разметки ещё нет. Нажмите «Разметить» или добавляйте строки из списка ниже на позиции плейхеда.'
    ]) {
      expect(html).toContain(text);
    }
  });

  it('сохраняет единый заголовок неразмеченных строк и экранирует песню', () => {
    const html = renderToStaticMarkup(createElement(UnassignedLyrics, { lyrics: [{ number: 0, text: '<script>& «А»', header: false }], onAdd: vi.fn() }));
    expect(html).toContain('Строки текста без оценки (1)');
    expect(html).toContain('aria-label="Добавить строку 0"');
    expect(html).toContain('&lt;script&gt;&amp; «А»');
    expect(html).not.toContain('<script>');
  });

  it('сохраняет маршрут ссылки на исходники', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(LinkedText, { text: timingTexts.addTrack })));
    expect(html).toContain('href="/project/sources"');
    expect(html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, '')).toBe('Сначала добавьте трек на странице «Исходники».');
  });
});
