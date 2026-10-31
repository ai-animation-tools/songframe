/** Не позволяет упаковать приложение без runtime целевой ОС. @link README.md */
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

module.exports = async function beforePack(context) {
  const target = `${context.electronPlatformName}-${context.arch === 1 ? 'x64' : context.arch}`;
  const root = join(context.packager.projectDir, 'build/runtime', target);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const executable = join(root, 'python', context.electronPlatformName === 'win32' ? 'python.exe' : 'bin/python3');
  if (manifest.target !== target || !existsSync(executable)) throw new Error(`Нет runtime для ${target}. Выполните yarn prepare:runtime --target=${target}.`);
  if (['linux', 'win32'].includes(context.electronPlatformName)) {
    // Упаковка не выпускает приложение с отсутствующими или повреждёнными медиабинарниками.
    const lock = JSON.parse(readFileSync(join(__dirname, 'media-lock.json'), 'utf8'));
    await require('./media-files.cjs').verifyMedia(root, lock, target);
  }
  if (context.electronPlatformName === 'win32') {
    // Предотвращает повтор ошибки CMD с обрывками команд после смены кодировки/переносов.
    const cmd = readFileSync(join(context.packager.projectDir, 'scripts/runtime/windows/check-runtime.cmd'));
    if (cmd.some((byte) => byte > 127) || /(?<!\r)\n/.test(cmd.toString('ascii')))
      throw new Error('check-runtime.cmd должен содержать только ASCII и переносы CRLF.');
    // Деинсталлятор установщика NSIS извлекается без Wine.
    require('./nsis-uninstaller.cjs').useUninstallerReader(context.packager.projectDir);
  }
};
