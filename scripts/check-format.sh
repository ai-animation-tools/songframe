#!/bin/sh
# Проверка не форматирует файлы сама: незапрошенная массовая правка скрыла бы содержательный diff.
# Обходятся все каталоги с Go-кодом модуля (корень, internal, resources, scripts); frontend,
# кэш и результаты сборки — нет.
set -eu
cd "$(dirname "$0")/.."
unformatted=$(gofmt -l ./*.go internal resources scripts)
if [ -n "$unformatted" ]; then
  printf 'Требуется gofmt:\n%s\n' "$unformatted"
  exit 1
fi
