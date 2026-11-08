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
# Frontend не меняется на целевой машине; Node и Go нужны только сборщику.
wails3 task bindings
wails3 task frontend
go run ./scripts/packtool windows-info "$version" "$numeric" build/windows/info.json
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
  -ldflags "-s -w -H windowsgui -extldflags=-Wl,--subsystem,windows -X songframe/internal/appversion.Version=$version" -o /out/songframe.exe .
wails3 generate webview2bootstrapper -dir "$work/prerequisites"
printf '%s  %s\n' 7ebc4ce80143ef89cea86a61ea151502868db6caaa678b8b43660a66ace11c3a "$work/prerequisites/MicrosoftEdgeWebview2Setup.exe" | sha256sum --check
# Visual C++ runtime для ORT кладётся рядом с songframe.exe (app-local, из архива msvc-runtime):
# LoadLibrary ищет зависимости onnxruntime.dll в папке программы, поэтому отдельная системная
# установка vc_redist и права администратора не нужны. Версия архива (zip) и его SHA-256
# закреплены ниже; DLL копируются без изменения по REDIST list Microsoft.
archive="$work/prerequisites/msvc_runtime-14.51.36231-cp312-cp312-win_amd64.whl"
if [[ ! -f $archive ]]; then
  curl --fail --location --retry 2 https://files.pythonhosted.org/packages/98/33/be9ef68901200813fc174a06758b4ae48ca4eb58fa783280dd879d5fd048/msvc_runtime-14.51.36231-cp312-cp312-win_amd64.whl -o "$archive.part"
  mv -- "$archive.part" "$archive"
fi
printf '%s  %s\n' 89f70d1a37bb64164cdb09d02dd82d6b1400e1310be2995b4ed5a9f23efe2222 "$archive" | sha256sum --check
vcruntime="$work/vcruntime"
rm -rf -- "$vcruntime"
mkdir -p "$vcruntime"
go run ./scripts/packtool extract-vcruntime "$archive" "$vcruntime"
go run ./scripts/packtool notices "$work" windows
mkdir -p "$work/licenses/msvc-runtime"
mv -- "$vcruntime/LICENSE" "$work/licenses/msvc-runtime/LICENSE"
installer="$out/songframe-$version-win-x64-setup.exe"
makensis -WX "-DVERSION=$version" "-DNUMERIC_VERSION=$numeric" "-DBINARY=$root/build/windows/songframe.exe" \
  "-DWEBVIEW_BOOTSTRAPPER=$work/prerequisites/MicrosoftEdgeWebview2Setup.exe" "-DVCRUNTIME=$vcruntime" \
  "-DOUTPUT=$installer" "-DICON=$root/resources/icon.ico" "-DLICENSES=$work/licenses" packaging/windows/installer.nsi
go run ./scripts/packtool check-windows "$root/build/windows/songframe.exe" "$installer" "$version" "$image"
printf 'Готово: %s\n' "$installer"
