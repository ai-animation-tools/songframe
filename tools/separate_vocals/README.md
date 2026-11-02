# separate_vocals

Отдельно выделяет вокал локальной ONNX-моделью и публикует готовый для прослушивания и дальнейшего распознавания WAV вне проекта. Операция не запускает ASR и не меняет MP3, текст или подтверждённую разметку.

## Запуск

Из корня комплекса, для выбранного проекта:

```sh
python3 -B tools/separate_vocals/separate_vocals.py --project /path/to/project --model kim-vocal-1 --models /path/to/models --output /path/to/local/vocal-results/new-unique-id
```

`--model` обязателен: `voc-ft`, `kim-vocal-1` или `kim-vocal-2`. Веса устанавливаются отдельно через [download_song_models](../download_song_models/README.md) с соответствующим `--component`. Нужны NumPy, ONNX Runtime и FFmpeg из [runtime](../../scripts/runtime/README.md); PyTorch и GPU не нужны. Модель работает через CPUExecutionProvider, без передачи аудио внешнему сервису. Файлы/рецепты и атрибуция UVR — в [song_timing](../song_timing/README.md).

`--output` должен быть новой папкой вне проекта. Повторное использование существующей папки отклоняется: новая попытка не заменяет принятую. В приложении папку задаёт штатный launcher в постоянном локальном состоянии; пути машины в результат не записываются.

## Результат

- `vocals.wav`: PCM16, stereo, 44 100 Гц; исходные число отсчётов, вступление, хвост и тишина сохраняются. Пики не нормализуются; только диапазон PCM16 ограничивается при кодировании. Параметры спектра, gain и основной выход берутся из закреплённого рецепта модели.
- `result.json`: `schemaVersion: 1`, `sourceSha256`, `modelId`, `modelSha256`, `recipeVersion: 1`, `sampleRate: 44100`, `channels: 2`, `samples`, `audioFile: "vocals.wav"`, `audioSha256`, `createdAt` с часовым поясом. Абсолютных путей нет.

Хеш модели проверяется до вычислений, хеш MP3 — до декодирования и перед публикацией. WAV сначала записывается во временный файл и атомарно переименовывается; `result.json` публикуется атомарно последним. Ошибка и отмена не создают готовую запись. Незавершённая новая папка не является результатом и не затрагивает предыдущие попытки. SIGTERM штатного задания проходит через завершение временной записи.

Для распознавания готового результата передать [align_lyrics](../align_lyrics/README.md) или [transcribe_local](../transcribe_local/README.md) вместе `--vocal-result /path/to/result.json` и `--song-models /path/to/models`. Эти команды проверяют MP3/WAV/метаданные до и после работы и повторно не вызывают MDX.

## Проверки

```sh
python3 -B tools/run_tests/run_tests.py --only test_separate_vocals test_song_timing test_transcribe_local test_align_lyrics
```

Синтетические тесты проверяют clock/тишину/stereo/пики, спектральный gain и вычитание Instrumental, source/model/audio SHA, устаревший рецепт и длину WAV, атомарную публикацию, сбой/отмену, сохранность прежнего результата и повторное использование без MDX. Реальные CPU smoke на синтетическом сигнале подтверждают совместимость весов, а не качество выделения настоящей песни.
