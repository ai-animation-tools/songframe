/** Фактическая высота закреплённой шапки: под ней встают панели действий, а при потере сети шапка растёт на высоту сообщения. */
import { createContext, useContext } from 'react';

/** Плотная панель MUI (48 px) и нижняя граница шапки. */
export const BASE_HEADER_HEIGHT = 49;

export const HeaderHeightContext = createContext(BASE_HEADER_HEIGHT);

export function useHeaderHeight(): number {
  return useContext(HeaderHeightContext);
}
