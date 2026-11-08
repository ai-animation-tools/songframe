#!/usr/bin/env bash
# Установка deb-пакета в чистую Ubuntu 24.04 и запуск приложения: свежий профиль, нет
# компонентов и сети. Подтверждает, что Depends пакета достаточно для React→Wails.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ $# = 2 && $1 = /* && $2 = /* ]] || { echo 'Аргументы: абсолютный deb и новая папка отчёта.' >&2; exit 1; }
[[ $(id -u) != 0 ]] || { echo 'Smoke должен запускаться обычным пользователем, без sudo.' >&2; exit 1; }
package=$1
output=$2
[[ -f $package && ! -e $output ]] || { echo 'Нет deb или папка отчёта уже существует.' >&2; exit 1; }
mkdir -m 700 -- "$output" "$output/context"
cp -- "$package" "$output/context/songframe.deb"
docker build -t songframe-deb-smoke:ubuntu24 -f packaging/linux/deb-smoke.Dockerfile "$output/context" > "$output/build.log" 2>&1
rm -rf -- "$output/context"
# Как в smoke:appimage: namespace разрешены контейнеру, песочница WebKit остаётся включённой.
docker run --rm --network=none --cap-drop=ALL \
  --security-opt "apparmor=${SONGFRAME_SMOKE_APPARMOR_PROFILE:-unconfined}" --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  --user "$(id -u):$(id -g)" --shm-size=512m -v "$output:/result" \
  songframe-deb-smoke:ubuntu24 sh -ec '
    test "$(id -u)" != 0
    mkdir -m 700 -p "$HOME" "$XDG_RUNTIME_DIR"
    for command in node python3 go git ffmpeg ffprobe; do
      if command -v "$command" >/dev/null; then echo "Лишняя зависимость: $command" >&2; exit 1; fi
    done
    test -x /usr/bin/songframe && test -f /etc/apparmor.d/songframe && test -f /usr/share/applications/songframe.desktop
    export SONGFRAME_GO_LOCAL_DIR=/result/profile
    timeout 90s xvfb-run -a dbus-run-session -- songframe --smoke --smoke-report /result/startup.json --smoke-timeout 60s
    grep -q '\''"passed": true'\'' /result/startup.json
  ' > "$output/run.log" 2>&1
cat "$output/startup.json"
