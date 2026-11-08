#!/usr/bin/env bash
# deb-пакет для Ubuntu 24.04: тот же production-бинарник, что в AppImage, но GTK4,
# WebKitGTK 6.0 и GStreamer ставит apt как зависимости пакета. Компоненты производства
# (FFmpeg, ORT, модели) в пакет не входят и устанавливаются из приложения.
set -euo pipefail
# Права файлов пакета не должны зависеть от umask сборщика: каталоги 755, файлы 644.
umask 022
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
root=$PWD
[[ $(uname -s) = Linux && $(uname -m) = x86_64 ]] || { echo 'Нужна Linux amd64.' >&2; exit 1; }
source /etc/os-release
[[ $ID = ubuntu && $VERSION_ID = 24.04 ]] || { echo 'Сборочный baseline — Ubuntu 24.04.' >&2; exit 1; }
version=$(cat packaging/VERSION)
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo 'Некорректная packaging/VERSION.' >&2; exit 1; }
# В версии Debian дефис отделяет ревизию пакета, а «~» сортируется раньше выпуска:
# 1.0.0-dev.47 становится 1.0.0~dev.47 и сортируется раньше выпуска 1.0.0.
debian_version=${version/-/\~}
work="$root/build/packaging/deb"
out="$root/build/release"
tree="$work/root"
rm -rf -- "$work"
mkdir -p "$tree/DEBIAN" "$out"
wails3 task build
install -D -m 755 build/bin/songframe "$tree/usr/bin/songframe"
install -D -m 644 packaging/linux/songframe.desktop "$tree/usr/share/applications/songframe.desktop"
install -D -m 644 resources/icon.png "$tree/usr/share/icons/hicolor/1024x1024/apps/songframe.png"
install -D -m 644 packaging/linux/deb/apparmor-songframe "$tree/etc/apparmor.d/songframe"
python3 scripts/package-notices.py "$tree" deb
install -m 644 LICENSE "$tree/usr/share/doc/songframe/copyright"
# Библиотеки берёт dpkg-shlibdeps по ELF бинарника; рантайм WebKit, который не виден в
# ELF (песочница, D-Bus proxy, плагины GStreamer, сертификаты), перечислен явно.
mkdir -p "$work/debian"
printf 'Source: songframe\n\nPackage: songframe\nArchitecture: amd64\n' > "$work/debian/control"
shlibs=$(cd "$work" && dpkg-shlibdeps -O --ignore-missing-info "$tree/usr/bin/songframe" | sed -n 's/^shlibs:Depends=//p')
[[ $shlibs = *libwebkitgtk-6.0* && $shlibs = *libgtk-4* ]] || { echo "dpkg-shlibdeps не нашёл GTK4/WebKitGTK 6.0: $shlibs" >&2; exit 1; }
runtime='bubblewrap, xdg-dbus-proxy, ca-certificates, libgstreamer-gl1.0-0, gstreamer1.0-plugins-base, gstreamer1.0-plugins-good, gstreamer1.0-libav, libgl1-mesa-dri'
size=$(du -sk --exclude=DEBIAN "$tree" | cut -f1)
sed -e "s|@VERSION@|$debian_version|" -e "s|@SIZE@|$size|" -e "s|@DEPENDS@|$shlibs, $runtime|" \
  packaging/linux/deb/control.in > "$tree/DEBIAN/control"
install -m 644 packaging/linux/deb/conffiles "$tree/DEBIAN/conffiles"
install -m 755 packaging/linux/deb/postinst packaging/linux/deb/prerm "$tree/DEBIAN/"
package="$out/songframe-$version-linux-amd64.deb"
rm -f -- "$package.new"
trap 'rm -f -- "$package.new"' EXIT
dpkg-deb --root-owner-group -Zxz --build "$tree" "$package.new" >/dev/null
mv -- "$package.new" "$package"
python3 scripts/package-metadata.py --deb "$package" "$tree" "$version"
printf 'Готово: %s\n' "$package"
