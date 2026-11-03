import type { NotificationTarget } from '@shared/notifications';
import type { PickOptions, PreviousSessionInfo, RendererErrorReport } from '@shared/types';
import type { FilesDropped, MediaFile, PreviewInput, ProjectSnapshot, ReadonlyTiming } from '@shared/workspace';
import { workspaceTexts as text } from '@shared/texts/workspace';
import { ApiError, withDeadline } from './api';
import { analyzeLyrics, selectLyricTimings } from '@shared/lyrics';

/** Отдельная граница read-only просмотра сохраняет совместимый API до переноса полного ProjectStatus. */
export interface WorkspaceBridge {
  openProject(path: string): Promise<ProjectSnapshot>;
  media(path: string): Promise<MediaFile>;
  pickFolder(options?: PickOptions): Promise<string | null>;
  pickFiles(options?: PickOptions): Promise<string[]>;
  openPreview(input: PreviewInput): Promise<void>;
  preview(session: string): Promise<PreviewInput>;
  previewReady(session: string): Promise<void>;
  closePreview(session: string): Promise<void>;
  saveReport(): Promise<string | null>;
  crashNotice(): Promise<PreviousSessionInfo | null>;
  reportError(report: RendererErrorReport): Promise<void>;
  onFilesDropped(listener: (value: FilesDropped) => void, onError?: (error: unknown) => void): () => void;
  onNotification(listener: (value: NotificationTarget) => void, onError?: (error: unknown) => void): () => void;
  onPreviewClosed(listener: (value: { session: string }) => void, onError?: (error: unknown) => void): () => void;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nullableNumber = (value: unknown) => value === null || finite(value);
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const optionalString = (value: unknown) => value === undefined || typeof value === 'string';
function invalid(method: string): never {
  throw new ApiError('INVALID_RESPONSE', method, text.invalidResponse);
}

/** Структурная проверка предотвращает падение таблицы. Секунды, ручные признаки и неизвестные поля не нормализуются. */
export function validTiming(value: unknown): value is ReadonlyTiming {
  if (!record(value) || !Array.isArray(value.lines) || (value.sha256 !== undefined && !nullableString(value.sha256))) return false;
  if (
    !value.lines.every(
      (line) =>
        record(line) &&
        Number.isSafeInteger(line.id) &&
        Number.isSafeInteger(line.source_line) &&
        Number(line.source_line) > 0 &&
        finite(line.start) &&
        finite(line.end) &&
        (line.verified === undefined || typeof line.verified === 'boolean') &&
        optionalString(line.note)
    )
  )
    return false;
  if (
    value.sections !== undefined &&
    (!Array.isArray(value.sections) ||
      !value.sections.every(
        (section) =>
          record(section) &&
          typeof section.name === 'string' &&
          finite(section.start) &&
          finite(section.end) &&
          (section.origin === undefined || section.origin === 'manual' || section.origin === 'auto') &&
          optionalString(section.note)
      ))
  )
    return false;
  if (
    value.candidates !== undefined &&
    (!Array.isArray(value.candidates) ||
      !value.candidates.every(
        (candidate) =>
          record(candidate) &&
          Number.isSafeInteger(candidate.source_line) &&
          Number(candidate.source_line) > 0 &&
          finite(candidate.start) &&
          candidate.start >= 0 &&
          finite(candidate.end) &&
          candidate.end > candidate.start &&
          typeof candidate.reason === 'string' &&
          !!candidate.reason.trim() &&
          optionalString(candidate.note) &&
          (candidate.acoustic_score === undefined || (finite(candidate.acoustic_score) && candidate.acoustic_score >= 0 && candidate.acoustic_score <= 1))
      ))
  )
    return false;
  return (
    value.line_order === undefined || (Array.isArray(value.line_order) && value.line_order.every((line) => Number.isSafeInteger(line) && Number(line) > 0))
  );
}

/** Медиа DTO обязан нести URL loopback выбранного Go файла; тип нужен для корректного audio/video элемента. */
export function parseMedia(value: unknown): MediaFile {
  if (
    !record(value) ||
    typeof value.path !== 'string' ||
    !value.path ||
    typeof value.url !== 'string' ||
    !value.url ||
    (value.kind !== 'audio' && value.kind !== 'video')
  )
    return invalid('workspace.media');
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return invalid('workspace.media');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return invalid('workspace.media');
  return value as unknown as MediaFile;
}

/** Повреждённая разметка не лишает пользователя текста; необязательные поля остаются nullable, списки всегда массивы. */
export function parseSnapshot(value: unknown): ProjectSnapshot {
  if (
    !record(value) ||
    typeof value.path !== 'string' ||
    !value.path ||
    typeof value.name !== 'string' ||
    typeof value.lyricsText !== 'string' ||
    !strings(value.problems) ||
    typeof value.blocked !== 'boolean' ||
    !nullableNumber(value.duration) ||
    !nullableString(value.trackSha256)
  )
    return invalid('workspace.openProject');
  const problems = [...value.problems];
  let timing: ReadonlyTiming | null = null;
  if (value.timing !== null) {
    if (validTiming(value.timing)) timing = value.timing;
    else problems.push(text.invalidTiming);
  }
  if (timing?.sha256 && value.trackSha256 && timing.sha256 !== value.trackSha256) problems.push(text.trackChanged);
  if (timing && selectLyricTimings(timing.lines, analyzeLyrics(value.lyricsText).rows).invalidIds.length) problems.push(text.lyricsChanged);
  const track = value.track === null ? null : parseMedia(value.track);
  if (value.blocked && (timing !== null || track !== null || value.lyricsText !== '')) return invalid('workspace.openProject');
  return { ...value, timing, track, problems } as ProjectSnapshot;
}

/** Асинхронный import не переживает unmount: cleanup доступен немедленно, поздние события и ошибки отбрасываются. */
export function subscribeDeferred<T>(
  load: () => Promise<{ on: (name: string, listener: (event: { data: unknown }) => void) => () => void }>,
  name: string,
  parse: (value: unknown) => T,
  listener: (value: T) => void,
  onError: (error: unknown) => void = console.error
): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  void load()
    .then((events) => {
      if (disposed) return;
      unsubscribe = events.on(name, (event) => {
        if (disposed) return;
        try {
          listener(parse(event.data));
        } catch (error) {
          onError(error);
        }
      });
      if (disposed) unsubscribe();
    })
    .catch((error: unknown) => {
      if (!disposed) onError(error);
    });
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
  };
}

const loadEvents = async () => {
  const { Events } = await import('@wailsio/runtime');
  return { on: Events.On };
};
const native = () => import('../../bindings/songframe-go/internal/app/nativeservice');
const projects = () => import('../../bindings/songframe-go/internal/app/projectservice');
/** Единый перевод ошибок сохраняет причину Go, в том числе отсутствие файла и сбой системного диалога. */
async function call<T>(method: string, work: () => Promise<T>, deadline = true): Promise<T> {
  try {
    return await (deadline ? withDeadline(work, method) : work());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'RuntimeError') throw new ApiError('SERVICE_FAILED', method, error.message, { cause: error });
    throw new ApiError('CONNECTION_FAILED', method, error instanceof Error ? error.message : text.unknownError, { cause: error });
  }
}
function parsePreview(value: unknown): PreviewInput {
  if (!record(value) || typeof value.session !== 'string' || typeof value.mediaUrl !== 'string' || typeof value.title !== 'string') return invalid('preview');
  parseMedia({ path: value.title || text.previewTitle, url: value.mediaUrl, kind: 'audio' });
  return value as unknown as PreviewInput;
}
function parseDropped(value: unknown): FilesDropped {
  if (!record(value) || !finite(value.windowID) || !strings(value.paths) || typeof value.targetID !== 'string') return invalid('native:files-dropped');
  return value as unknown as FilesDropped;
}
function parseNotification(value: unknown): NotificationTarget {
  if (
    !record(value) ||
    typeof value.project !== 'string' ||
    !['/project/timing', '/project/checks', '/project/animatic', '/project/scenario', '/project/production'].includes(String(value.route))
  )
    return invalid('notifications:open');
  return value as unknown as NotificationTarget;
}
const pickOptions = (options?: PickOptions) => ({ title: options?.title ?? '', filters: options?.filters ?? [], multiple: options?.multiple ?? false });

/** Рабочая реализация не импортирует Wails до действия/подписки; истории передают независимую модель этого интерфейса. */
export const workspaceBridge: WorkspaceBridge = {
  openProject: (path) => call('workspace.openProject', async () => parseSnapshot(await (await projects()).Open(path))),
  media: (path) => call('workspace.media', async () => parseMedia(await (await projects()).Media(path))),
  pickFolder: (options) =>
    call(
      'dialog.pickFolder',
      async () => {
        const value = await (await native()).PickFolder(pickOptions(options));
        if (!nullableString(value)) return invalid('dialog.pickFolder');
        return value;
      },
      false
    ),
  pickFiles: (options) =>
    call(
      'dialog.pickFiles',
      async () => {
        const value = await (await native()).PickFiles(pickOptions(options));
        if (!strings(value)) return invalid('dialog.pickFiles');
        return value;
      },
      false
    ),
  openPreview: (input) =>
    call('preview.open', async () => {
      await (await native()).OpenPreview(input);
    }),
  preview: (session) => call('preview.read', async () => parsePreview(await (await native()).Preview(session))),
  previewReady: (session) =>
    call('preview.ready', async () => {
      await (await native()).PreviewReady(session);
    }),
  closePreview: (session) =>
    call('preview.close', async () => {
      await (await native()).ClosePreview(session);
    }),
  saveReport: () =>
    call(
      'diagnostics.saveReport',
      async () => {
        const value = await (await native()).SaveReport();
        if (!nullableString(value)) return invalid('diagnostics.saveReport');
        return value;
      },
      false
    ),
  crashNotice: () =>
    call('diagnostics.crashNotice', async () => {
      const value = await (await native()).CrashNotice();
      if (value !== null && (!record(value) || typeof value.crashed !== 'boolean' || !nullableString(value.startedAt) || !nullableString(value.version)))
        return invalid('diagnostics.crashNotice');
      return value;
    }),
  reportError: (report) =>
    call('diagnostics.reportError', async () => {
      await (await native()).ReportRendererError(report);
    }),
  onFilesDropped: (listener, error) => subscribeDeferred(loadEvents, 'native:files-dropped', parseDropped, listener, error),
  onNotification: (listener, error) => subscribeDeferred(loadEvents, 'notifications:open', parseNotification, listener, error),
  onPreviewClosed: (listener, error) =>
    subscribeDeferred(
      loadEvents,
      'preview:closed',
      (value) => {
        if (!record(value) || typeof value.session !== 'string') return invalid('preview:closed');
        return { session: value.session };
      },
      listener,
      error
    )
};
