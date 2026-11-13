# Windows-поставка

Цель — Windows 10/11 x64 (AMD64), профиль `songframe-desktop` в `%APPDATA%`. Нативная установка и работа проверяются пользователем в VM; Linux-кросс-сборка этого не подтверждает.

## Сборка на Linux

```sh
wails3 task package:windows
```

Нужны Go/Wails CLI 3.0.0 и frontend-зависимости проекта, Docker с существующим `wails-cross:latest` (Go 1.26+, Zig cc с MinGW ABI), `makensis`, `7z`, `objdump` и curl. Образ сборщика фиксируется в receipt. Веса и runtime моделей в образ не устанавливаются. Используются локальные Go modules и отдельные build/zig caches; read-only Docker config при необходимости задаётся через `DOCKER_CONFIG`.

[package-windows.sh](../../scripts/package-windows.sh) заново собирает frontend, создаёт временный PE syso с иконкой/отдельным app ID/asInvoker/DPI, собирает основной exe с **CGO_ENABLED=1** и Windows GUI subsystem, затем NSIS. Ресурс удаляется trap. Версия — из `packaging/VERSION`, числовой PE version — `X.Y.Z.0` из её номера без суффикса.

Для Zig передаётся `-extldflags=-Wl,--subsystem,windows` вместе с Go `-H windowsgui`. Одного Go-флага в проверенном toolchain оказалось недостаточно: предварительный PE оставался консольным. Проверка заголовка не позволяет такому exe попасть в комплект. Чужая обёртка компилятора не используется.

Результат — `build/release/songframe-<VERSION>-win-x64-setup.exe`, рядом `.sha256` и `.build.json`. Подкоманда `check-windows` инструмента [packtool](../../scripts/packtool/windows.go) сверяет AMD64/GUI/resources/asInvoker, Go build info CGO/ORT, вшитую версию `packaging/VERSION`, системные PE imports и хеш извлечённого из NSIS app exe; проверяет bootstrapper, DLL Visual C++ рядом с exe, лицензии, uninstaller и отсутствие встроенных ORT/ONNX. Windows-код не запускается, receipt содержит `nativeWindowsTested: false`.

## Установка и prerequisites

[installer.nsi](installer.nsi) ставит SongFrame текущему пользователю в `%LOCALAPPDATA%\Programs\SongFrame Desktop`, создаёт ярлыки «SongFrame» и запись удаления HKCU `SongFrameDesktop`. Профиль приложения — `%APPDATA%\songframe-desktop`. Само приложение и его установщик не требуют повышения прав. Запущенный exe не завершается принудительно: установщик просит закрыть его. Удаление сохраняет профиль, проекты и внешние компоненты.

Microsoft WebView2 обнаруживается по pv в HKLM/HKCU. Отсутствующий runtime ставится встроенным официальным bootstrapper `/silent /install`; для этого нужен интернет. После установки проверяется действительное наличие runtime, а не только exit code. Источник — [документация Microsoft](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution). Bootstrapper берётся из закреплённого Wails 3.0.0, SHA проверяется.

Оболочка не требует ORT и моделей. Отдельно скачиваемый Windows ORT импортирует Microsoft Visual C++ 14 Runtime x64 (`msvcp140.dll`, `msvcp140_1.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`). Эти четыре DLL установщик кладёт рядом с `songframe.exe` (app-local): Windows ищет зависимости загружаемой DLL в папке программы, поэтому системная установка `vc_redist` и права администратора не нужны. Источник — сторонний zip-архив `msvc-runtime` 14.51.36231 с распространяемыми файлами Microsoft, его URL и SHA-256 закреплены в сборочном скрипте; DLL копируются без изменений по [REDIST list Microsoft](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution#visual-c-runtime-files), условия — `licenses/msvc-runtime/LICENSE`. Папку `prerequisites`, если она осталась от прежней установки, установщик удаляет.

FFmpeg/ffprobe, ORT и модели устанавливаются через экран «Компоненты».

## Ручная проверка в VM

1. Запустить setup обычным пользователем. Проверить завершение установки, ярлыки и запуск окна без консоли/UAC приложения; если WebView2 отсутствует, дать bootstrapper завершить загрузку.
2. Открыть «Компоненты» без установленных ORT/моделей: окно и навигация должны оставаться доступны. Установить компоненты: ONNX Runtime должен стать «Готов» без отдельной установки Visual C++. Готовность CTC-модели подтверждается настоящей CPU session/inference встроенной проверкой.
3. Повторно открыть приложение: установленные компоненты должны использоваться без повторного скачивания. Проверить закрытие, повторную установку/удаление и сохранность профиля; полный CTC workflow эта проверка не подтверждает.

4. Проверить обновление: положить рядом с setup файл `build/release/update-check.cmd` (создаётся вручную по образцу ниже) и запустить его в VM после установки. Установленное приложение получает подставной выпуск 99.0.0 с этим же установщиком, скачивает и сверяет его, запускает установщик и закрывается, как кнопка «Установить и перезапустить». Пройти установщик поверх установленной версии: приложение должно запуститься снова, «Компоненты», настройки и история — остаться. В консоли печатается отчёт `update.json` (`launchedInstaller: true`, `download.status: ready`).

```bat
@echo off
chcp 65001 >nul
set "SETUP=%~dp0songframe-<VERSION>-win-x64-setup.exe"
set "OUT=%TEMP%\songframe-update-check"
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%"
> "%OUT%\request.json" echo {"package": "%SETUP:\=\\%", "version": "99.0.0"}
start "" /wait "%LOCALAPPDATA%\Programs\SongFrame Desktop\songframe.exe" --update-smoke-input "%OUT%\request.json" --update-smoke-report "%OUT%\update.json"
type "%OUT%\update.json"
pause
```

Записать фактический результат и ошибки. Предупреждение Windows о неподписанном локальном пакете не является результатом native smoke. Сборка не разрешает commit, push или выпуск релиза.

При отдельном поручении положить комплект в общую папку VirtualBox сначала прочитать её реальный путь через VBoxManage. Копировать только текущий setup и краткую инструкцию. Служебные проверки копирования выполнять внутри инструмента, не добавлять SHA-файлы и не поручать пользователю их сверять без запроса. Старые тестовые файлы удалять только в разрешённой пользователем папке; VM не запускать, если пользователь проверяет её сам.

### Фоновые медиапроцессы Windows

Общий запуск `internal/process` применяет Windows `CREATE_NO_WINDOW` и `HideWindow` к каждой внешней программе (FFmpeg/ffprobe через `mediaRunner` и агенты); GUI subsystem родительского exe не скрывает окна дочерних console exe. Отмена завершает дерево через `%SystemRoot%\System32\taskkill.exe /T /F` только для живого процесса. Windows-регрессии `TestRunNoConsole` (process) и `TestMediaProcessNoConsole` (components) запускают console test exe через production-запуск и проверяют `GetConsoleWindow == 0`; для Windows они проходят проверку типов (process — `go vet`), нативный результат требует Windows. Unix-вызовы не меняются.
