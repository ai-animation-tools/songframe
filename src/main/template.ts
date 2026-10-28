/** Копирование шаблона проекта с подстановкой плейсхолдеров. */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

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
