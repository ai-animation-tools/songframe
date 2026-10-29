/** Адрес «Кастинга» с выбранной сущностью: параметр ?entity= раскрывает её карточку и прокручивает к ней. */

export const ENTITY_PARAM = 'entity';

const CAST_PATH = '/project/cast';

/** Маршрут «Кастинга» с карточкой сущности; код сущности кодируется как значение параметра. */
export function castEntityRoute(entity: string): string {
  return `${CAST_PATH}?${new URLSearchParams({ [ENTITY_PARAM]: entity })}`;
}
