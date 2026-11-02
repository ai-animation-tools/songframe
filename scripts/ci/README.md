# Выбор проверок CI

`classify-changes.mjs` выбирает наборы по путям, изменённым событием GitHub. Он не строит граф зависимостей и не запускает проверки самостоятельно. Настройка заданий принадлежит [ci.yml](../../.github/workflows/ci.yml).

- `release_only=true`: изменены файлы `scripts/release/` и, возможно, сопровождающие корневые Markdown, `docs/`, `dev-skills/`, `.agents/`, `.claude/`. Должен присутствовать хотя бы один файл сценария выпуска. `docs/providers/` является входом приложения и исключён из сопровождающей документации. Для этого случая достаточно адресных проверок сценария выпуска.
- `release_only=false`: сохраняются обычные проверки приложения и Python-инструментов.
- `browser=true`: затронуты renderer, shared, preload, `.storybook/`, `tests/storybook/`, `scripts/storybook/`, `resources/`, образец `tools/testdata/sample-project/` либо общие зависимости и конфигурация. Точный короткий перечень находится в `classifyChanges`; изменения main, инструментов, сценария выпуска и самого CI отдельно браузерный набор не запускают.

Push сравнивается целиком от `before` до `after`, PR — от общей базы `base...head`, включая все коммиты ветки. Rename рассматривается как удаление и добавление: старый путь также влияет на выбор проверок. Ручной запуск, нулевой `before`, пустой diff, неизвестное событие и недоступные данные включают полный набор, включая браузер.

Workflow передаёт стандартные `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_OUTPUT` и полную историю Git через `actions/checkout` с `fetch-depth: 0`. Команда:

```sh
node scripts/ci/classify-changes.mjs
```

В `GITHUB_OUTPUT` добавляются строки `release_only=true|false` и `browser=true|false`, в stdout выводится JSON с теми же флагами и причиной выбора. Локальные проверки классификатора используют только временные Git-репозитории:

```sh
node --test scripts/ci/classify-changes.test.mjs
```

`node-openssl.cnf` задаёт группы TLS для Node на домашних раннерах; его подключает workflow через `OPENSSL_CONF`.
