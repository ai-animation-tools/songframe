import { describe, expect, it } from 'vitest';
import { productionInputLabel } from './production-labels';

describe('Подписи материалов сохранённого запроса', () => {
  it.each([
    ['first_image', 'Первый кадр'],
    ['tail_image', 'Последний кадр'],
    ['image', 'Изображение'],
    ['image_2', 'Изображение 2'],
    ['keyframe_3', 'Ключевой кадр 3'],
    ['tail_image_2', 'Последний кадр 2'],
    ['audio', 'Аудио'],
    ['audio_1', 'Аудио 1'],
    ['video', 'Видео'],
    ['video_4', 'Видео 4']
  ])('объясняет слот %s без внутреннего имени API', (slot, label) => {
    expect(productionInputLabel({ slot })).toBe(label);
  });

  it('сохраняет роль и номер для разных материалов одного вида', () => {
    expect(productionInputLabel({ role: 'first', slot: 'image_1' })).toBe('Первый кадр (Изображение 1)');
    expect(productionInputLabel({ role: 'last', slot: 'image_2' })).toBe('Последний кадр (Изображение 2)');
    expect(productionInputLabel({ role: 'middle' })).toBe('Промежуточный кадр');
    expect(productionInputLabel({ role: 'reference' })).toBe('Референс');
  });

  it('не повторяет одинаковые переводы роли и слота', () => {
    expect(productionInputLabel({ role: 'first', slot: 'first_image' })).toBe('Первый кадр');
    expect(productionInputLabel({ role: 'last', slot: 'tail_image' })).toBe('Последний кадр');
  });

  it('сохраняет неизвестные имена провайдера и даёт подпись отсутствующему слоту', () => {
    expect(productionInputLabel({ slot: 'custom_input' })).toBe('custom_input');
    expect(productionInputLabel({ role: 'custom_role' })).toBe('custom_role');
    expect(productionInputLabel({})).toBe('Входной материал');
  });
});
