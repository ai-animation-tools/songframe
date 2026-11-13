/**
 * Число, которое страница запоминает между запусками приложения: положение разделителей и подобные
 * настройки вида. Хранится в localStorage WebView (каталог профиля ОС), а не в проекте: это
 * предпочтение пользователя, одинаковое для всех клипов. Недоступное хранилище или негодное значение
 * оставляют значение по умолчанию; запись не мешает работе, если хранилище не принимает её.
 */
import { useCallback, useState } from 'react';

/** Сохранённое число, если оно есть и проходит проверку valid. */
export function readStoredNumber(key: string, fallback: number, valid: (value: number) => boolean = Number.isFinite): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** Состояние числа с записью каждого нового значения под ключом key. */
export function useStoredNumber(key: string, fallback: number, valid?: (value: number) => boolean): [number, (value: number) => void] {
  const [value, setValue] = useState(() => readStoredNumber(key, fallback, valid));
  const update = useCallback(
    (next: number) => {
      setValue(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // Хранилище недоступно: значение действует до закрытия окна.
      }
    },
    [key]
  );
  return [value, update];
}
