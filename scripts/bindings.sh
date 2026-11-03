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

# Wails оставляет пустую строку в конце модуля без событий. Убираем только хвост,
# чтобы повторная генерация сохраняла чистый diff без ручной правки generated-файлов.
# Go-сервисы отдают срезы и словари через wire.Fill, поэтому `T[] | null` и
# `{ [_ in string]?: T } | null` сужаются до контракта window.api (D-027): typecheck
# сверяет bindings с shared/types без ручных валидаторов. Nullable-указатели не меняются.
node --input-type=module <<'JS'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
function trimGenerated(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) trimGenerated(file);
    else if (entry.name.endsWith('.ts')) {
      const source = readFileSync(file, 'utf8');
      let result = source.trimEnd() + '\n';
      result = result.replace(/\[\] \| null/g, '[]');
      for (let previous = ''; previous !== result; ) {
        previous = result;
        result = result.replace(/\{ \[_ in string\]\?: ([^{}]+?) \} \| null/g, '{ [_ in string]: $1 }');
      }
      if (source !== result) writeFileSync(file, result);
    }
  }
}
trimGenerated('frontend/bindings');
JS
