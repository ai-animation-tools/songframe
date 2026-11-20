/** Служебный тип единственной сущности с общими условиями сцены. */
export const WORLD = 'world';

/** Тип локации: её размеры задаёт схема, роста у неё нет. */
export const LOCATION = 'location';

/** Есть ли у сущности типа kind рост или высота: у мира сцены и локаций — нет (как проверяет Go). */
export const hasHeight = (kind: string): boolean => kind !== WORLD && kind !== LOCATION;
