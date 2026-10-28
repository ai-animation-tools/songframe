# Дополнительные лицензии upstream

В wheel CTranslate2 4.8.3 отсутствует файл лицензии. `CTranslate2-LICENSE` взят без изменений из [тега v4.8.3](https://github.com/OpenNMT/CTranslate2/blob/v4.8.3/LICENSE), SHA256 `54aa79d9fe3c09e67a16dcd95b9e88676405a6ec174efda31036983cf7672ecb`. При подготовке он копируется в `runtime/licenses/upstream`.

Прочие тексты и уведомления wheels собирает `collect-licenses.py`, включая Visual C++ runtime и ONNX Runtime. Лицензия Python сохранена внутри исходной поставки. Комплект CTranslate2 может содержать сторонние нативные библиотеки: в Windows wheel есть `libiomp5md.dll` и `cudnn64_9.dll`. Их наличие не означает использование GPU приложением. Нативные импорты и распознавание на CPU проверены в Windows VM; это не подтверждает работу CUDA. MIT CTranslate2 не заменяет условия сторонних библиотек. [Условия NVIDIA cuDNN](https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/eula.html).

Для Linux дополнительные уведомления CPython и статических зависимостей берутся из полного архива того же выпуска python-build-standalone в runtime/licenses/cpython. Отсутствующие в wheels тексты FlatBuffers и tokenizers сохраняются в runtime/licenses/upstream по закреплённому linux-licenses-lock.json. Итоговый перечень ресурсов, версий и уведомлений формирует after-pack.cjs.

Лицензия шрифта DejaVu Sans для карточек аниматика хранится не здесь, а рядом со шрифтом в `tools/render_animatic_cards/fonts/`; after-pack.cjs включает её в перечень уведомлений Linux-поставки.
