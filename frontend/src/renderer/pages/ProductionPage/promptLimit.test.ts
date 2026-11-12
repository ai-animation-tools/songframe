import { describe, expect, it } from 'vitest';
import { productionTexts } from '@shared/texts/production';
import { promptOverLimit } from './promptLimit';

describe('предел видеопромпта', () => {
  it('сверх предела — длина и предел, на пределе и без предела — null', () => {
    expect(promptOverLimit('ж'.repeat(2504), 2500)).toEqual({ chars: 2504, limit: 2500 });
    expect(promptOverLimit('ж'.repeat(2500), 2500)).toBeNull();
    expect(promptOverLimit('ж'.repeat(9000), undefined)).toBeNull();
    expect(promptOverLimit('', 10)).toBeNull();
  });

  it('считает символы Unicode, как Go, а не единицы UTF-16', () => {
    expect(promptOverLimit('😀'.repeat(3), 3)).toBeNull();
    expect(promptOverLimit('😀'.repeat(4), 3)).toEqual({ chars: 4, limit: 3 });
  });

  it('тексты называют длину, предел и провайдера', () => {
    expect(productionTexts.promptLimit.description({ chars: 2504, limit: 2500, provider: 'Сервис' })).toBe(
      '2504 символа при пределе 2500 у Сервис. Утвердить такой промпт нельзя: верните его агенту на доработку.'
    );
    expect(productionTexts.promptLimit.approveReason({ chars: 2504, limit: 2500 })).toBe('Промпт длиннее предела провайдера: 2504 из 2500 символов.');
    expect(productionTexts.promptLimit.reviseNote({ chars: 2504, limit: 2500 })).toBe(
      'Сократи видеопромпт до 2500 символов (сейчас 2504), сохранив действие, опоры и важные детали.'
    );
  });
});
