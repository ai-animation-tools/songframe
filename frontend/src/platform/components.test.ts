import { describe, expect, it, vi } from 'vitest';
import { componentSnapshot, createComponentsApi, installCatalog, installSnapshot, type ComponentsTransport } from './components';

/** Wire-фикстуры независимы от renderer и проверяют отказ повреждённых ответов до показа ready. */
const snapshot = {
  selection: {
    ffmpegDirectory: '',
    ortDirectory: '',
    ortLibraryFile: '',
    vocalsFile: '',
    ctcDirectory: '',
    ctcModelFile: '',
    ctcVocabFile: '',
    managedDirectory: ''
  },
  components: [{ id: 'ffmpeg', status: 'missing', reason: 'Не найден.', source: 'path', version: '', paths: {} }],
  operations: [{ id: 'timing-view', status: 'ready', reason: 'Компоненты не требуются.', requires: [] }],
  checking: false,
  problem: ''
};
const installation = { status: 'cancelled', component: 'ffmpeg', completedBytes: 10, totalBytes: 100, message: 'Прервано.', log: [] };

describe('контракт менеджера компонентов', () => {
  it('сохраняет независимую готовность чтения при отсутствии производственных компонентов', () => {
    expect(componentSnapshot(snapshot)).toEqual(snapshot);
    expect(() => componentSnapshot({ ...snapshot, operations: null })).toThrow('Некорректный ответ');
    expect(() => componentSnapshot({ ...snapshot, components: [{ ...snapshot.components[0], paths: { ffmpeg: null } }] })).toThrow('Некорректный ответ');
  });

  it('не принимает ложный успех установки с повреждённым журналом или размером', () => {
    expect(installSnapshot(installation)).toEqual(installation);
    for (const corrupted of [
      { ...installation, log: null },
      { ...installation, completedBytes: -1 },
      { ...installation, totalBytes: Infinity }
    ]) {
      expect(() => installSnapshot(corrupted)).toThrow('Некорректный ответ');
    }
    expect(installCatalog([])).toEqual([]);
    expect(() => installCatalog([{ component: 'ffmpeg', supported: true }])).toThrow('Некорректный ответ');
  });

  it('оставляет установку активной до её ответа и передаёт отмену отдельным вызовом', async () => {
    let finish!: (value: unknown) => void;
    const transport: ComponentsTransport = {
      state: async () => snapshot,
      connect: vi.fn(async () => null),
      download: vi.fn(async () => installation),
      configure: async () => snapshot,
      check: async () => snapshot,
      cancel: vi.fn(async () => {}),
      catalog: async () => [],
      installation: async () => installation,
      install: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      ),
      cancelInstall: vi.fn(async () => {}),
      chooseDirectory: vi.fn(async () => null),
      chooseFile: async () => null
    };
    const api = createComponentsApi(transport);
    const request = { components: ['ffmpeg'], localFiles: {} };
    const pending = api.install(request);
    expect(await api.installation()).toEqual(installation);
    await api.cancelInstall();
    expect(transport.cancelInstall).toHaveBeenCalledOnce();
    expect(transport.install).toHaveBeenCalledWith(request);
    finish(installation);
    expect(await pending).toEqual(installation);
    expect(await api.connect('ctc-vocab')).toBeNull();
    expect(transport.connect).toHaveBeenCalledWith('ctc-vocab');
    expect(await api.download(['ffmpeg'])).toEqual(installation);
    expect(transport.download).toHaveBeenCalledWith(['ffmpeg']);
    expect(await api.chooseDirectory('ort-cpu')).toBeNull();
    expect(transport.chooseDirectory).toHaveBeenCalledWith('ort-cpu');
  });
});
