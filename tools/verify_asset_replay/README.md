# verify_asset_replay

Глубокая проверка воспроизведения всех выбранных сцен. Инструмент разработчика для аудита рецептов или масштабного переноса: приложение его не вызывает, для обычной приёмки он не требуется. Читает производный индекс `assets/shots/manifest.json` проекта, поэтому перед запуском представления должны быть актуальны ([update_scene_views](../update_scene_views/README.md)).

```sh
python3 -B tools/verify_asset_replay/verify_asset_replay.py --report /tmp/asset-replay.json
python3 -B tools/verify_asset_replay/verify_asset_replay.py --report /tmp/asset-replay.json --preserved /tmp/before.json
```

Копирует принятые клипы, повторяет фильтры из оригиналов во временной папке, проверяет длину/FPS/размер и сравнивает первый, средний и последний кадры. Это техническая выборочная проверка, а не просмотр видео целиком.

`--preserved` принимает снимок вида `{"media":{"assets/shots/M31/video.mp4":"SHA256"}}` с путями от корня проекта. Отчёт обязательно вне папки проекта; временные видео удаляются. Assets и полный аниматик не меняются. Может выполняться заметно дольше обычной проверки хешей.

## Тесты

Воспроизведение рецепта из синтетического оригинала в допуске RMS и обнаружение подменённого монтажа той же длины и формата. Запускают FFmpeg на временных файлах; assets проекта не читаются.

```sh
python3 -B tools/verify_asset_replay/test_verify_asset_replay.py
python3 -B tools/run_tests/run_tests.py --only test_verify_asset_replay
```
