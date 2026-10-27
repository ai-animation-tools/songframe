import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzeLyrics } from '@shared/lyrics';
import { TrackSection } from './components/TrackSection';
import { CoverSection } from './components/CoverSection';
import { LyricsSection } from './components/LyricsSection';
import { IdeaSection } from './components/IdeaSection';
import { ReferenceEditor } from './components/ReferenceEditor';
import type { AiAccess } from '@shared/ai-access';
import { COVER_AGENT_REQUIRED } from '@shared/cover-generation';

const aiState = vi.hoisted(() => ({ agentProvider: null as 'claude' | 'codex' | null, aiAccess: null as AiAccess | null }));
vi.mock('../../state', () => ({ useApp: () => ({ notify: vi.fn(), describeError: String, ...aiState }) }));

/** Области выбора доступны клавиатуре, а поля текста остаются отдельными редакторами. */
describe('загрузка исходников', () => {
  it('не разрешает генерацию обложки с невыбранным агентом', () => {
    aiState.agentProvider = null;
    aiState.aiAccess = null;
    const html = renderToStaticMarkup(
      createElement(CoverSection, { coverSrc: null, onPick: vi.fn(), onRemove: vi.fn(), onDrop: vi.fn(), onGenerate: vi.fn() })
    );
    const label = html.indexOf('Сгенерировать');
    expect(html.slice(html.lastIndexOf('<button', label), label)).toContain('disabled=""');
    expect(html).toContain(COVER_AGENT_REQUIRED);
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
      .map((element) => renderToStaticMarkup(element))
      .join('');
    for (const label of ['Загрузка трека', 'Загрузка обложки', 'Загрузить текст песни из файла', 'Загрузить идею клипа из файла']) {
      expect(html).toContain(`role="button" aria-label="${label}" tabindex="0"`);
    }
    expect(html).not.toContain('aria-label="Текст песни: перетащить файл в поле"');
    expect(html).not.toContain('aria-label="Идея клипа: перетащить файл в поле"');
    expect(html).toContain('Идея клипа</label>');
    expect(html).not.toContain('Из файла</button>');
    expect(html).not.toContain('Выбрать MP3</button>');
  });

  it('оставляет описание референса обычным полем и сохраняет загрузку изображений', () => {
    const html = renderToStaticMarkup(
      createElement(ReferenceEditor, {
        reference: { key: 1, id: 'hero', kind: 'character', name: 'Герой', short_name: '', description: '', prompt: '', files: [] },
        kinds: [],
        fileUrl: String,
        onUpdate: vi.fn(),
        onRetryFilePrompt: vi.fn(),
        onRemove: vi.fn(),
        onAddFiles: vi.fn(),
        onDropFiles: vi.fn(),
        onUpdateFile: vi.fn(),
        onRemoveFile: vi.fn()
      })
    );
    expect(html).toContain('Общее описание сущности');
    expect(html).not.toContain('Загрузка описания референса');
    expect(html).toContain('Выбрать изображения референса Герой');
  });

  it('показывает удаление обложки на изображении отдельным действием от загрузки', () => {
    const html = renderToStaticMarkup(
      createElement(CoverSection, { coverSrc: 'cover.png', onPick: vi.fn(), onRemove: vi.fn(), onDrop: vi.fn(), onGenerate: vi.fn() })
    );
    expect(html).toContain('aria-label="Убрать обложку"');
    expect(html).toContain('data-testid="CloseIcon"');
    expect(html).toContain('aria-label="Загрузка обложки"');
  });
});
