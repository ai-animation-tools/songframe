/**
 * Локальная модель группы updates для страницы настроек: проверка выпуска, скачивание с
 * прогрессом и установка без сети, GitHub и замены приложения. Состояние живёт в замыкании
 * одной истории и пересоздаётся при её повторном открытии; вызовы install записываются.
 */
import { updatesTexts } from '@shared/texts/updates';
import type { UpdateView } from '@shared/updates';
import type { ApiOverrides } from './storybook';

export interface UpdatesStoryModel {
  currentVersion?: string;
  /** Версия последнего выпуска; совпадение с текущей — «актуальная версия». */
  latest?: string;
  /** Установка заменяет приложение (AppImage, Windows); иначе кнопка показывает файл. */
  installable?: boolean;
  /** Скачанный пакет не совпадает с контрольной суммой. */
  corrupted?: boolean;
  /** Шагов прогресса скачивания по 120 мс. */
  steps?: number;
}

export interface UpdatesStorySession {
  api: ApiOverrides;
  installs: () => number;
}

const RELEASE = 'https://github.com/ai-animation-tools/songframe/releases/tag/v';

export function updatesStoryApi(initial: UpdatesStoryModel = {}): UpdatesStorySession {
  const model = { currentVersion: '1.0.0', latest: '1.1.0', installable: true, steps: 3, ...initial };
  let view: UpdateView = { status: 'idle', currentVersion: model.currentVersion };
  let installs = 0;
  const release = (): Pick<UpdateView, 'version' | 'releaseUrl' | 'installable'> => ({
    version: model.latest,
    releaseUrl: `${RELEASE}${model.latest}`,
    installable: model.installable
  });
  return {
    installs: () => installs,
    api: {
      updates: {
        view: async () => ({ ...view }),
        check: async () => {
          view =
            model.latest === model.currentVersion
              ? { status: 'current', currentVersion: model.currentVersion, message: updatesTexts.current }
              : { status: 'available', currentVersion: model.currentVersion, ...release(), message: updatesTexts.available({ version: model.latest }) };
          return { ...view };
        },
        download: async () => {
          for (let step = 0; step < model.steps; step++) {
            view = { status: 'downloading', currentVersion: model.currentVersion, ...release(), progress: step / model.steps };
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
          const ready = updatesTexts.ready({ version: model.latest });
          view = model.corrupted
            ? { status: 'error', currentVersion: model.currentVersion, ...release(), message: updatesTexts.hashMismatch }
            : {
                status: 'ready',
                currentVersion: model.currentVersion,
                ...release(),
                message: model.installable ? ready : `${ready} ${updatesTexts.readyPackage}`
              };
          return { ...view };
        },
        install: async () => {
          installs++;
          return { ...view };
        }
      }
    }
  };
}
