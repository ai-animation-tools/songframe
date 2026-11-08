#!/bin/sh
# Проверка не форматирует файлы сама: незапрошенная массовая правка скрыла бы содержательный diff.
# Список ограничен исходниками приложения; кэш и временные копии не обходятся.
set -eu
cd "$(dirname "$0")/.."
unformatted=$(gofmt -l ./*.go internal scripts/appimage-bootstrap)
if [ -n "$unformatted" ]; then
  printf 'Требуется gofmt:\n%s\n' "$unformatted"
  exit 1
fi
