#!/usr/bin/env bash
# Обычный desktop-запуск AppImage проверяется через пользовательский systemd manager.
# Так процесс получает профиль сессии, как при двойном клике, а не разрешения агента.
set -euo pipefail
[[ $# = 2 && $1 = /* && $2 = /* ]] || { echo 'Аргументы: абсолютный AppImage и новая папка отчёта.' >&2; exit 1; }
[[ $(id -u) != 0 ]] || { echo 'Нужна графическая сессия обычного пользователя.' >&2; exit 1; }
image=$1
output=$2
[[ -x $image && ! -e $output ]] || { echo 'Нет исполняемого AppImage или папка отчёта уже существует.' >&2; exit 1; }
mkdir -m 700 -- "$output"
mkdir -m 700 -- "$output/config" "$output/cache" "$output/data"
# Передаём только адреса графической сессии и отдельное состояние проверки.
# FUSE и подготовка AppArmor проходят штатный путь; extract-and-run здесь не используется.
environment=("--setenv=SONGFRAME_GO_LOCAL_DIR=$output/profile" "--setenv=XDG_CONFIG_HOME=$output/config" "--setenv=XDG_CACHE_HOME=$output/cache" "--setenv=XDG_DATA_HOME=$output/data")
for name in DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS; do
  if [[ -n ${!name:-} ]]; then environment+=("--setenv=$name=${!name}"); fi
done
systemd-run --user --wait --pipe --collect --unit="songframe-go-smoke-$$" "${environment[@]}" \
  timeout 180s "$image" --smoke --smoke-report "$output/startup.json" --smoke-timeout 60s \
  > "$output/run.log" 2>&1
grep -q '"passed": true' "$output/startup.json"
cat "$output/startup.json"
