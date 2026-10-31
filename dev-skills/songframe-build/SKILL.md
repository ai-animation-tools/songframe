---
name: songframe-build
description: "Собрать и проверить Linux AppImage или Windows-установщик приложения SongFrame по запросу пользователя; не предназначен для публикации релиза."
argument-hint: "[os=linux|win]"
---

# Сборка SongFrame

Работай в корне репозитория SongFrame (в рабочем пространстве AI Animation Tools это папка `songframe/`); пути ниже отсчитываются от него. Сначала прочитай актуальные `AGENTS.md`, разделы сборки и проверки в `docs/development.md` и при необходимости `scripts/runtime/README.md`. Точный состав проверок перед выпуском — в шаге сборки `scripts/release/release.mjs`. Выполняй только запрошенные платформы и проверки; учитывай имеющиеся изменения в checkout и не изменяй чужие проекты.

## Вызов

| Задача | Codex | Claude Code |
| --- | --- | --- |
| Собрать платформы из запроса | `$songframe-build` | `/songframe-build` |
| Только Linux AppImage | `$songframe-build os=linux` | `/songframe-build os=linux` |
| Только Windows-установщик | `$songframe-build os=win` | `/songframe-build os=win` |

Аргумент `os` необязателен. Без него платформа берётся из запроса пользователя («AppImage» — Linux, «установщик для Windows» — Windows); если платформа не названа, собери обе.

Сборка использует Node из `.nvmrc`, Yarn из `package.json` и зависимости проекта. Команды ниже выполняются из корня репозитория. Готовые поставки находятся в `build/release`, вне Git. Для разовых журналов и временных файлов используй `/tmp`. Не копируй AppImage за пределы репозитория без явного поручения.

## Linux

- `yarn dist:linux` собирает AppImage с ресурсами.
- `yarn smoke:runtime` проверяет переносимый Python.
- Для проверки конечного AppImage по рецепту проекта подготовь внешнюю тестовую модель командой `yarn prepare:smoke-model`, затем выполни `yarn smoke:appimage --docker --model="$PWD/build/runtime/smoke-model" --output=/tmp/songframe-appimage-check`. Для повторного прогона выбери новую папку отчёта. Подготовка модели может требовать сеть; сама проверка в Docker идёт без сети.
- Успешный smoke создаёт рядом с AppImage файл SHA256 и `linux-smoke-result.json`. Сообщай отдельно о сборке и фактически выполненном smoke.

## Windows

На Linux выполни `yarn dist:win`, он выпускает установщик NSIS `build/release/songframe-<версия>-win-x64-setup.exe`. Для проверки возьми версию из `package.json` и запусти `python3 -B scripts/runtime/check-windows-installer.py "build/release/songframe-<версия>-win-x64-setup.exe" --version "<версия>"`; нужен системный `7z`. Проверка извлекает архив приложения из установщика, создаёт SHA256 и `build/release/windows-installer-check.json`; она проверяет содержимое и ресурсы, но не исполняет Windows-код. Не делай вывод о работоспособности установщика, runtime или полной поддержке Windows по результату этой проверки. Нативные проверки Windows в VM выполняй только по явному поручению.

В ответе укажи пути полученных файлов, выполненные проверки и их результат, а также существенные невыполненные проверки. Сборка не разрешает commit, push или публикацию; выпуск релиза выполняется отдельно по явному поручению.
