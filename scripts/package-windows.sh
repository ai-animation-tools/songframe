#!/usr/bin/env bash
# Windows CGO-путь собирается отдельно от Linux и не включает runtime моделей.
# Состав и PE-заголовок проверяются до выдачи установщика для ручной приёмки в VM.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
root=$PWD
version=$(cat packaging/VERSION)
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo 'Некорректная packaging/VERSION.' >&2; exit 1; }
numeric="${version%%-*}.0"
work="$root/build/packaging/windows"
out="$root/build/release"
mkdir -p "$work/prerequisites" "$out" "$root/build/windows"
[[ $(wails3 version 2>&1) = *v3.0.0* ]] || { echo 'Нужен Wails CLI v3.0.0.' >&2; exit 1; }
# Frontend не меняется на целевой машине; Node/Go/Python нужны только сборщику.
wails3 task bindings
wails3 task frontend
python3 - "$version" "$numeric" <<'PY'
import json
import pathlib
import sys
version, numeric = sys.argv[1:]
info = {'fixed': {'file_version': numeric}, 'info': {'0419': {
    'ProductVersion': version, 'CompanyName': 'SongFrame',
    'FileDescription': 'SongFrame — ранняя версия Go/Wails',
    'LegalCopyright': '© 2026 Yarkov Aleksey', 'ProductName': 'SongFrame',
    'OriginalFilename': 'songframe.exe'}}}
pathlib.Path('build/windows/info.json').write_text(json.dumps(info, ensure_ascii=False))
PY
syso="$root/songframe_windows_amd64.syso"
[[ ! -e $syso ]] || { echo 'Временный Windows syso уже существует; проверьте незавершённую сборку.' >&2; exit 1; }
trap 'rm -f -- "$syso"' EXIT
wails3 generate syso -arch amd64 -icon resources/icon.ico -manifest packaging/windows/app.manifest -info build/windows/info.json -out "$syso"
# Zig обеспечивает MinGW ABI для ONNX C shim. GUI-флаг передаётся и внешнему линкеру:
# одного Go -H windowsgui у этого toolchain недостаточно, что проверяет PE checker.
cache="${SONGFRAME_WINDOWS_BUILD_CACHE:-${TMPDIR:-/tmp}/songframe-cross-cache}"
mkdir -p "$cache"
image="${SONGFRAME_WINDOWS_CROSS_IMAGE:-wails-cross:latest}"
docker image inspect "$image" >/dev/null
docker run --rm --user "$(id -u):$(id -g)" --entrypoint /usr/local/go/bin/go \
  -v "$root:/src:ro" -v "$root/build/windows:/out" -v "$(go env GOMODCACHE):/deps:ro" -v "$cache:/cache" \
  -e GOOS=windows -e GOARCH=amd64 -e CGO_ENABLED=1 -e 'CC=/usr/local/bin/zig cc -target x86_64-windows-gnu' \
  -e GOCACHE=/cache/go -e GOMODCACHE=/deps -e ZIG_GLOBAL_CACHE_DIR=/cache/zig -e HOME=/tmp -e GOTOOLCHAIN=local \
  -w /src "$image" build -buildvcs=false -tags production -trimpath \
  -ldflags "-s -w -H windowsgui -extldflags=-Wl,--subsystem,windows -X songframe-go/internal/appversion.Version=$version" -o /out/songframe.exe .
wails3 generate webview2bootstrapper -dir "$work/prerequisites"
printf '%s  %s\n' 7ebc4ce80143ef89cea86a61ea151502868db6caaa678b8b43660a66ace11c3a "$work/prerequisites/MicrosoftEdgeWebview2Setup.exe" | sha256sum --check
vc="$work/prerequisites/vc_redist.x64.exe"
if [[ ! -f $vc ]]; then
  curl --fail --location --retry 2 https://aka.ms/vc14/vc_redist.x64.exe -o "$vc.part"
  mv -- "$vc.part" "$vc"
fi
# Закреплён файл Microsoft, проверенный для ранней поставки. Изменение permalink требует проверки нового SHA.
printf '%s  %s\n' 843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c "$vc" | sha256sum --check
python3 scripts/package-notices.py "$work" windows
installer="$out/songframe-$version-win-x64-setup.exe"
makensis -WX "-DVERSION=$version" "-DNUMERIC_VERSION=$numeric" "-DBINARY=$root/build/windows/songframe.exe" \
  "-DWEBVIEW_BOOTSTRAPPER=$work/prerequisites/MicrosoftEdgeWebview2Setup.exe" "-DVC_REDIST=$vc" \
  "-DOUTPUT=$installer" "-DICON=$root/resources/icon.ico" "-DLICENSES=$work/licenses" packaging/windows/installer.nsi
python3 scripts/check-windows-package.py "$root/build/windows/songframe.exe" "$installer" "$version" "$image"
printf 'Готово: %s\n' "$installer"
