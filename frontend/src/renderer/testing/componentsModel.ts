import type {
  ComponentsApi,
  ComponentInstallation as InstallSnapshot,
  ComponentPackage as InstallPackage,
  ComponentsSelection as Selection,
  ComponentsSnapshot as Snapshot
} from '@shared/components';
import type { AppState } from '@shared/types';
import type { StoryOptions } from './storybook';

/**
 * Модель группы window.api.components для историй ComponentsPage: синтетические размеры и пути,
 * без настоящего профиля, manifest и Wails. Подключается к витрине через componentsStoryOptions.
 */
const ids = ['ffmpeg', 'ort-cpu', 'voc-ft', 'ctc-ru', 'ctc-vocab'];
export const componentSelection = (): Selection => ({
  ffmpegDirectory: '',
  ortDirectory: '',
  vocalsFile: '',
  ctcDirectory: '',
  managedDirectory: '',
  ortLibraryFile: '',
  ctcModelFile: '',
  ctcVocabFile: ''
});
export const installationFixture = (status = 'idle'): InstallSnapshot => ({
  status,
  component: status === 'idle' ? '' : 'ffmpeg',
  completedBytes: 50,
  totalBytes: 100,
  message:
    status === 'error'
      ? 'Нет места для сохранения компонента. Прежняя установка сохранена.'
      : status === 'cancelled'
        ? 'Скачивание отменено. Повтор продолжит сохранённую часть.'
        : 'Предыдущая установка остаётся доступна.',
  log: status === 'idle' ? [] : [{ time: '2026-11-03T10:00:00Z', message: 'Начато скачивание FFmpeg.' }]
});

/** Стенд воспроизводит автоматическую проверку сервиса при старте и после изменения компонентов.
 * State только наблюдает завершение фонового перехода; счётчики обнаруживают ручные/повторные probes.
 */
export function createComponentsModel(
  options: {
    status?: string;
    foundFFmpeg?: boolean;
    installation?: string;
    failInstallOnce?: boolean;
    failCatalogOnce?: boolean;
    failConnectOnce?: boolean;
    connectionType?: 'file' | 'archive';
    cancelConnect?: boolean;
    startupDelay?: number;
    fault?: 'ort-error' | 'restart' | 'cancelled' | 'profile' | 'blocked';
    longPath?: boolean;
  } = {}
) {
  const available = new Set(options.status === 'ready' ? ids : options.foundFFmpeg === false ? [] : ['ffmpeg']);
  if (options.fault === 'blocked') available.add('ctc-ru');
  const installed = new Set(available);
  const state: Snapshot = {
    selection: componentSelection(),
    checking: false,
    problem: '',
    components: ids.map((id) => ({
      id,
      status: 'missing',
      reason: 'Компонент не найден.',
      source: id === 'ffmpeg' ? 'path' : 'managed',
      version: '',
      // Backend вычисляет будущий entrypoint и у отсутствующего компонента.
      paths: { entrypoint: `/test/Будущая установка/${id}/файл` }
    })),
    operations: [
      { id: 'project-view', status: 'ready', reason: 'Компоненты не требуются.', requires: [] },
      { id: 'timing-view', status: 'ready', reason: 'Компоненты не требуются.', requires: [] },
      { id: 'known-text-ctc', status: 'missing', reason: 'Для разметки нужны компоненты локальной обработки.', requires: ids }
    ]
  };
  if (options.longPath) state.selection.managedDirectory = '/test/' + 'Длинная папка с кириллицей/'.repeat(10);
  let installation = installationFixture(options.installation);
  let installFailures = options.failInstallOnce ? 1 : 0,
    catalogFailures = options.failCatalogOnce ? 1 : 0;
  let connectFailures = options.failConnectOnce ? 1 : 0;
  let connections = 0,
    legacyInstalls = 0;
  let lastRequest: string[] = [];
  let checks = 0,
    reads = 0,
    manualChecks = 0,
    installs = 0,
    signature = '',
    deadline = 0;

  /** Неизменное обнаружение и просмотр страниц не создают новую дорогую проверку. */
  function beginCheck() {
    const next = JSON.stringify([state.selection, [...available].sort()]);
    if (next === signature) return;
    signature = next;
    checks++;
    state.checking = true;
    deadline = Date.now() + (options.startupDelay ?? 15);
    state.components.forEach((item) => {
      item.status = available.has(item.id) ? 'unchecked' : 'missing';
    });
  }
  /** Готовность возникает автоматически, включая подключение и импорт, без frontend Check. */
  function finishCheck() {
    if (!state.checking || Date.now() < deadline) return;
    state.checking = false;
    state.components.forEach((item) => {
      const ready = available.has(item.id);
      item.status = ready ? 'ready' : 'missing';
      item.reason = ready ? 'Компонент готов.' : 'Компонент не установлен.';
      const explicit =
        item.id === 'ffmpeg'
          ? state.selection.ffmpegDirectory
          : item.id === 'ort-cpu'
            ? state.selection.ortLibraryFile || state.selection.ortDirectory
            : item.id === 'voc-ft'
              ? state.selection.vocalsFile
              : item.id === 'ctc-ru'
                ? state.selection.ctcModelFile || state.selection.ctcDirectory
                : state.selection.ctcVocabFile || state.selection.ctcDirectory;
      item.source = explicit ? 'explicit' : item.id === 'ffmpeg' ? 'path' : 'managed';
      item.version = ready ? '1.0' : '';
      item.paths = ready ? { entrypoint: explicit || `/test/Готовые компоненты/${item.id}` } : { entrypoint: `/test/Будущая установка/${item.id}/файл` };
    });
    if (options.fault === 'ort-error') {
      state.components[1].status = 'error';
      state.components[1].reason = 'Не удалось загрузить ONNX Runtime: несовместимая библиотека.';
    }
    if (options.fault === 'restart') {
      state.components[1].status = 'restart_required';
      state.components[1].reason = 'Для другого ONNX Runtime перезапустите приложение.';
    }
    if (options.fault === 'cancelled') {
      state.components[1].status = 'cancelled';
      state.components[1].reason = 'Проверка компонента отменена.';
    }
    if (options.fault === 'profile') state.problem = 'Повреждены настройки: /test/Профиль/components.json';
    if (options.fault === 'blocked' && !available.has('ort-cpu')) {
      state.components[3].status = 'blocked';
      state.components[3].reason = 'Файл модели проверен. Для работы модели нужен ONNX Runtime.';
    }
    state.operations[2].status = state.components.every((item) => item.status === 'ready') ? 'ready' : 'missing';
    state.operations[2].reason = state.operations[2].status === 'ready' ? 'Компоненты готовы.' : 'Для разметки нужны компоненты локальной обработки.';
  }
  const catalog: InstallPackage[] = ids.map((component) => ({
    component,
    id: `${component}-linux-amd64`,
    version: '1.0',
    bytes: 1024 * 1024,
    installBytes: 2 * 1024 * 1024,
    temporaryBytes: 4 * 1024 * 1024,
    license: 'MIT',
    url: 'https://example.invalid/component',
    supported: true,
    reason: ''
  }));
  // Сервис запускает проверку до открытия страницы; активная установка временно владеет очередью.
  if (!['downloading', 'verifying', 'extracting', 'installing'].includes(installation.status)) beginCheck();
  /** Скачивание заменяет непригодный явный выбор без отдельного действия «Забыть» в UI. */
  function clearChoice(component: string) {
    if (component === 'ffmpeg') state.selection.ffmpegDirectory = '';
    if (component === 'ort-cpu') {
      state.selection.ortDirectory = '';
      state.selection.ortLibraryFile = '';
    }
    if (component === 'voc-ft') state.selection.vocalsFile = '';
    if (component === 'ctc-ru') {
      state.selection.ctcDirectory = '';
      state.selection.ctcModelFile = '';
    }
    if (component === 'ctc-vocab') {
      state.selection.ctcDirectory = '';
      state.selection.ctcVocabFile = '';
    }
  }
  /** Одна операция моделирует определение готового файла или архива сервисом, а не выбор режима пользователем. */
  async function connect(component: string) {
    connections++;
    if (options.cancelConnect) return null;
    if (connectFailures-- > 0) throw new Error('SHA файла не совпадает: /test/Выбранный компонент/archive');
    const path = `/test/Выбранные компоненты/${component}`;
    if (options.connectionType === 'archive') {
      installed.add(component);
      clearChoice(component);
      installation = { ...installationFixture('installed'), component };
    } else if (component === 'ffmpeg') state.selection.ffmpegDirectory = path;
    else if (component === 'ort-cpu') {
      state.selection.ortDirectory = '';
      state.selection.ortLibraryFile = path;
    } else if (component === 'voc-ft') state.selection.vocalsFile = path;
    else if (component === 'ctc-ru') {
      state.selection.ctcDirectory = '';
      state.selection.ctcModelFile = path;
    } else state.selection.ctcVocabFile = path;
    available.add(component);
    beginCheck();
    return structuredClone(state);
  }
  async function download(components: string[]) {
    installs++;
    lastRequest = [...components];
    if (installFailures-- > 0) {
      installation = installationFixture('error');
      throw new Error(installation.message);
    }
    components.forEach((component) => {
      clearChoice(component);
      available.add(component);
      installed.add(component);
    });
    installation = { ...installationFixture('installed'), component: components[0], completedBytes: 100 };
    beginCheck();
    return structuredClone(installation);
  }
  const api: ComponentsApi = {
    connect,
    download,
    state: async () => {
      reads++;
      finishCheck();
      return structuredClone(state);
    },
    configure: async (selection) => {
      state.selection = { ...selection };
      available.clear();
      installed.forEach((id) => available.add(id));
      if (selection.ffmpegDirectory) available.add('ffmpeg');
      if (selection.ortDirectory || selection.ortLibraryFile) available.add('ort-cpu');
      if (selection.vocalsFile) available.add('voc-ft');
      if (selection.ctcModelFile) available.add('ctc-ru');
      if (selection.ctcVocabFile) available.add('ctc-vocab');
      if (selection.ctcDirectory) {
        available.add('ctc-ru');
        available.add('ctc-vocab');
      }
      beginCheck();
      return structuredClone(state);
    },
    check: async () => {
      manualChecks++;
      throw new Error('UI не должен запускать ручную проверку.');
    },
    cancel: async () => {
      state.checking = false;
      state.components.forEach((item) => {
        if (item.status === 'unchecked') {
          item.status = 'cancelled';
          item.reason = 'Проверка отменена.';
        }
      });
    },
    catalog: async () => {
      if (catalogFailures-- > 0) throw new Error('Каталог временно недоступен.');
      return structuredClone(catalog);
    },
    installation: async () => structuredClone(installation),
    install: async () => {
      legacyInstalls++;
      throw new Error('UI должен использовать единый Download или Connect.');
    },
    cancelInstall: async () => {
      installation = installationFixture('cancelled');
    },
    chooseDirectory: async (component) => {
      if (component) throw new Error('UI не должен выбирать режим папки для компонента.');
      return '/test/Компоненты на другом диске/managed';
    },
    chooseFile: async () => {
      throw new Error('UI должен использовать единый Connect.');
    }
  };
  return {
    api,
    state,
    installation: () => installation,
    installCalls: () => installs,
    lastRequest: () => [...lastRequest],
    counters: () => ({ checks, reads, manualChecks, installs, connections, legacyInstalls })
  };
}

type ComponentsModel = ReturnType<typeof createComponentsModel>;

/** Снимок приложения витрины: от localDir страница строит папку компонентов по умолчанию. */
const storyAppState: AppState = {
  packaged: false,
  problems: [],
  toolsRoot: null,
  localDir: '/test/Профиль приложения',
  current: null,
  history: [],
  platform: 'linux'
};

/**
 * Параметры songframe для истории страницы компонентов. Модель создаётся до mount страницы, как
 * сервис при запуске приложения; переданная готовая модель переживает remount истории.
 */
export function componentsStoryOptions(source: ComponentsModel | Parameters<typeof createComponentsModel>[0] = {}, route = '/components'): StoryOptions {
  return {
    shell: 'page',
    route,
    app: { state: storyAppState },
    createApi: () => ({ components: ('api' in source ? source : createComponentsModel(source)).api })
  };
}
