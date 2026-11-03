#!/bin/sh
# Генератор анализирует main.go с go:embed; в чистом checkout dist появится только после Vite.
# Временный index позволяет сгенерировать bindings до сборки и не входит в Git или готовую поставку.
set -eu
cd "$(dirname "$0")/.."
if [ ! -f frontend/dist/index.html ]; then
  mkdir -p frontend/dist
  printf '%s\n' '<!doctype html><html lang="ru"><body>Фронтенд ещё не собран.</body></html>' > frontend/dist/index.html
fi
wails3 generate bindings -ts -i -d frontend/bindings
