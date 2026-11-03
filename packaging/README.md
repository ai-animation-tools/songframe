# Ранние поставки Go/Wails

Сборка выполняется только в этом репозитории; соседние SongFrame и Forktopus используются как источники для чтения. [Скилл сборки](../dev-skills/songframe-go-build/SKILL.md) хранится здесь и подключён ссылками `.agents/skills` и `.claude/skills`.

Linux AppImage описан ниже; для Windows amd64 NSIS использовать [отдельный рецепт](windows/README.md) и `wails3 task package:windows`.

Это минимальная оболочка миграции, а не замена рабочего SongFrame. Версия раннего пакета находится в [VERSION](VERSION); номер не связан с релизами Electron. Commit, push и публикация в эту процедуру не входят.

## Состав и проверяемая платформа

Первая база — **Ubuntu 24.04 amd64, glibc 2.39**. Сборочная и доступная настольная машина — Ubuntu 24.04; изолированная проверка использует Ubuntu 24.04 Docker. Более старые glibc и другие дистрибутивы пока не приняты. Для Windows и macOS рецепт этого пакета не применяется.

AppImage содержит production Go-бинарник со встроенным frontend, GTK4, WebKitGTK 6.0 с helper processes, их библиотеки/ресурсы, bootstrap AppArmor и лицензионные материалы. Собственных Electron, Node, Python и Git нет. FFmpeg/ffprobe, ORT и модели находятся вне AppImage и устанавливаются пользователем через «Компоненты». Приложение использует отдельный прежний dev app ID `tools.songframe.go.dev` и профиль `songframe-go-dev`; smoke использует новые временные профили.

Системе нужны графическая сессия X11/Wayland, драйверы Mesa/GL/EGL/GBM, ALSA/PulseAudio, D-Bus, fonts/fontconfig, CA certificates, `bubblewrap`, `xdg-dbus-proxy` и GStreamer plugins. На Ubuntu базовый runtime устанавливается средствами ОС:

```sh
sudo apt install ca-certificates bubblewrap xdg-dbus-proxy \
  libgl1 libegl1 libgles2 libgl1-mesa-dri libgbm1 libasound2t64 fonts-dejavu-core \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-libav
```

AppImage не обещает встроить драйверы GPU и все кодеки внешнего медиа. Отсутствие библиотек старта исправляется до открытия приложения, а не экраном компонентов. Проверка WebView-медиа выполняется отдельно от FFmpeg/ORT.

Рецепт упаковки использует закреплённый Wails **3.0.0** и linuxdeploy с проверкой SHA-256 в [package-linux.sh](../scripts/package-linux.sh). Ресурсы WebKit перемещает штатный Wails generator; его рабочий каталог `usr/lib` сохраняется. [Руководство Wails](https://wails.io/guides/build/linux/) описывает этот способ сохранения песочницы.

## Команды сборки

Нужны Go 1.26+, C-компилятор, Wails CLI 3.0.0, Node/Yarn проекта, GTK4/WebKitGTK 6.0 development packages, `curl`, `file`, `pkg-config`, `dpkg-query` и Python 3 для сборочных метаданных/лицензий. Python не входит в runtime. В чистом checkout сначала `wails3 task deps`.

```sh
wails3 task check
wails3 task package:linux
```

`package:linux` заново генерирует bindings, проверяет TypeScript, собирает frontend и Go, упаковывает системные библиотеки через Wails, добавляет bootstrap и лицензии, финализирует AppImage. Финализация использует appimagetool из того же закреплённого linuxdeploy и runtime уже созданного Wails-образа; повторного обхода всех системных библиотек нет. Артефакты в `build/release`:

- `songframe-go-<VERSION>-linux-x86_64.AppImage`;
- рядом `<имя>.sha256` и `<имя>.build.json`: версия, исходный commit и dirty, SHA/размер, распакованный объём, минимум ОС и версия упаковщика.

AppImage оставлять в штатной папке. Повторная локальная сборка этой ранней версии заменяет её предыдущий локальный результат; отчёты проверок создавать в новой папке. Это не рецепт переиздания опубликованных релизов. Состав лицензий собирает [package-notices.py](../scripts/package-notices.py): материалы system/Go/frontend и MIT notice Forktopus. Сетевые компоненты и их собственные notices устанавливаются отдельным менеджером.

## Обычная локальная проверка

Сначала проверить конечный файл на хосте:

```sh
wails3 task smoke:host APPIMAGE=/absolute/file.AppImage OUTPUT=/tmp/new-host-check
```

Сценарий запускает конечный AppImage через пользовательский systemd manager, как обычная desktop-сессия: без разрешающего профиля агента и без `--appimage-extract-and-run`. Используются новый профиль и отдельные XDG config/cache/data, сохраняются `startup.json` и журнал. Проверяются также FUSE и штатная подготовка AppArmor; при первом запуске пользователь подтверждает системный диалог настройки. Если задача — получить локальную сборку для ручной проверки, начинать с него. Он подтверждает запуск на текущем хосте; переносимость и отсутствие скрытых системных зависимостей проверяются отдельно, когда это нужно задаче.

## Дополнительная проверка чистой системы

```sh
wails3 task smoke:appimage \
  APPIMAGE=/absolute/build/release/songframe-go-0.0.0-dev.41.4-linux-x86_64.AppImage \
  OUTPUT=/tmp/songframe-go-appimage-new-check
```

Сценарий [smoke-appimage.sh](../scripts/smoke-appimage.sh) собирает окружение из [smoke.Dockerfile](linux/smoke.Dockerfile), затем запускает конечный файл непривилегированным пользователем, без сети и без системных GTK/WebKit, Node, Python, Go, Git, FFmpeg/ORT/моделей. Новый профиль и `startup.json` сохраняются в выбранной папке. Успех — настоящий React frontend вызвал Wails State и подтвердил монтирование страницы. Сборка образа может требовать сеть; само приложение проверяется offline.

В Docker разрешены user namespaces и mount `/proc` внутренней sandbox через container security options (`seccomp`/`systempaths`), иначе внешние seccomp/AppArmor блокируют внутреннюю песочницу. Песочница WebKit остаётся включённой; эта проверка не подтверждает desktop AppArmor setup или FUSE mount. Если Ubuntu запрещает uid mapping даже для container unconfined, можно задать `SONGFRAME_SMOKE_APPARMOR_PROFILE` с именем уже установленного профиля, разрешающего userns. В среде агента проверен существующий профиль `chatgpt`; сценарий не создаёт и не изменяет политику хоста. Это свойство тестовой среды, а не зависимость распространяемого приложения. При read-only Docker config можно задать отдельный `DOCKER_CONFIG=/tmp/songframe-go-docker-config`; Go cache аналогично задаётся через `GOCACHE`.

В среде без FUSE используется `--appimage-extract-and-run`; ручное извлечение описано в [документации AppImage](https://docs.appimage.org/user-guide/run-appimages.html). Обычный desktop mount проверяется отдельно, если доступен `/dev/fuse`.

## AppArmor до WebKit

[Bootstrap](../scripts/appimage-bootstrap/main_linux.go) и [AppRun](linux/AppRun) адаптированы из [Forktopus](https://github.com/forktopus/forktopus/blob/main/scripts/appimage/main_linux.go), MIT notice сохранено. На Ubuntu с ограниченными user namespaces bootstrap проверяет **реальный bubblewrap** до GTK. Проверка Go Cloneflags с uid_map, записываемым родительским процессом, недостаточна: она может пройти, когда самому bwrap AppArmor уже запрещает uid mapping. Если требуется настройка, системный `zenity` запрашивает согласие, затем `pkexec` — пароль. Профиль разрешает userns только точному пути исходного AppImage. После настройки выполняется повторный запуск от обычного пользователя; перемещение файла может требовать новой настройки. Явная команда — `./file.AppImage --setup-apparmor`. Не выключать WebKit sandbox, глобальный AppArmor или sysctl ради запуска. Отмена завершает запуск без изменения политики.

Компонентный CLI smoke и `--help` не создают WebView и не требуют этой подготовки. GUI `--smoke` использует обычную песочницу. Автоматические тесты bootstrap подменяют `pkexec`/`zenity`; они не меняют конфигурацию машины.

## Установка компонентов и реальный CPU inference

Создать новый JSON-запрос с абсолютными путями четырёх **внешних** закреплённых файлов. Профиль должен ещё не существовать, его родитель должен существовать:

```json
{
  "profileDirectory": "/tmp/songframe-go-component-new-profile",
  "localFiles": {
    "ffmpeg": "/absolute/ffmpeg-linux.tar.xz",
    "ort-cpu": "/absolute/onnxruntime-linux-x64.tgz",
    "ctc-ru": "/absolute/alignment.onnx",
    "ctc-vocab": "/absolute/vocab.json"
  }
}
```

```sh
/absolute/file.AppImage --appimage-extract-and-run \
  --component-smoke-input /absolute/request.json \
  --component-smoke-report /absolute/result.json \
  --smoke-timeout 10m
```

Режим использует тот же `Manager.Install` и `Manager.Check`, что приложение. Четыре LocalFiles исключают сетевую загрузку; PATH отключён внутри проверочного менеджера. Вместо FFmpeg-архива разрешён абсолютный путь готовой программы `ffmpeg` с соседним `ffprobe`: менеджер подключает пригодную пару по месту и не распаковывает большой XZ повторно. ORT, CTC и словарь в обоих режимах действительно устанавливаются в новый профиль. Успешная установка проверяет SHA, staging, публикацию поколений и файлы. Далее проверяются FFmpeg recipes, загрузка отдельной ORT library/API 27, CPU provider и реальная CTC session. Секунда синтетического сигнала 16 kHz должна дать finite logits `[1,49,39]`. Изменения ML-рецепта, настоящие клипы и ручная разметка не нужны.

Код 0 и `status: ready` в отчёте означают готовность `ctc-existing-vocals`. Ошибки отдельных моделей проверяются по snapshot, а не только по возврату Check. Это короткий inference, не полный CTC workflow и не оценка качества трека. Профиль после проверки остаётся для осмотра; пользовательские профили не читаются. По умолчанию timeout 30s, для импорта большого XZ задавать явно 10m или больше; CreateSession учитывает отмену после возврата native-вызова.

## Границы приёмки

Раздельно записывать build, чистый GUI startup, установку/CPU inference, WebView audio/video, desktop AppArmor/FUSE и физическое аудио. Docker не подтверждает доступ к реальной звуковой карте. Windows amd64 и WebView2/VC++ prerequisites — отдельная работа; Linux не закрывает её.

## Защита Linux-рецепта от второго GTK/WebKit

Применяется только при явно запрошенной Linux-сборке. Правка рецепта сама по себе не запускает сборку, распаковку или очистку существующего AppImage.

Wails 3.0.0 может захватить helpers обеих установленных WebKit ABI. Сразу после generator рецепт вызывает `linux_runtime_policy.py prune APPDIR`: старые GTK2/3, WebKitGTK4.x/JavaScriptCore4.x, helpers и typelibs удаляются только если остающиеся ELF их не требуют. Анализ DT_NEEDED/SONAME выполняет readelf без запуска файлов. Внешние directory symlinks не обходятся. Общие GdkPixbuf/Pango/Cairo/libsoup сохраняются.

Перед финализацией отдельный `check` блокирует попадание старого стека в образ, в том числе при замаскированных именах файлов/SONAME. Он требует GTK4/WebKit6 и единственный current backend/helpers. Metadata повторно проверяет policy; предыдущий готовый AppImage заменяется только после успешной финализации нового файла. Go module cache и системные библиотеки не изменяются.

Адресная проверка рецепта без пересборки приложения:

```sh
python3 -B -m unittest discover -s scripts -p test_linux_runtime_policy.py -v
```

Проверены 9 синтетических сценариев, включая отказ финализатора до обращения к runtime/toolchain. Существующий AppImage по поручению пользователя не пересобирался и не запускался; новый размер и runtime этого рецепта пока не измерены.
