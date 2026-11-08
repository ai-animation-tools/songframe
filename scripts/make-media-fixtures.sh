#!/bin/sh
# Создаёт короткие синтетические медиа для нативной проверки кодеков, Range и путей Unicode.
# Нужны FFmpeg с libx264/libmp3lame/libvpx-vp9/libopus и realpath; настоящие клипы не читаются.
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  printf '%s\n' 'Использование: sh scripts/make-media-fixtures.sh КАТАЛОГ' >&2
  printf '%s\n' 'Укажите каталог вне репозитория либо внутри игнорируемого build/.' >&2
  exit 2
fi
command -v ffmpeg >/dev/null 2>&1 || { printf '%s\n' 'Не найден FFmpeg.' >&2; exit 1; }
command -v realpath >/dev/null 2>&1 || { printf '%s\n' 'Не найдена команда realpath.' >&2; exit 1; }
repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
destination=$(realpath -m -- "$1")
case "$destination" in
  "$repository"/build|"$repository"/build/*) ;;
  "$repository"|"$repository"/*)
    printf '%s\n' 'Медиа разрешено создавать только вне репозитория или внутри build/.' >&2
    exit 2
    ;;
esac

# Сначала проверяем весь набор: повторный запуск не заменяет даже одну существующую фикстуру.
for name in 'Тон с пробелом.wav' 'Тон с пробелом.mp3' 'Цвета и тон.mp4' 'Цвета и тон.webm'; do
  if [ -e "$destination/$name" ] || [ -L "$destination/$name" ]; then
    printf 'Файл уже существует, генерация отменена: %s\n' "$destination/$name" >&2
    exit 1
  fi
done
mkdir -p -- "$destination"
staging=$(mktemp -d "$destination/.media-fixtures.XXXXXXXX")
trap 'rm -rf -- "$staging"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Три секунды синусоиды и тестового изображения достаточны для seek, loop и декодирования.
# Временный каталог позволяет публиковать только полностью сформированные файлы.
ffmpeg -hide_banner -loglevel error -nostdin -n \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=3' \
  -c:a pcm_s16le "$staging/Тон с пробелом.wav"
ffmpeg -hide_banner -loglevel error -nostdin -n \
  -i "$staging/Тон с пробелом.wav" -c:a libmp3lame -b:a 128k "$staging/Тон с пробелом.mp3"
ffmpeg -hide_banner -loglevel error -nostdin -n \
  -f lavfi -i 'testsrc2=size=640x360:rate=25:duration=3' -i "$staging/Тон с пробелом.wav" \
  -c:v libx264 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart -shortest \
  "$staging/Цвета и тон.mp4"
ffmpeg -hide_banner -loglevel error -nostdin -n \
  -f lavfi -i 'testsrc2=size=640x360:rate=25:duration=3' -i "$staging/Тон с пробелом.wav" \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 6 -b:v 500k -c:a libopus -b:a 96k -shortest \
  "$staging/Цвета и тон.webm"

# Жёсткая ссылка атомарно отказывает при коллизии имени, включая файл, возникший во время FFmpeg.
# staging расположен на той же файловой системе; очистка временного имени сохраняет результат.
for name in 'Тон с пробелом.wav' 'Тон с пробелом.mp3' 'Цвета и тон.mp4' 'Цвета и тон.webm'; do
  ln -- "$staging/$name" "$destination/$name"
  printf '%s\n' "$destination/$name"
done
