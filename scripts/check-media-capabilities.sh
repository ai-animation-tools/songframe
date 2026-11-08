#!/bin/sh
# Проверяет рецепты обработки SongFrame на явно выбранном медиакомплекте, без проекта и моделей.
# Go-инструмент scripts/packtool создаёт только синтетические WAV/PNG и проверяет результаты ffprobe;
# это инструмент разработчика.
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  printf '%s\n' 'Использование: sh scripts/check-media-capabilities.sh КАТАЛОГ_С_FFMPEG_И_FFPROBE' >&2
  exit 2
fi
media_bin=$(CDPATH= cd -- "$1" && pwd -P)
repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
for program in ffmpeg ffprobe; do
  if [ ! -x "$media_bin/$program" ]; then
    printf 'Не найден исполняемый файл: %s/%s\n' "$media_bin" "$program" >&2
    exit 1
  fi
done
command -v go >/dev/null 2>&1 || { printf '%s\n' 'Для проверки разработчика нужен Go.' >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/SongFrame медиа.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Один процесс владеет фикстурами и ограничивает длительность каждой команды. Ошибка сохраняет
# понятное имя операции и диагностику бинарника; shell удаляет временные данные и при прерывании.
go -C "$repository" run ./scripts/packtool media-check "$media_bin" "$work" "$repository/internal/components/manifest.json"
