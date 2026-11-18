import { describe, expect, it } from 'vitest';
import { productionTexts } from '@shared/texts/production';
import { generationOf, generationProblem, moveInput, OWN_VIDEO_INPUT_LIMIT, withDefaultRoles, type OwnVideoDraftInput } from './ownVideoGeneration';

const texts = productionTexts.ownVideo.generation;
const input = (file: string, role: OwnVideoDraftInput['role'] = 'middle', chosen = false): OwnVideoDraftInput => ({ id: file, file, role, chosen });
const roles = (inputs: OwnVideoDraftInput[]) => inputs.map((item) => item.role);

describe('входы генерации своего видео', () => {
  it('роли по умолчанию следуют за порядком: первый, промежуточные, последний', () => {
    expect(roles(withDefaultRoles([input('/a.png')]))).toEqual(['first']);
    expect(roles(withDefaultRoles([input('/a.png'), input('/b.png')]))).toEqual(['first', 'last']);
    expect(roles(withDefaultRoles([input('/a.png'), input('/b.png'), input('/c.png')]))).toEqual(['first', 'middle', 'last']);
  });

  it('выбранная пользователем роль не пересчитывается при перестановке', () => {
    const draft = withDefaultRoles([input('/a.png'), input('/b.png', 'middle', true), input('/c.png')]);
    const moved = moveInput(draft, 1, 1);
    expect(moved.map((item) => item.file)).toEqual(['/a.png', '/c.png', '/b.png']);
    expect(roles(moved)).toEqual(['first', 'middle', 'middle']);
    // За пределы списка вход не переставляется.
    expect(moveInput(draft, 0, -1)).toBe(draft);
  });

  it('объясняет роль не на своём месте и предел числа входов', () => {
    expect(generationProblem([])).toBeNull();
    expect(generationProblem([input('/a.png', 'last')])).toBeNull();
    expect(generationProblem([input('/a.png', 'first'), input('/b.png', 'last'), input('/c.png', 'middle')])).toBe(texts.lastNotLast);
    expect(generationProblem([input('/a.png', 'middle'), input('/b.png', 'first')])).toBe(texts.firstNotFirst);
    const many = withDefaultRoles(Array.from({ length: OWN_VIDEO_INPUT_LIMIT + 1 }, (_, index) => input(`/${index}.png`)));
    expect(generationProblem(many)).toBe(texts.limit({ limit: OWN_VIDEO_INPUT_LIMIT }));
  });

  it('пустой раздел даёт пустые входы и промпт, промпт без крайних пробелов', () => {
    expect(generationOf([], '  ')).toEqual({ inputs: [], prompt: '' });
    expect(generationOf([input('/a.png', 'first')], ' Камера наезжает \n')).toEqual({ inputs: [{ file: '/a.png', role: 'first' }], prompt: 'Камера наезжает' });
  });

  it('статус раздела называет указанное', () => {
    expect(texts.filled({ inputs: 2, prompt: true })).toBe('2 изображения и промпт');
    expect(texts.filled({ inputs: 1, prompt: false })).toBe('1 изображение');
    expect(texts.filled({ inputs: 0, prompt: true })).toBe('промпт');
  });
});
