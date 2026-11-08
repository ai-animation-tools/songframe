import { describe, expect, it } from 'vitest';
import type { GenerationReferenceImage } from '@shared/cover-generation';
import type { ReferenceImageOption } from '@shared/reference-image-generation';
import { referenceSupportNotes } from './useReferenceImageSupports';

const first = { path: '/first.png', label: 'Спереди', note: ' Сохранить лицо ' };
const second = { path: '/second.png', label: 'Сбоку', note: 'Красная куртка' };
const image = (option: ReferenceImageOption, sha256: string): GenerationReferenceImage => ({ path: option.path, label: option.label, sha256, bytes: 1 });
describe('примечания фактически отправляемых опор', () => {
  it('объединяет одинаковые байты, сохраняя порядок разных опор и их примечаний', () => {
    const duplicate = { ...first, path: '/copy.png', label: 'Полный рост', note: 'Сохранить лицо' };
    expect(referenceSupportNotes([first, duplicate, second], [image(first, 'a'), image(duplicate, 'a'), image(second, 'b')])).toBe(
      'Опора 1 (Спереди · Полный рост):\nСохранить лицо\n\nОпора 2 (Сбоку):\nКрасная куртка'
    );
  });
  it('пустое примечание не сдвигает номер следующей опоры и не создаёт пустой раздел', () => {
    const empty = { ...first, note: '  ' };
    expect(referenceSupportNotes([empty, second], [image(empty, 'a'), image(second, 'b')])).toBe('Опора 2 (Сбоку):\nКрасная куртка');
    expect(referenceSupportNotes([empty], [image(empty, 'a')])).toBe('');
  });
  it('берёт только выбранные опоры в выбранном порядке', () => {
    expect(referenceSupportNotes([second], [image(second, 'b')])).toBe('Опора 1 (Сбоку):\nКрасная куртка');
    expect(referenceSupportNotes([], [])).toBe('');
  });
  it('разные примечания копий одной картинки остаются у единственной отправляемой опоры', () => {
    const duplicate = { ...first, path: '/copy.png', note: 'Сохранить одежду' };
    expect(referenceSupportNotes([first, duplicate], [image(first, 'a'), image(duplicate, 'a')])).toBe('Опора 1 (Спереди):\nСохранить лицо\nСохранить одежду');
  });
});
