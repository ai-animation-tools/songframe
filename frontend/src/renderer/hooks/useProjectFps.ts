import { DEFAULT_FPS } from '@shared/video';
import { useOptionalApp } from '../state';

/**
 * Частота кадров открытого проекта для перевода кадров в секунды и обратно.
 *
 * Источник — fps маркера plan/project.json из состояния проекта. Пока проект не открыт, его маркер
 * повреждён или компонент рисуется вне AppProvider (статическая разметка тестов), шкала —
 * DEFAULT_FPS: Go в этих случаях всё равно не принимает кадровые данные без допустимой частоты.
 * Страницы, у которых есть собственный документ с fps (реестр, вид монтажа), берут частоту из него.
 */
export function useProjectFps(): number {
  return useOptionalApp()?.status?.fps ?? DEFAULT_FPS;
}
