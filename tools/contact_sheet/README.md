# contact_sheet

Техническая сводка полученного видео для быстрого просмотра: параметры потока, контактный лист из двенадцати кадров с номерами и временем, первый и последний кадры, их сравнение с принятыми опорами пакета и превью на скорости 2×. Приложение вызывает инструмент сразу после получения видео (`downloaded`) и по кнопке «Сделать техническую сводку». Инструмент ничего не оценивает и не принимает: художественный просмотр и решение остаются за пользователем. Хеши не вычисляются, assets и реестр не меняются.

```sh
python3 -B tools/contact_sheet/contact_sheet.py --package plan/batches/M32-attempt-01
python3 -B tools/contact_sheet/contact_sheet.py --work-dir plan/awaiting/M32/request --out /tmp/M32-preview
python3 -B tools/contact_sheet/contact_sheet.py --video /tmp/candidate.mp4 --no-preview --json
```

`--package` берёт видео из попытки пакета `shot_workflow` и принятые опоры с ролями `first` и `last` для картинок сравнения `compare-first.png` и `compare-last.png`; `--work-dir` — только видео попытки; `--video` — произвольный файл. Попытка должна быть в состоянии `downloaded`. Результат по умолчанию пишется в `preview/` рядом с пакетом или видео: `contact-sheet.png` (сетка 4×3, кадры равномерно по длительности), `first-frame.png`, `last-frame.png`, `preview-2x.mp4` (960 px, без звука). Текстовая таблица заканчивается строкой «ожидает просмотра пользователем». Папка `preview/` не входит в комплект assets: `accept_shot` её не переносит, `--clean` удаляет вместе с пакетом.

## Тесты

Параметры потока, состав файлов, размеры сетки и кадров, превью, работа без пакета, отказ для нескачанной попытки.

```sh
python3 -B tools/contact_sheet/test_contact_sheet.py
python3 -B tools/run_tests/run_tests.py --only test_contact_sheet
```

Тесты создают короткое видео FFmpeg во временной папке. Для полного набора — [run_tests](../run_tests/README.md).
