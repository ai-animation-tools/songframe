# Источники поставляемого FFmpeg

В комплекты Linux и Windows входят самостоятельные ffmpeg и ffprobe из статического GPL-варианта BtbN. Windows поставляет ffmpeg.exe и ffprobe.exe. Приложение вызывает их отдельными процессами. Сохраняются исходный LICENSE.txt, документация дистрибутива и фактические флаги configure: в Linux — вывод `-version`, в Windows — строки из закреплённого PE без исполнения EXE; включены `--enable-gpl`, `--enable-version3`, libx264, исключён libfdk-aac. Текст лицензии выбранного комплекта — GNU GPL v3; его условия остаются действующими при распространении бинарников.

- [Неизменяемый месячный выпуск бинарников](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-30-13-08): n8.1.3-9-g29e619e767, Linux x64 и Windows x64.
- [Windows GPL ZIP](https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767-win64-gpl-8.1.zip) и [официальные SHA256](https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/checksums.sha256).
- [Исходный код FFmpeg выбранной версии](https://github.com/FFmpeg/FFmpeg/tree/29e619e767).
- [Рецепты и зависимости сборки](https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-09-30-13-08): scripts.d описывает включённые библиотеки, их версии и источники.
- [Правила лицензирования FFmpeg](https://ffmpeg.org/legal.html).

SHA256 архива и двоичных файлов находятся в media-lock.json и media-manifest.json. Полнота уведомлений всех транзитивных нативных библиотек и готовность к распространению требуют отдельной проверки; этот документ не заменяет тексты лицензий поставщиков.
