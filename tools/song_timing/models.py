"""Модели устанавливаются явно по компонентам и хранятся вне проекта. @link README.md"""

import json
from pathlib import Path

DEFINITION = json.loads(Path(__file__).with_name("models.json").read_text(encoding="utf-8"))
COMPONENTS = ("alignment", "voc-ft", "kim-vocal-1", "kim-vocal-2")


def files_for(component="alignment"):
    """Загрузка уточнения границ не устанавливает большие модели выделения вокала."""
    if component not in COMPONENTS:
        raise ValueError(f"Неизвестный компонент моделей: {component}")
    return [item for item in DEFINITION["files"] if item["component"] == component]


def separator_model(model_id):
    """Параметры относятся к конкретным весам; имя файла не определяет целевую дорожку."""
    for item in DEFINITION["separator_models"]:
        if item["id"] == model_id:
            return item
    raise ValueError(f"Неизвестная модель выделения вокала: {model_id}")


def missing_files(directory, component="alignment"):
    """Большие хеши проверяет загрузчик; открытие окна читает только метаданные файлов."""
    result = []
    for item in files_for(component):
        path = Path(directory) / item["name"]
        if not path.is_file() or path.stat().st_size != item["bytes"]:
            result.append(item["name"])
    return result


def require_models(directory, component="alignment"):
    missing = missing_files(directory, component)
    if missing:
        label = "уточнения границ" if component == "alignment" else separator_model(component)["label"]
        raise ValueError(
            f"Не установлены модели {label}: "
            + ", ".join(missing)
            + ". Откройте окно «Разметить» и скачайте выбранную модель."
        )
