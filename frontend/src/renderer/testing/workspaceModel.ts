import type { WorkspaceBridge } from '@platform/workspace';
import type { NotificationTarget } from '@shared/notifications';
import type { FilesDropped, PreviewInput, ProjectSnapshot } from '@shared/workspace';

/** Короткий синтетический WAV проверяет настоящий браузерный decode без доступа к клипу и внешней сети. */
function waveURL(): string {
  const sampleRate = 8000,
    length = sampleRate * 2,
    data = new Uint8Array(44 + length * 2),
    view = new DataView(data.buffer);
  const word = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) data[offset + i] = value.charCodeAt(i);
  };
  word(0, 'RIFF');
  view.setUint32(4, data.length - 8, true);
  word(8, 'WAVE');
  word(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  word(36, 'data');
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) view.setInt16(44 + i * 2, Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 1000, true);
  return 'data:audio/wav;base64,' + btoa(Array.from(data, (value) => String.fromCharCode(value)).join(''));
}
/** Снимок хранит физические номера, подтверждение, ручную часть и точные секунды как независимую fixture. */
export function projectFixture(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    path: '/test/Копия клипа',
    name: 'Песня для проверки',
    lyricsText: '[Куплет]\nПервая строка\n\nВторая строка\n',
    timing: {
      version: 2,
      status: 'verified',
      source: 'source/track.mp3',
      sha256: 'fixture-track',
      duration_decoded: 2,
      duration_container: 2,
      clock: 'decoded',
      lines: [
        { id: 1, source_line: 2, start: 0.1, end: 0.8, verified: true, note: 'Ручная граница' },
        { id: 2, source_line: 4, start: 1.1, end: 1.7, verified: false }
      ],
      sections: [{ name: 'Куплет', start: 0.1, end: 1.7, origin: 'manual', note: 'Сохранённая часть' }]
    },
    track: { path: '/test/Копия клипа/source/track.wav', url: waveURL(), kind: 'audio' },
    trackSha256: 'fixture-track',
    duration: 2,
    problems: [],
    blocked: false,
    ...overrides
  };
}
/** Типизированная модель событий принадлежит истории; закрытие удаляет ровно её слушатель, а не всех подписчиков. */
export function createWorkspaceModel(snapshot = projectFixture(), overrides: Partial<WorkspaceBridge> = {}) {
  const drops = new Set<(value: FilesDropped) => void>();
  const notifications = new Set<(value: NotificationTarget) => void>();
  const closed = new Set<(value: { session: string }) => void>();
  const previews = new Map<string, PreviewInput>();
  const bridge: WorkspaceBridge = {
    openProject: async () => structuredClone(snapshot),
    media: async (path) => ({ ...projectFixture().track!, path }),
    pickFolder: async () => snapshot.path,
    pickFiles: async () => ['/test/Выбранный файл.wav'],
    openPreview: async (input) => {
      previews.set(input.session, input);
    },
    preview: async (session) => {
      const input = previews.get(session);
      if (!input) throw new Error('Окно уже закрыто');
      return input;
    },
    previewReady: async () => undefined,
    closePreview: async (session) => {
      if (previews.delete(session)) closed.forEach((listener) => listener({ session }));
    },
    saveReport: async () => '/test/diagnostics.txt',
    crashNotice: async () => null,
    reportError: async () => undefined,
    onFilesDropped: (listener) => {
      drops.add(listener);
      return () => {
        drops.delete(listener);
      };
    },
    onNotification: (listener) => {
      notifications.add(listener);
      return () => {
        notifications.delete(listener);
      };
    },
    onPreviewClosed: (listener) => {
      closed.add(listener);
      return () => {
        closed.delete(listener);
      };
    },
    ...overrides
  };
  return {
    bridge,
    emitDrop: (value: FilesDropped) => drops.forEach((listener) => listener(value)),
    emitNotification: (value: NotificationTarget) => notifications.forEach((listener) => listener(value)),
    previews,
    counts: () => ({ drops: drops.size, notifications: notifications.size, closed: closed.size })
  };
}
