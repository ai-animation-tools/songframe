/**
 * Деинсталлятор NSIS без Wine и без исполнения Windows-кода на сборщике. @link README.md
 *
 * electron-builder собирает деинсталлятор в два шага: промежуточный установщик с BUILD_UNINSTALLER
 * на Linux запускается через Wine и сам записывает uninstaller рядом с итоговым установщиком.
 * Вместо Wine подставляется собственный «toolset» (штатная переменная ELECTRON_BUILDER_WINE_TOOLSET_DIR):
 * его bin/wine ничего не исполняет, а извлекает деинсталлятор из промежуточного EXE штатным
 * UninstallerReader electron-builder (так же он поступает на macOS, где Wine недоступен).
 */
const { chmodSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');

/** Готовит toolset в build/ (вне Git) и включает его для текущей упаковки. */
function useUninstallerReader(projectDir) {
  const root = join(projectDir, 'build/nsis-uninstaller');
  // Проверка electron-builder требует у toolset каталогов wine-home и lib; они остаются пустыми.
  for (const name of ['bin', 'wine-home', 'lib']) mkdirSync(join(root, name), { recursive: true });
  const wine = join(root, 'bin/wine');
  writeFileSync(wine, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(__filename)} "$@"\n`);
  chmodSync(wine, 0o755);
  process.env.ELECTRON_BUILDER_WINE_TOOLSET_DIR = root;
}

function quote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function extract(installer) {
  // Путь совпадает с UNINSTALLER_OUT_FILE из NsisTarget electron-builder: `<имя установщика без exe>__uninstaller.exe`.
  const uninstaller = join(dirname(installer), `${basename(installer, 'exe')}__uninstaller.exe`);
  const { UninstallerReader } = require('app-builder-lib/out/targets/nsis/nsisUtil');
  await UninstallerReader.exec(installer, uninstaller);
  if (!existsSync(uninstaller)) throw new Error(`Деинсталлятор не извлечён из ${installer}.`);
}

module.exports = { useUninstallerReader };

if (require.main === module) {
  const [installer] = process.argv.slice(2);
  if (!installer) {
    console.error('Использование: nsis-uninstaller.cjs <промежуточный установщик NSIS>');
    process.exit(2);
  }
  extract(installer).catch((error) => {
    console.error(`Ошибка извлечения деинсталлятора NSIS: ${error.message}`);
    process.exit(1);
  });
}
