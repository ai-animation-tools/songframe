# continuity_brief

Врезка непрерывности для плана: вычисленное состояние мира и героев словами и чек-лист вопросов для проверки сгенерированного кадра. Использовать перед описанием опор и промпта плана (скилл `ai-clip-scene`), при проверке полученного изображения и при ревью сценария. Текст детерминированный: состояние даёт `scene_registry`, подписи и вопросы словарь кастинга.

## Контракт

```sh
python3 -B tools/continuity_brief/continuity_brief.py M37
python3 -B tools/continuity_brief/continuity_brief.py M37 --phase after
python3 -B tools/continuity_brief/continuity_brief.py M37 --paragraph
python3 -B tools/continuity_brief/continuity_brief.py M37 --json
```

- По умолчанию состояние на первый кадр (`before`); `--phase after` на последний. Вывод: заголовок с действием плана, строки «Сущность: подпись свойства: значение; …» (мир первым, затем порядок кастинга) и раздел «Проверить по кадру» с вопросами из шаблонов `checklist` словаря.
- `--paragraph` печатает один абзац для дословной вставки в промпт изображения или видео. `--json` отдаёт состояние, абзац, чек-лист и полный текст.
- Без кастинга подписи заменяются ключами свойств, чек-лист пуст.

## Тесты

```sh
python3 -B tools/continuity_brief/test_continuity_brief.py
```
