#!/usr/bin/env bash
# Обновление готового AppImage на хосте: подставной выпуск с копией того же файла, скачивание
# со сверкой SHA, замена запущенного AppImage и перезапуск после выхода. Перезапущенная версия
# проходит обычный GUI smoke. Запуск — в отдельном scope пользовательского systemd, как у
# приложения из меню: помощник перезапуска переживает выход прежнего процесса.
set -euo pipefail
[[ $# = 2 && $1 = /* && $2 = /* ]] || { echo 'Аргументы: абсолютный AppImage и новая папка отчёта.' >&2; exit 1; }
[[ $(id -u) != 0 ]] || { echo 'Нужна графическая сессия обычного пользователя.' >&2; exit 1; }
image=$1
output=$2
[[ -x $image && ! -e $output ]] || { echo 'Нет исполняемого AppImage или папка отчёта уже существует.' >&2; exit 1; }
mkdir -m 700 -- "$output" "$output/config" "$output/cache" "$output/data"
cp -- "$image" "$output/package.AppImage"
before=$(sha256sum "$image" | cut -d' ' -f1)
printf '{"package": "%s", "version": "99.0.0", "relaunchReport": "%s"}\n' "$output/package.AppImage" "$output/relaunch.json" > "$output/request.json"
environment=("--setenv=SONGFRAME_GO_LOCAL_DIR=$output/profile" "--setenv=XDG_CONFIG_HOME=$output/config" "--setenv=XDG_CACHE_HOME=$output/cache" "--setenv=XDG_DATA_HOME=$output/data")
for name in DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS; do
  if [[ -n ${!name:-} ]]; then environment+=("--setenv=$name=${!name}"); fi
done
systemd-run --user --scope --quiet --unit="songframe-update-smoke-$$" "${environment[@]}" \
  timeout 120s "$image" --update-smoke-input "$output/request.json" --update-smoke-report "$output/update.json" \
  > "$output/run.log" 2>&1
# Новая версия запускается после выхода прежней; ждём отчёт её GUI smoke.
for _ in $(seq 1 120); do
  [[ -s $output/relaunch.json ]] && break
  sleep 1
done
grep -q '"passed": true' "$output/relaunch.json"
[[ $(sha256sum "$image" | cut -d' ' -f1) = "$(sha256sum "$output/package.AppImage" | cut -d' ' -f1)" ]]
[[ ! -e $image.update ]]
printf 'SHA до обновления совпадает с пакетом: %s\n' "$([[ $before = "$(sha256sum "$image" | cut -d' ' -f1)" ]] && echo да || echo нет)"
cat "$output/update.json" "$output/relaunch.json"
