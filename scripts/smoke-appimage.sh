#!/usr/bin/env bash
# Запуск конечного AppImage в чистой системе: свежий профиль, нет компонентов и сети.
# Host-профили и настоящие проекты не монтируются; результат обязан подтвердить React→Wails.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ $# = 2 && $1 = /* && $2 = /* ]] || { echo 'Аргументы: абсолютный AppImage и новая папка отчёта.' >&2; exit 1; }
[[ $(id -u) != 0 ]] || { echo 'Smoke должен запускаться обычным пользователем, без sudo.' >&2; exit 1; }
image=$1
output=$2
[[ -f $image && ! -e $output ]] || { echo 'Нет AppImage или папка отчёта уже существует.' >&2; exit 1; }
mkdir -m 700 -- "$output"
docker build -t songframe-smoke:ubuntu24 -f packaging/linux/smoke.Dockerfile packaging/linux
# В Docker внешние AppArmor/seccomp запрещают namespace даже исправной WebKit sandbox.
# Разрешаем namespace контейнеру; sandbox WebKit остаётся включённой. Это не тест desktop AppArmor setup.
docker run --rm --network=none --cap-drop=ALL \
  --security-opt "apparmor=${SONGFRAME_SMOKE_APPARMOR_PROFILE:-unconfined}" --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  --user "$(id -u):$(id -g)" --shm-size=512m \
  -v "$image:/package/SongFrame.AppImage:ro" -v "$output:/result" \
  songframe-smoke:ubuntu24 sh -ec '
    test "$(id -u)" != 0
    mkdir -m 700 -p "$HOME" "$XDG_RUNTIME_DIR"
    for command in node python3 go git ffmpeg ffprobe; do
      if command -v "$command" >/dev/null; then echo "Лишняя зависимость: $command" >&2; exit 1; fi
    done
    if test -e /usr/lib/x86_64-linux-gnu/libwebkitgtk-6.0.so.4; then
      echo "В системе неожиданно есть WebKitGTK" >&2; exit 1
    fi
    export SONGFRAME_GO_LOCAL_DIR=/result/profile
    timeout 90s xvfb-run -a dbus-run-session -- /package/SongFrame.AppImage --appimage-extract-and-run \
      --smoke --smoke-report /result/startup.json --smoke-timeout 60s
    grep -q '\''"passed": true'\'' /result/startup.json
  ' > "$output/run.log" 2>&1
cat "$output/startup.json"
