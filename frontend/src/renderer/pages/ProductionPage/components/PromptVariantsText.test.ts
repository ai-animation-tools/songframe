/** Видеопромпт с переводом показывает оба варианта переключателем; без перевода — один текст без переключателя. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { productionTexts } from '@shared/texts/production';
import { PromptVariantsText, promptVariantText } from './PromptVariantsText';

const variants = { original: 'Camera pushes in.', translation: 'Камера приближается.' };
const title = (characters: number): string => `Видеопромпт · ${characters}`;

describe('Варианты видеопромпта', () => {
  it('текст варианта: оригинал, перевод или единственный текст', () => {
    expect(promptVariantText('один', variants, 'translation')).toBe(variants.translation);
    expect(promptVariantText('один', variants, 'original')).toBe(variants.original);
    expect(promptVariantText('один', undefined, 'translation')).toBe('один');
  });

  it('с переводом — переключатель, по умолчанию оригинал, счёт символов показанного', () => {
    const html = renderToStaticMarkup(createElement(PromptVariantsText, { text: variants.original, variants, title }));
    expect(html).toContain(`aria-label="${productionTexts.promptVariants.view}"`);
    expect(html).toContain(variants.original);
    expect(html).not.toContain(variants.translation);
    expect(html).toContain(title(variants.original.length));
    const shown = renderToStaticMarkup(createElement(PromptVariantsText, { text: variants.original, variants, title, shown: 'translation' }));
    expect(shown).toContain(variants.translation);
    expect(shown).toContain(title(variants.translation.length));
  });

  it('без перевода — только текст', () => {
    const html = renderToStaticMarkup(createElement(PromptVariantsText, { text: 'Камера.', title }));
    expect(html).not.toContain(productionTexts.promptVariants.view);
    expect(html).toContain('Камера.');
  });
});
