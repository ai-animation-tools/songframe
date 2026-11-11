#!/bin/sh
# Запускает команду с пониженным приоритетом процессора и диска: полный прогон проверок
# не отнимает отзывчивость у остальной работы машины. Приоритет наследуют все дочерние
# процессы (go test, Chromium Playwright, Vite). Где nice или ionice нет, команда идёт как есть.
set -eu
if command -v ionice >/dev/null 2>&1; then set -- ionice -c3 "$@"; fi
if command -v nice >/dev/null 2>&1; then set -- nice -n 19 "$@"; fi
exec "$@"
