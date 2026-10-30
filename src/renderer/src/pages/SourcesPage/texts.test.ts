import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzeLyrics } from '@shared/lyrics';
import { sourcesTexts } from '@shared/texts/sources';
import { LyricsSection } from './components/LyricsSection';
import { CoverCropEditor } from './components/CoverCropEditor';
import { ReferencePromptError } from './components/ReferencePromptError';
import { ReferenceFileCard } from './components/ReferenceFileCard';

vi.mock('../../state', () => ({ useApp: () => ({ notify: vi.fn(), describeError: String }) }));

/** Ожидания независимы от каталога: перенос сохраняет целые фразы, прежнюю грамматику и безопасный JSX. */
describe('тексты исходников', () => {
  it.each([0, 1, 2, 5, 11, 21, -2, 1.5])('сохраняет числовые подписи для %s', (value) => {
    expect(sourcesTexts.lyricsStatistics({ lines: value, sections: value })).toBe(
      `Сейчас: ${value} строк песни, секций: ${value}. Пустые строки между секциями необязательны. Файл — TXT или MD в UTF-8, без Markdown-заголовков и списков. Текст должен совпадать с исполнением.`
    );
    expect(sourcesTexts.formProblems({ count: value })).toBe(`Исправьте проблемы формы (${value}): список — в начале страницы, ошибки отмечены у полей.`);
    expect(sourcesTexts.problemCount({ count: value })).toBe(`Проблем: ${value}`);
    expect(sourcesTexts.cropSize({ size: value })).toBe(`Размер области: ${value} × ${value} пикселей`);
    expect(sourcesTexts.referenceImages({ kind: 'Герой', count: value })).toBe(`Герой · изображений: ${value}`);
  });

  it('сохраняет кавычки, пути и сообщения об ошибках без повторной интерпретации параметров', () => {
    const name = '«Герой» <tag> & {name}';
    expect(sourcesTexts.pickReferenceImages({ name })).toBe('Выбрать изображения референса «Герой» <tag> & {name}');
    expect(sourcesTexts.removeReference({ name })).toBe('Удалить референс ««Герой» <tag> & {name}»');
    expect(sourcesTexts.pickReferenceImages({ name: '' })).toBe('Выбрать изображения референса без названия');
    expect(sourcesTexts.removeReference({ name: '' })).toBe('Удалить референс «без названия»');
    expect(sourcesTexts.referenceImageAlt({ name: '', view: 'Вид' })).toBe('Референс — Вид');
    expect(sourcesTexts.referenceImageAlt({ name, view: 'Вид' })).toBe('«Герой» <tag> & {name} — Вид');
    expect(sourcesTexts.removeReferenceImage({ view: 'Вид' })).toBe('Удалить изображение: Вид');
    expect(sourcesTexts.removeKind({ label: name })).toBe('Удалить тип ««Герой» <tag> & {name}»');
    expect(sourcesTexts.kindInUse({ label: name })).toBe('Тип ««Герой» <tag> & {name}» используется референсами: сначала смените их тип.');
    expect(sourcesTexts.newTrack({ path: 'C:\\Музыка\\песня & <mix>.mp3' })).toBe('Новый: C:\\Музыка\\песня & <mix>.mp3');
    expect(sourcesTexts.promptReadError({ path: 'characters/«герой» & <x>.md' })).toBe(
      'Не удалось прочитать source/characters/«герой» & <x>.md. Верните файл и повторите чтение либо введите промпт заново.'
    );
    expect(sourcesTexts.coverRefreshError({ reason: 'ошибка <x> & {reason}' })).toBe(
      'Не удалось обновить состояние: ошибка <x> & {reason}. Проверка продолжится автоматически.'
    );
  });

  it('получает название провайдера параметром и сохраняет стоимость одного запроса', () => {
    expect(sourcesTexts.executorModel({ provider: 'Тестовый <provider>', model: 'model & 2' })).toBe('Исполнитель: Тестовый <provider> · Модель: model & 2');
    expect(sourcesTexts.executorModel({ provider: undefined, model: null })).toBe('Исполнитель:  · Модель: ');
    expect(sourcesTexts.generationCostLabel({ action: 'Ещё', credits: '5 кредитов' })).toBe('Ещё · 5 кредитов');
    expect(sourcesTexts.requestSha({ sha: 'abc<&>' })).toBe('SHA запроса: abc<&>');
    expect(sourcesTexts.confirmPaidRequest({ credits: '5 кредитов' })).toBe('Стоимость: 5 кредитов. Будет отправлен один запрос.');
    expect(sourcesTexts.confirmPaidRequest({ credits: 'неизвестно' })).toBe('Стоимость: неизвестно. Будет отправлен один запрос.');
    expect(sourcesTexts.confirmAccountGeneration({ provider: 'Тестовый' })).toBe('Генерация через Тестовый по условиям вашего аккаунта.');
    expect(sourcesTexts.confirmAccountGeneration({ provider: undefined })).toBe('Генерация через undefined по условиям вашего аккаунта.');
  });

  it('показывает статистику песни целой фразой без исправления формы единственного числа', () => {
    const html = renderToStaticMarkup(
      createElement(LyricsSection, {
        lyrics: '[Куплет]\nСтрока',
        lyricsCheck: analyzeLyrics('[Куплет]\nСтрока'),
        onChange: vi.fn(),
        onPick: vi.fn(),
        onDrop: vi.fn()
      })
    );
    expect(html).toContain(
      'Сейчас: 1 строк песни, секций: 1. Пустые строки между секциями необязательны. Файл — TXT или MD в UTF-8, без Markdown-заголовков и списков. Текст должен совпадать с исполнением.'
    );
    expect(html).toContain('aria-label="Загрузить текст песни из файла"');
    expect(html).toContain('[Куплет 1]\nпервая строка\nвторая строка\n\n[Припев]\n…');
  });

  it('экранирует путь ошибки и оставляет технические подробности рядом с повторным чтением', () => {
    const html = renderToStaticMarkup(createElement(ReferencePromptError, { error: { path: '<script>&.md', message: '<b>ошибка</b>' }, onRetry: vi.fn() }));
    expect(html).toContain('Не удалось прочитать source/&lt;script&gt;&amp;.md. Верните файл и повторите чтение либо введите промпт заново.');
    expect(html).toContain('Технические подробности');
    expect(html).toContain('Повторить чтение');
    expect(html).toContain('&lt;b&gt;ошибка&lt;/b&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<a ');
  });

  it('сохраняет доступное имя изображения и числовую подпись квадратной области', () => {
    vi.stubGlobal('window', { api: { shell: { fileUrl: (path: string) => path } } });
    try {
      const cropHtml = renderToStaticMarkup(
        createElement(CoverCropEditor, { image: { path: 'cover.png', width: 100, height: 100 }, crop: { x: 0, y: 0, size: 21 }, onCrop: vi.fn() })
      );
      expect(cropHtml).toContain('alt="Созданная обложка"');
      expect(cropHtml).toContain('aria-label="Квадратная область обложки"');
      expect(cropHtml).toContain('Размер области: 21 × 21 пикселей');
      expect(cropHtml).toContain('Перетащите квадрат и выберите его размер. Стрелки сдвигают область на 1 пиксель, Shift + стрелки — на 10.');
      const refHtml = renderToStaticMarkup(
        createElement(ReferenceFileCard, {
          file: { key: 1, sourcePath: 'image.png', view: 'full', note: '', prompt: '' },
          referenceName: '<Герой> & «имя»',
          fileUrl: String,
          onUpdate: vi.fn(),
          onRemove: vi.fn(),
          onRetryPrompt: vi.fn()
        })
      );
      expect(refHtml).toContain('alt="&lt;Герой&gt; &amp; «имя» — В полный рост"');
      expect(refHtml).toContain('aria-label="Удалить изображение: В полный рост"');
      expect(refHtml).toContain('новый файл');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
