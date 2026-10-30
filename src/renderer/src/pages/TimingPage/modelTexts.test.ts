/** SSR проверяет реальные ветви настройки модели; сетевые запросы и скачивание здесь не выполняются. */
import type * as ReactModule from 'react';
import { type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WhisperSetup } from '@shared/whisper-models';
import { WhisperModelSetup } from './components/WhisperModelSetup';
import { TerminalCommand } from './components/TerminalCommand';

const harness = vi.hoisted(() => ({
  capturing: false,
  values: [] as unknown[],
  platform: 'linux',
  notify: vi.fn(),
  describeError: vi.fn((error: unknown) => String(error))
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof ReactModule>();
  return {
    ...react,
    // Только прямой вызов страницы получает подготовленные данные; вложенные MUI-компоненты используют настоящие hooks.
    useState: <T>(initial: T | (() => T)) => {
      if (!harness.capturing) return react.useState(initial);
      return [harness.values.shift(), vi.fn()];
    },
    useEffect: (...args: Parameters<typeof react.useEffect>) => {
      if (!harness.capturing) react.useEffect(...args);
    },
    useRef: <T>(initial: T) => (harness.capturing ? { current: initial } : react.useRef(initial)),
    useCallback: <T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]) =>
      harness.capturing ? callback : react.useCallback(callback, deps)
  };
});
vi.mock('../../state', () => ({ useApp: () => ({ state: { platform: harness.platform }, notify: harness.notify, describeError: harness.describeError }) }));
vi.mock('./components/WhisperModelDownload', () => ({ WhisperModelDownload: () => 'Блок скачивания модели' }));

function setup(): WhisperSetup {
  return {
    hardware: {
      cpuName: 'CPU «А»',
      cpuThreads: 8,
      ramGiB: 16,
      gpuName: 'GPU <script>&',
      vramMiB: 8192,
      cudaReady: false,
      device: 'cpu',
      computeType: 'int8',
      reason: 'Нужен драйвер'
    },
    recommended: 'medium',
    recommendation: 'Локальная рекомендация.',
    gpuSuggestion: 'large-v3',
    platform: 'linux',
    directories: { small: '/модели/small', medium: '/модели/medium', 'large-v3-turbo': '/модели/turbo', 'large-v3': '/модели/large' },
    installed: { small: false, medium: true, 'large-v3-turbo': false, 'large-v3': false }
  };
}

function renderSetup(value: WhisperSetup | null, path = '', error = ''): string {
  harness.values = [value, 'medium', error, 0];
  harness.capturing = true;
  let tree: ReactNode;
  try {
    tree = WhisperModelSetup({ path, onPathChange: vi.fn() });
  } finally {
    harness.capturing = false;
  }
  return renderToStaticMarkup(tree).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
}

afterEach(() => {
  harness.platform = 'linux';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('состояния настройки Whisper', () => {
  it('не показывает скачивание и повторный выбор уже установленной выбранной модели', () => {
    const html = renderSetup(setup());
    expect(html).toContain('Модель medium установлена. Выбрана для распознавания.');
    expect(html).toContain('Папка: /модели/medium');
    expect(html).not.toContain('Размер загрузки:');
    expect(html).not.toContain('Блок скачивания модели');
    expect(html).not.toContain('Использовать папку medium');
  });

  it('оставляет действие выбора другой установленной папки и загрузку отсутствующей модели', () => {
    const other = renderSetup(setup(), '/ручная/модель');
    expect(other).toContain('Модель medium установлена.');
    expect(other).not.toContain('Выбрана для распознавания.');
    expect(other).toContain('Использовать папку medium');
    expect(other).not.toContain('Блок скачивания модели');
    const missing = setup();
    missing.installed.medium = false;
    const html = renderSetup(missing);
    expect(html).toContain('Блок скачивания модели');
    expect(html).toContain('Размер загрузки: около 1,5 ГБ. Папка: /модели/medium');
  });

  it.each([
    ['linux', 'Linux', 'https://docs.nvidia.com/cuda/cuda-installation-guide-linux/'],
    ['win32', 'Windows', 'https://docs.nvidia.com/cuda/cuda-installation-guide-microsoft-windows/']
  ])('сохраняет целую фразу и все ссылки CUDA на %s', (platform, label, url) => {
    harness.platform = platform;
    const html = renderSetup(setup());
    expect(html).toContain('href="https://github.com/SYSTRAN/faster-whisper#gpu"');
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain('href="https://docs.nvidia.com/deeplearning/cudnn/installation/latest/"');
    expect(html.replace(/<[^>]*>/g, '')).toContain(
      `После настройки CUDA можно попробовать large-v3. Нужны драйвер NVIDIA, cuBLAS для CUDA 12 и cuDNN 9. Требования faster-whisper, CUDA для ${label}, установка cuDNN. После установки перезапустите приложение и нажмите «Обновить сведения».`
    );
    expect(html).toContain('CPU «А»; RAM 16.0 ГБ. NVIDIA: GPU &lt;script&gt;&amp;, 8.0 ГБ видеопамяти.');
    expect(html).not.toContain('<script>');
    expect(html).toContain('href="https://huggingface.co/Systran/faster-whisper-medium/tree/main"');
  });

  it('сохраняет ленивое чтение GPU и пустую рекомендацию при загрузке', () => {
    const value = setup();
    value.hardware.gpuName = null;
    value.gpuSuggestion = null;
    Object.defineProperty(value.hardware, 'vramMiB', {
      get: () => {
        throw new Error('Не читать память отсутствующего GPU');
      }
    });
    const html = renderSetup(value);
    expect(html).toContain('CPU «А»; RAM 16.0 ГБ.');
    expect(html).not.toContain('После настройки CUDA');
    const loading = renderSetup(null);
    expect(loading).toContain('Проверяем CPU, память и доступность CUDA…');
    expect(loading).toContain('placeholder="Выберите папку скачанной модели"');
    expect(loading).not.toContain('undefined');
  });

  it('показывает ошибку рекомендации без преобразования её в HTML', () => {
    const html = renderSetup(null, '', '<script>& «CUDA»');
    expect(html).toContain('Не удалось получить рекомендацию: &lt;script&gt;&amp; «CUDA»');
    expect(html).not.toContain('Проверяем CPU');
  });
});

describe('точная команда терминала', () => {
  it.each(['0', 'printf "<строка>&"\nC:\\Модели\\«A»'])('копирует исходную команду %s и экранирует только отображение', async (command) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const tree = TerminalCommand({ command });
    const children = (tree.props as { children: ReactElement[] }).children;
    const button = children[1];
    await (button.props as { onClick: () => Promise<void> }).onClick();
    expect(writeText).toHaveBeenCalledWith(command);
    expect(harness.notify).toHaveBeenCalledWith('Команда скопирована', 'success');
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('Копировать команду');
    if (command === '0') expect(html).toContain('>0</pre>');
    else expect(html).toContain('printf &quot;&lt;строка&gt;&amp;&quot;\nC:\\Модели\\«A»');
  });
});
