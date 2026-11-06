/** Имя папки пакета для монтажёра: отметка времени с секундами, чтобы сборки не занимали одну папку. */

const AUTOMATIC_NAME = /edit-bundle-\d{8}-\d{4,6}$/;

/** Имя новой папки пакета на момент date. */
export function bundleName(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `edit-bundle-${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Путь для следующей сборки: автоматическое имя заменяется новым, папка с именем пользователя сохраняется. */
export function renewedBundleTarget(target: string, date = new Date()): string {
  return target.replace(AUTOMATIC_NAME, bundleName(date));
}
