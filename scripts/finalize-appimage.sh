#!/usr/bin/env bash
# Wails уже разместил зависимости и исправил RPATH: статический helper и notices не добавляют новых .so.
# Финализация меняет только AppRun и файловый образ, без повторного обхода всех библиотек linuxdeploy.
set -euo pipefail
[[ $# = 4 ]] || { echo 'Нужны AppDir, исходный AppImage, результат и linuxdeploy.' >&2; exit 1; }
appdir=$1
original=$2
output=$3
linuxdeploy=$4
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# Финальный gate действует и при отдельном вызове финализатора: грязный AppDir
# не должен попасть в образ или даже дойти до запуска runtime/toolchain.
# go -C меняет текущий каталог, поэтому относительный AppDir дописывается к каталогу вызова.
case $appdir in /*) policy_appdir=$appdir ;; *) policy_appdir=$PWD/$appdir ;; esac
go -C "$root" run ./scripts/packtool runtime-policy check "$policy_appdir"
toolchain="$(dirname -- "$appdir")/toolchain"
mkdir -p "$toolchain"
# Runtime берём из уже созданного Wails образа: финализация не скачивает другой runtime.
offset=$("$original" --appimage-offset)
[[ $offset =~ ^[0-9]+$ && $offset -gt 0 ]] || { echo 'Не найден offset AppImage.' >&2; exit 1; }
head -c "$offset" "$original" > "$toolchain/runtime-x86_64"
if [[ ! -x $toolchain/squashfs-root/plugins/linuxdeploy-plugin-appimage/appimagetool-prefix/AppRun ]]; then
  (cd "$toolchain" && "$linuxdeploy" --appimage-extract >/dev/null)
fi
cp -- "$root/packaging/linux/AppRun" "$appdir/AppRun"
ARCH=x86_64 "$toolchain/squashfs-root/plugins/linuxdeploy-plugin-appimage/appimagetool-prefix/AppRun" \
  --runtime-file "$toolchain/runtime-x86_64" "$appdir" "$output"
