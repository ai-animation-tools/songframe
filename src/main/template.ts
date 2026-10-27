/** Копирование шаблона проекта с подстановкой плейсхолдеров и обновление управляемого блока AGENTS.md. */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

export const BLOCK_BEGIN = '<!-- songframe:begin -->';
export const BLOCK_END = '<!-- songframe:end -->';
const TEXT_EXTENSIONS = new Set(['.md', '.json', '.txt', '.gitignore', '.gitkeep', '.yml', '.yaml']);

export type Placeholders = Record<string, string>;

export function renderPlaceholders(text: string, values: Placeholders): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key: string) => (key in values ? values[key] : match));
}

function isText(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? '';
  return TEXT_EXTENSIONS.has(extname(name) || name);
}

/** Рекурсивно копирует шаблон; текстовые файлы проходят подстановку, остальные копируются байт в байт. */
export function copyTemplate(source: string, target: string, values: Placeholders): string[] {
  const written: string[] = [];
  const walk = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const fromPath = join(from, entry.name);
      const toPath = join(to, entry.name);
      if (entry.isDirectory()) {
        walk(fromPath, toPath);
      } else if (isText(entry.name)) {
        writeFileSync(toPath, renderPlaceholders(readFileSync(fromPath, 'utf-8'), values), 'utf-8');
        written.push(toPath);
      } else {
        copyFileSync(fromPath, toPath);
        written.push(toPath);
      }
    }
  };
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`Шаблон проекта не найден: ${source}`);
  walk(source, target);
  return written;
}

/** Возвращает управляемый блок шаблона AGENTS.md с подставленными значениями. */
export function renderManagedBlock(templateAgents: string, values: Placeholders): string | null {
  const begin = templateAgents.indexOf(BLOCK_BEGIN);
  const end = templateAgents.indexOf(BLOCK_END);
  if (begin < 0 || end < 0 || end < begin) return null;
  return renderPlaceholders(templateAgents.slice(begin, end + BLOCK_END.length), values);
}

/**
 * Обновляет только блок между маркерами в существующем AGENTS.md проекта; текст владельца вне блока
 * не трогается. Файл без маркеров (проект создан не комплексом) остаётся как есть.
 */
export function syncManagedBlock(existing: string, block: string): string {
  const begin = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  if (begin >= 0 && end > begin) {
    return existing.slice(0, begin) + block + existing.slice(end + BLOCK_END.length);
  }
  return existing;
}
