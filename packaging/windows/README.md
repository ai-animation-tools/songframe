# Ранняя Windows-поставка Go/Wails

Цель — Windows 10/11 x64 (AMD64), отдельный профиль `songframe-go-dev` в `%APPDATA%`. Нативная установка и работа проверяются пользователем в VM; Linux-кросс-сборка этого не подтверждает.

## Сборка на Linux

```sh
wails3 task package:windows
```

Нужны Go/Wails CLI 3.0.0 и frontend-зависимости проекта, Docker с существующим `wails-cross:latest` (Go 1.26+, Zig cc с MinGW ABI), `makensis`, `7z`, `objdump`, Python 3 и curl. Образ сборщика фиксируется в receipt. Веса и runtime моделей в образ не устанавливаются. Используются локальные Go modules и отдельные build/zig caches; read-only Docker config при необходимости задаётся через `DOCKER_CONFIG`.

[package-windows.sh](../../scripts/package-windows.sh) заново собирает frontend, создаёт временный PE syso с иконкой/отдельным app ID/asInvoker/DPI, собирает основной exe с **CGO_ENABLED=1** и Windows GUI subsystem, затем NSIS. Ресурс удаляется trap. Версия — из `packaging/VERSION`, числовой PE version — её основной номер плюс четвёртая часть.

Для Zig передаётся `-extldflags=-Wl,--subsystem,windows` вместе с Go `-H windowsgui`. Одного Go-флага в проверенном toolchain оказалось недостаточно: предварительный PE оставался консольным. Проверка заголовка не позволяет такому exe попасть в комплект. Чужая обёртка компилятора не используется.

Результат — `build/release/songframe-go-<VERSION>-win-x64-setup.exe`, рядом `.sha256` и `.build.json`. [check-windows-package.py](../../scripts/check-windows-package.py) сверяет AMD64/GUI/resources/asInvoker, Go build info CGO/ORT, системные PE imports и хеш извлечённого из NSIS app exe; проверяет bootstrapper, VC prerequisite, лицензии, uninstaller и отсутствие встроенных ORT/ONNX. Windows-код не запускается, receipt содержит `nativeWindowsTested: false`.

## Установка и prerequisites

[installer.nsi](installer.nsi) ставит SongFrame Go текущему пользователю в `%LOCALAPPDATA%\Programs\SongFrame Go`, создаёт ярлыки и запись удаления HKCU. Само приложение и его установщик не требуют повышения прав. Запущенный exe не завершается принудительно: установщик просит закрыть его. Удаление сохраняет профиль, проекты и внешние компоненты.

Microsoft WebView2 обнаруживается по pv в HKLM/HKCU. Отсутствующий runtime ставится встроенным официальным bootstrapper `/silent /install`; для этого нужен интернет. После установки проверяется действительное наличие runtime, а не только exit code. Источник — [документация Microsoft](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution). Bootstrapper берётся из закреплённого Wails 3.0.0, SHA проверяется.

Оболочка не требует ORT и моделей. Для отдельного Windows ORT нужен Microsoft Visual C++ 14 Runtime x64. Официальный `vc_redist.x64.exe` включён в `prerequisites` рядом с установленным приложением, автоматически не запускается. При его необходимости пользователь запускает его отдельно и подтверждает системные права. [Источник Microsoft](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170); URL и проверенный SHA закреплены в сборочном скрипте. Это не установка Python/Node/Go и не часть собственного runtime приложения.

FFmpeg/ffprobe, ORT и модели устанавливаются через экран «Компоненты». Установщик не читает прежний профиль Electron и не переносит клипы.

## Ручная проверка в VM

1. Запустить setup обычным пользователем. Проверить завершение установки, ярлыки и запуск окна без консоли/UAC приложения; если WebView2 отсутствует, дать bootstrapper завершить загрузку.
2. Открыть «Компоненты» без установленных ORT/моделей: окно и навигация должны оставаться доступны. При необходимости установить VC prerequisite из папки приложения, затем компоненты. Готовность CTC-модели подтверждается настоящей CPU session/inference встроенной проверкой.
3. Повторно открыть приложение: установленные компоненты должны использоваться без повторного скачивания. Проверить закрытие, повторную установку/удаление и сохранность профиля; полный CTC workflow относится к следующему этапу.

Записать фактический результат и ошибки. Предупреждение Windows о неподписанном локальном пакете не является результатом native smoke. Сборка не разрешает commit, push или выпуск релиза.

При отдельном поручении положить комплект в общую папку VirtualBox сначала прочитать её реальный путь через VBoxManage. Копировать только текущий setup и краткую инструкцию. Служебные проверки копирования выполнять внутри инструмента, не добавлять SHA-файлы и не поручать пользователю их сверять без запроса. Старые тестовые файлы удалять только в разрешённой пользователем папке; VM не запускать, если пользователь проверяет её сам.

### Фоновые медиапроцессы Windows

`mediaRunner` применяет Windows `CREATE_NO_WINDOW` и `HideWindow` к каждому FFmpeg/ffprobe; GUI subsystem родительского exe не скрывает окна дочерних console exe. Контракт переносит поведение исходных sources/environment/PythonLauncher с `windowsHide: true`. Windows-регрессия `TestMediaProcessNoConsole` запускает console test exe через production runner и проверяет `GetConsoleWindow == 0`; её кросс-компиляция подтверждена, нативный результат требует Windows. Unix-вызовы не меняются.
