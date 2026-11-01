import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { analyzeLyrics } from '@shared/lyrics';
import { TrackSection } from './components/TrackSection';
import { CoverSection } from './components/CoverSection';
import { LyricsSection } from './components/LyricsSection';
import { IdeaSection } from './components/IdeaSection';
import { ReferenceEditor } from './components/ReferenceEditor';
import type { AiAccess } from '@shared/ai-access';

const aiState = vi.hoisted(() => ({ agentProvider: null as 'claude' | 'codex' | null, aiAccess: null as AiAccess | null }));
vi.mock('../../state', () => ({ useApp: () => ({ notify: vi.fn(), describeError: String, online: true, ...aiState }) }));

/** Области выбора доступны клавиатуре, а поля текста остаются отдельными редакторами. */
describe('загрузка исходников', () => {
  // Причина недоступности ИИ показывается общим AiProblemAlert с переходом в настройки, ему нужен маршрутизатор.
  const routed = (element: ReturnType<typeof createElement>): string => renderToStaticMarkup(createElement(MemoryRouter, null, element));
  const cover = (): string => routed(createElement(CoverSection, { coverSrc: null, onPick: vi.fn(), onRemove: vi.fn(), onDrop: vi.fn(), onGenerate: vi.fn() }));
  const generateDisabled = (html: string): boolean => {
    const label = html.indexOf('Сгенерировать обложку');
    return html.slice(html.lastIndexOf('<button', label), label).includes('disabled=""');
  };

  it('не разрешает генерацию обложки до проверки и без провайдера изображений', () => {
    aiState.agentProvider = 'codex';
    aiState.aiAccess = null;
    expect(generateDisabled(cover())).toBe(true);
    aiState.aiAccess = {
      agent: { provider: 'codex', selected: true, available: true, message: '' },
      image: { provider: null, selected: false, available: false, message: 'Сначала выберите провайдера изображений в настройках проекта.' },
      video: { provider: null, selected: false, available: false, message: '' }
    };
    const html = cover();
    expect(generateDisabled(html)).toBe(true);
    expect(html).toContain('Сначала выберите провайдера изображений');
    expect(html).toContain('Настройки проекта');
  });

  it('разрешает генерацию обложки без выбранного агента при доступном провайдере изображений', () => {
    aiState.agentProvider = null;
    aiState.aiAccess = {
      agent: { provider: null, selected: false, available: false, message: 'Сначала выберите агента в настройках приложения.' },
      image: { provider: 'codex', selected: true, available: true, message: '' },
      video: { provider: null, selected: false, available: false, message: '' }
    };
    expect(generateDisabled(cover())).toBe(false);
  });

  it('предлагает четыре области выбора без отдельных кнопок импорта', () => {
    const pick = vi.fn();
    const drop = vi.fn();
    const html = [
      createElement(TrackSection, { track: null, trackNew: null, fileUrl: String, onPick: pick, onClear: vi.fn(), onDrop: drop }),
      createElement(CoverSection, { coverSrc: null, onPick: pick, onRemove: vi.fn(), onDrop: drop, onGenerate: vi.fn() }),
      createElement(LyricsSection, { lyrics: '', lyricsCheck: analyzeLyrics(''), onChange: vi.fn(), onPick: pick, onDrop: drop }),
      createElement(IdeaSection, { idea: '', onChange: vi.fn(), onPick: pick, onDrop: drop })
    ]
      .map((element) => routed(element))
      .join('');
    // Доступное имя повторяет весь видимый текст области, чтобы её находили по видимой подписи.
    for (const label of [
      'Загрузка трека. Перетащите MP3 или нажмите для выбора Один файл MP3.',
      'Загрузка обложки. Перетащите изображение или нажмите для выбора Одно изображение PNG, JPG или WebP.',
      'Загрузить текст песни из файла. Перетащите файл с текстом песни или нажмите для выбора Один файл TXT или MD в UTF-8.',
      'Загрузить идею клипа из файла. Перетащите файл с идеей или нажмите для выбора Один файл TXT или MD в UTF-8.'
    ]) {
      expect(html).toContain(`role="button" aria-label="${label}" tabindex="0"`);
    }
    expect(html).not.toContain('aria-label="Текст песни: перетащить файл в поле"');
    expect(html).not.toContain('aria-label="Идея клипа: перетащить файл в поле"');
    // Обязательное поле: после подписи MUI добавляет звёздочку.
    expect(html).toMatch(/Идея клипа<style[^>]*>[^<]*<\/style><span aria-hidden="true" class="MuiFormLabel-asterisk/);
    expect(html).not.toContain('Из файла</button>');
    expect(html).not.toContain('Выбрать MP3</button>');
  });

  it('оставляет описание референса обычным полем и сохраняет загрузку изображений', () => {
    const html = renderToStaticMarkup(
      createElement(ReferenceEditor, {
        reference: { key: 1, id: 'hero', kind: 'character', name: 'Герой', short_name: '', description: '', prompt: '', files: [] },
        kinds: [],
        duplicateId: false,
        fileUrl: String,
        onUpdate: vi.fn(),
        onRetryFilePrompt: vi.fn(),
        onRemove: vi.fn(),
        onGenerate: vi.fn(),
        onAddFiles: vi.fn(),
        onDropFiles: vi.fn(),
        onUpdateFile: vi.fn(),
        onRemoveFile: vi.fn()
      })
    );
    expect(html).toContain('Общее описание сущности');
    expect(html).not.toContain('Загрузка описания референса');
    expect(html).toContain('Выбрать изображения референса Герой');
    // Ошибки референса видны в самой карточке, а не только в общем списке страницы.
    expect(html).toContain('Добавьте хотя бы одно изображение.');
    expect(html).toContain('Выберите тип из списка');
  });

  it('показывает удаление обложки на изображении отдельным действием от загрузки', () => {
    const html = routed(createElement(CoverSection, { coverSrc: 'cover.png', onPick: vi.fn(), onRemove: vi.fn(), onDrop: vi.fn(), onGenerate: vi.fn() }));
    expect(html).toContain('aria-label="Убрать обложку"');
    expect(html).toContain('data-testid="CloseIcon"');
    expect(html).toContain('aria-label="Загрузка обложки. Перетащите изображение или нажмите для выбора Одно изображение PNG, JPG или WebP."');
  });
});
