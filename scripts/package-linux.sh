#!/usr/bin/env bash
# Ранний пакет собирается штатным Wails; компоненты производства живут вне AppImage.
# Финализация добавляет подготовку AppArmor, лицензии и проверяемые метаданные комплекта.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
root=$PWD
[[ $(uname -s) = Linux && $(uname -m) = x86_64 ]] || { echo 'Нужна Linux amd64.' >&2; exit 1; }
source /etc/os-release
[[ $ID = ubuntu && $VERSION_ID = 24.04 && $(getconf GNU_LIBC_VERSION) = "glibc 2.39" ]] || { echo 'Сборочный baseline — Ubuntu 24.04 / glibc 2.39.' >&2; exit 1; }
version=$(cat packaging/VERSION)
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo 'Некорректная packaging/VERSION.' >&2; exit 1; }
work="$root/build/packaging/linux"
out="$root/build/release"
mkdir -p "$work" "$out"
# SHA закрепляет скачанный executable даже при обновлении upstream-тега continuous.
# При изменении upstream нужно проверить новый инструмент и явно обновить эту пару.
linuxdeploy="$work/linuxdeploy-x86_64.AppImage"
expected=df908b19f1ed1cdafa79508d415aa12d6c56ce4d56d4149aa8c09286718706e5
if [[ ! -f $linuxdeploy ]]; then
  curl --fail --location --retry 2 'https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage' -o "$linuxdeploy.part"
  mv -- "$linuxdeploy.part" "$linuxdeploy"
fi
printf '%s  %s\n' "$expected" "$linuxdeploy" | sha256sum --check
chmod +x "$linuxdeploy"
[[ $(wails3 version 2>&1) = *v3.0.0* ]] || { echo 'Нужен Wails CLI v3.0.0.' >&2; exit 1; }
wails3 task build
cp resources/icon.png "$work/songframe.png"
# Wails размещает GTK/WebKit с relocation helpers и сохраняет sandbox.
wails3 generate appimage -binary "$root/build/bin/songframe" \
  -icon "$work/songframe.png" -desktopfile "$root/packaging/linux/songframe.desktop" \
  -outputdir "$out" -builddir "$work"
appdir="$work/songframe-x86_64.AppDir"
# Wails 3.0.0 ищет helpers обеих установленных WebKit ABI. Убираем старый стек
# только после проверки, что остающиеся ELF его не требуют; иначе сборка завершается ошибкой.
python3 scripts/linux_runtime_policy.py prune "$appdir" > "$work/runtime-prune.json"
mv -- "$appdir/AppRun" "$appdir/AppRun.wails"
mkdir -p "$appdir/usr/libexec"
CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w' \
  -o "$appdir/usr/libexec/songframe-appimage" ./scripts/appimage-bootstrap
python3 scripts/package-notices.py "$appdir"
export OUTPUT="$out/songframe-$version-linux-x86_64.AppImage" NO_STRIP=1
# Ошибка policy или упаковщика сохраняет предыдущий готовый AppImage.
trap 'rm -f -- "$OUTPUT.new"' EXIT
bash scripts/finalize-appimage.sh "$appdir" "$out/songframe-x86_64.AppImage" "$OUTPUT.new" "$linuxdeploy"
mv -- "$OUTPUT.new" "$OUTPUT"
# Имя без версии — промежуточный результат Wails, не самостоятельный комплект.
rm -- "$out/songframe-x86_64.AppImage"
python3 scripts/package-metadata.py "$OUTPUT" "$appdir" "$linuxdeploy" "$version"
printf 'Готово: %s\n' "$OUTPUT"
