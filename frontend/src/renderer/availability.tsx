/**
 * Доступность методов window.api для страниц на время миграции на Go.
 *
 * Список готовых Go-операций принадлежит адаптеру platform/api (`methodAvailability`); точка входа
 * передаёт его сюда провайдером. По умолчанию всё доступно: витрина и unit-тесты работают на
 * локальных моделях API, где любой метод настроен историей. Так renderer не импортирует platform
 * и не повторяет собственный перечень перенесённых методов.
 */
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { ApiMethod } from '@platform/unavailable-api';

export type { ApiMethod } from '@platform/unavailable-api';

/** Ответ адаптера: недоступный метод сопровождается причиной для пользователя. */
export interface MethodAvailability {
  available: boolean;
  reason: string | null;
}

export type AvailabilityCheck = (method: ApiMethod) => MethodAvailability;

const allAvailable: AvailabilityCheck = () => ({ available: true, reason: null });
const AvailabilityContext = createContext<AvailabilityCheck>(allAvailable);

/** Подключает проверку адаптера (в приложении) или модель истории (в витрине). */
export function AvailabilityProvider({ value, children }: { value: AvailabilityCheck; children: ReactNode }): ReactElement {
  return <AvailabilityContext.Provider value={value}>{children}</AvailabilityContext.Provider>;
}

/** Первый недоступный из перечисленных методов; null — все методы перенесены. */
export function useUnavailableMethod(methods: readonly ApiMethod[]): { method: ApiMethod; reason: string } | null {
  const check = useContext(AvailabilityContext);
  for (const method of methods) {
    const result = check(method);
    if (!result.available) return { method, reason: result.reason ?? '' };
  }
  return null;
}

/** Доступность одного метода для блокировки отдельной кнопки через disabledReason. */
export function useMethodAvailability(method: ApiMethod): MethodAvailability {
  return useContext(AvailabilityContext)(method);
}
