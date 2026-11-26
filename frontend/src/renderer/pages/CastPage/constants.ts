/** Служебный тип единственной сущности с общими условиями сцены. */
export const WORLD = 'world';

/** Тип локации: её размеры задаёт схема, роста у неё нет. */
export const LOCATION = 'location';

/** Есть ли у сущности типа kind рост или высота: у мира сцены и локаций — нет (как проверяет Go). */
export const hasHeight = (kind: string): boolean => kind !== WORLD && kind !== LOCATION;

/** Тип транспорта: только у него есть длина и ширина — на виде из камеры он коробка, а не фигура (как проверяет Go). */
export const VEHICLE = 'vehicle';
