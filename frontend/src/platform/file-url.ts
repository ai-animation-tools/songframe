/**
 * Адрес локального файла на медиасервере Go (internal/media.FileURL): /file/<путь по сегментам>.
 * Каждый сегмент кодируется отдельно, поэтому пробелы,
 * кириллица, '#', '?' и диск Windows (C:) не ломают URL; query вроде ?v=sha добавляет вызывающий.
 * Порт временный: такие адреса не сохраняются в файлы проекта.
 */
export function fileUrl(base: string, path: string): string {
  const segments = path.split('\\').join('/').replace(/^\/+/, '').split('/');
  return `${base}/file/${segments.map(encodeURIComponent).join('/')}`;
}
