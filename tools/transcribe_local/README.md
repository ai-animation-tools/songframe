# transcribe_local

Локально распознаёт песню для рабочих речевых ориентиров. Использовать только при поручении на аудиоанализ; результаты ASR не являются доказанными границами слов и не меняют постановку.

```sh
python3 -B tools/transcribe_local/transcribe_local.py --model /absolute/path/to/local-model --output /tmp/recognition.json --allow-network
```

Модель должна быть заранее загружена; нужны `faster-whisper`, NumPy и FFmpeg. Приложение для Linux и Windows поставляет Python-библиотеки и FFmpeg/ffprobe через [runtime](../../scripts/runtime/README.md). Веса модели устанавливаются отдельно по [инструкции для Linux и Windows](../../README.md#модель-распознавания): инструмент [download_whisper_model](../download_whisper_model/README.md) использует встроенный Python через проектный launcher, системные Python, pip и hf не нужны. Прогресс виден в терминале; повторный запуск использует уже скачанные файлы. Launcher задаёт PATH на собственные бинарники и `SONGFRAME_MODEL_DIR`, а `align_lyrics` передаёт этот путь через `--model`. Флаг `--allow-network` снимает только проверку OS-изоляции: модель по-прежнему берётся только с диска (`local_files_only`), включены `HF_HUB_OFFLINE`, `HF_HUB_DISABLE_TELEMETRY`, `TRANSFORMERS_OFFLINE`. Аудио внешним сервисам не передаётся. Читает `source/track.mp3` текущего проекта, пишет указанный JSON с сегментами и словами. В JSON дополнительно записываются фактические `model_path` и `python_executable` для проверки поставки. Черновик разметки по этому JSON строит [align_lyrics](../align_lyrics/README.md).

Для ручного изолированного запуска можно использовать прежнюю команду `unshare -Urn python3 -B ...` без `--allow-network`; приложению это не требуется. Ошибка `unshare: write failed /proc/self/uid_map` относится к разрешениям namespace и возникает до загрузки Whisper. Поле `network` результата отражает фактический способ запуска и офлайн-настройки, а не заявляет изоляцию при прямом вызове.

По умолчанию `--device auto` использует CUDA при совместимой NVIDIA, достаточном объёме видеопамяти и доступных cuBLAS для CUDA 12/cuDNN 9; иначе CPU/int8. Помощник `hardware.py` используется и подсказкой в приложении, и ASR. Можно передать `--device cpu`, например при нехватке видеопамяти. Число CPU-потоков не больше восьми и не больше доступных системе. В JSON поля `hardware` и `method` отражают фактический выбор. Модель не ограничена medium: small, medium, large-v3-turbo и large-v3 используют тот же локальный формат CTranslate2.

Необязательные параметры: `--start`/`--end` в секундах полного трека, `--filter` для локального FFmpeg-фильтра, `--prompt` для подсказки ASR. Исходная песня не меняется; текст `source/text.md` остаётся точным текстом песни.

Тесты без модели и сети: `python3 -B tools/run_tests/run_tests.py --only test_transcribe_local`. Проверяют локальную загрузку и офлайн-настройки, прежнюю проверку ручного изолированного запуска и корректное поле `network` при прямом вызове.
