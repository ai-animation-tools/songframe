/**
 * Порядок в build/release: только поставки и их отчёты.
 * prepare <linux|win> — до сборки удаляет прежние отметки приёмки этой платформы (старый SHA256 и отчёт
 * не должны лежать рядом с новым файлом, пока его не проверили заново) и промежуточные каталоги прошлых упаковок.
 * tidy — после сборки удаляет промежуточные папки и служебные файлы electron-builder.
 * Лишние аргументы (например, `--publish never` из прежних команд) игнорируются.
 */
import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const release = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'build/release');
const ACCEPTANCE = {
  linux: (name) => name.endsWith('.AppImage.sha256') || name === 'linux-smoke-result.json',
  win: (name) => name.endsWith('.zip.sha256') || name === 'windows-archive-check.json'
};
// Папку переноса оставлял прерванный smoke AppImage: она пустая или содержит перенесённый файл, который удаляется вместе с ней.
const LEFTOVER = (name) => name === 'Перенос AppImage с пробелами';
// Промежуточные каталоги electron-builder, включая `*-unpacked.tmp`, который остаётся после прерванной упаковки.
const UNPACKED = (name) => /-unpacked(\.tmp)?$/.test(name);
const BUILDER = (name) => UNPACKED(name) || name === 'builder-debug.yml' || name === 'builder-effective-config.yaml' || /^latest.*\.yml$/.test(name);

async function remove(match) {
  let names;
  try {
    names = await readdir(release);
  } catch {
    return;
  }
  for (const name of names.filter(match)) await rm(join(release, name), { recursive: true, force: true });
}

const [command, platform] = process.argv.slice(2);
if (command === 'prepare' && ACCEPTANCE[platform]) await remove((name) => ACCEPTANCE[platform](name) || LEFTOVER(name) || UNPACKED(name));
else if (command === 'tidy') await remove(BUILDER);
else throw new Error('Использование: release-dir.mjs prepare <linux|win> | tidy');
