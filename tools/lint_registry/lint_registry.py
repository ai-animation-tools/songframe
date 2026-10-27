"""Проверка реестра, комплектов и пакетов по схемам и правилам владения сведениями; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import json
import re

from tools.common import ROOT

SCHEMAS = Path(__file__).with_name("schemas")

# Хроника принятий и технические рецепты принадлежат assets и сообщениям коммитов, не постановке.
PRODUCTION_WORDS = r"(проб|участ|клип|генерац|склейк|переход|видео|кадр|монтаж|обрезк|включ|версия|v\d)"
HISTORY_PATTERNS = [
    (
        r"(?:"
        + PRODUCTION_WORDS
        + r"[^.;]{0,60}\bприняты?\b)|(?:\bприняты?\b[^.;]{0,60}"
        + PRODUCTION_WORDS
        + r")|\bпринята (новая|генерация|обрезка)",
        "факт принятия",
    ),
    (r"\bвключен[аоы]? в v\d+", "ссылка на версию аниматика"),
    (r"(?<![\w_-])v\d{2}\b", "номер версии"),
    (r"\bв пробе\b|\bпроба [A-ZМ]\d", "упоминание пробы"),
    (r"assets/shots/", "путь в assets"),
    (r"manifest\.json", "ссылка на технический файл"),
    (r"\bархив", "упоминание архива"),
    (r"\bпрежн(яя|ий|ие|его|ей) верси", "прежняя версия"),
    (
        (
            r"\bоригинал[а-я]* \d|\bучаст(ок|ка) \d|\d[,.]\d+\s*×|\bна "
            r"1×|\bускорен[а-я]* на|\bзамедлен[а-я]* до|\d+/\d+\s*≈|\b\d+ "
            r"кадр(а|ов)? (на|при) \d"
        ),
        "технический рецепт монтажа",
    ),
    (r"\b(оригинал|клип|видео|версия|кандидат)[^.;]{0,40}\bсохран(ён|ены|ена|ено)\b", "факт сохранения"),
]
DERIVED_LINKS = r"edit-list\.md|production-status\.json|storyboard\.md|ROADMAP\.md"
SNAPSHOT_FORBIDDEN = {
    "prepared_at",
    "account_checked_at",
    "cost",
    "available_credits",
    "video_submitted",
    "result_saved",
    "status",
    "notes",
    "revision",
    "revision_reason",
    "stage",
    "attempt",
    "cli_version",
    "approved_at",
    "approval",
    "created_at",
    "updated_at",
    "saved_at",
    "submitted_at",
    "submission_started_at",
    "downloaded_at",
    "last_query_at",
    "capabilities_checked_at",
    "balance",
    "pricing",
    "credits_consumed",
    "creditsConsumed",
    "download_status",
    "service_statuses",
    "submitted",
    "uploaded",
}
# Прежние снимки используют другие имена тех же сведений; они допустимы, но отмечаются как устаревшая форма.
SNAPSHOT_ALIASES = {
    "generation_id": ("generationId",),
    "parameters": ("arguments",),
    "prompt": ("prompt_file", "prompt_path"),
    "provider": ("service",),
}
MULTI_SHOT_MODELS = {"kling-video-v3_0", "kling-video-v3_0_omni"}


def load_schema(name):
    return json.loads((SCHEMAS / f"{name}.schema.json").read_text(encoding="utf-8"))


def resolve_ref(schema, root):
    if "$ref" in schema:
        node = root
        for part in schema["$ref"].lstrip("#/").split("/"):
            node = node[part]
        return node
    return schema


def type_ok(value, expected):
    checks = {
        "object": lambda v: isinstance(v, dict),
        "array": lambda v: isinstance(v, list),
        "string": lambda v: isinstance(v, str),
        "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
        "boolean": lambda v: isinstance(v, bool),
        "null": lambda v: v is None,
    }
    return any(checks[t](value) for t in ([expected] if isinstance(expected, str) else expected))


def validate(value, schema, root=None, path="$"):
    """Подмножество JSON Schema: type, const, enum, required, properties, additionalProperties,
    items, pattern, minimum, minItems, minLength, anyOf, $ref.
    """
    root = root or schema
    schema = resolve_ref(schema, root)
    errors = []
    if "anyOf" in schema:
        branches = [validate(value, option, root, path) for option in schema["anyOf"]]
        if all(branches):
            errors.append(f"{path}: не подходит ни один из допустимых вариантов")
        return errors
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: ожидается {schema['const']!r}, найдено {value!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: значение {value!r} вне допустимых {schema['enum']}")
    if "type" in schema and not type_ok(value, schema["type"]):
        errors.append(f"{path}: ожидается тип {schema['type']}, найдено {type(value).__name__}")
        return errors
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{path}: значение {value!r} не соответствует шаблону")
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: пустое значение")
    if (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and "minimum" in schema
        and value < schema["minimum"]
    ):
        errors.append(f"{path}: {value} меньше {schema['minimum']}")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: нет обязательного поля {key}")
        properties = schema.get("properties", {})
        for key, item in value.items():
            if key in properties:
                errors += validate(item, properties[key], root, f"{path}.{key}")
            elif isinstance(schema.get("additionalProperties"), dict):
                errors += validate(item, schema["additionalProperties"], root, f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: неизвестное поле {key}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: нужно не менее {schema['minItems']} элементов")
        if "items" in schema:
            for index, item in enumerate(value):
                errors += validate(item, schema["items"], root, f"{path}[{index}]")
    return errors


class Report:
    def __init__(self):
        self.errors, self.warnings = [], []

    def error(self, file, where, message):
        self.errors.append({"level": "error", "file": file, "where": where, "message": message})

    def warning(self, file, where, message):
        self.warnings.append({"level": "warning", "file": file, "where": where, "message": message})


def read_json(root, name, report):
    try:
        return json.loads((root / name).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except ValueError as error:
        report.error(name, "$", f"JSON не разбирается: {error}")
        return None


def history_hits(text):
    hits = []
    for pattern, label in HISTORY_PATTERNS:
        match = re.search(pattern, text, re.I)
        if match:
            start = max(0, match.start() - 30)
            hits.append(f"{label}: «…{text[start : match.end() + 30].strip()}…»")
    return hits


def lint_scenes(root, report):
    data = read_json(root, "plan/scenes.json", report)
    if data is None:
        report.error("plan/scenes.json", "$", "файл отсутствует")
        return None
    for message in validate(data, load_schema("scenes")):
        report.error("plan/scenes.json", message.split(":")[0], message.split(": ", 1)[1])
    if not isinstance(data, dict):
        return data
    # Ссылки на изображения внутри assets означают, что действующий референс живёт не в source.
    for match in re.finditer(r"\]\(([^)]+)\)", data.get("visual_direction", "")):
        if "assets/" in match.group(1) and re.search(r"\.(png|jpe?g|webp)$", match.group(1), re.I):
            report.error(
                "plan/scenes.json", "visual_direction", f"референс-изображение в assets вместо source: {match.group(1)}"
            )
        elif "assets/" in match.group(1):
            report.warning(
                "plan/scenes.json",
                "visual_direction",
                f"ссылка на принятый материал как ориентир непрерывности: {match.group(1)}",
            )
    for hit in history_hits(data.get("visual_direction", "")):
        report.warning("plan/scenes.json", "visual_direction", hit)
    for sequence in data.get("sequences", []):
        where = f"sequences[{sequence.get('id')}].direction"
        for hit in history_hits(sequence.get("direction", "")):
            report.error("plan/scenes.json", where, hit)
        for match in re.finditer(r"\]\(([^)]+)\)", sequence.get("direction", "")):
            if "assets/" in match.group(1):
                report.error("plan/scenes.json", where, f"ссылка в assets: {match.group(1)}")
            elif re.search(DERIVED_LINKS, match.group(1)):
                report.warning(
                    "plan/scenes.json",
                    where,
                    f"ссылка на производное представление вместо первичного источника: {match.group(1)}",
                )
    reference_keys = set(data.get("references", {}))
    for scene in data.get("scenes", []):
        sid = scene.get("id", "?")
        for field in ("action", "continuity", "notes"):
            for hit in history_hits(scene.get(field, "") or ""):
                report.error("plan/scenes.json", f"{sid}.{field}", hit)
        for key in scene.get("references", []):
            if key != "—" and key not in reference_keys:
                report.error("plan/scenes.json", f"{sid}.references", f"неизвестный референс {key}")
        if scene.get("card", {}).get("primary_reference") not in reference_keys:
            report.error("plan/scenes.json", f"{sid}.card", "главный референс карточки не объявлен")
    return data


def lint_cast(root, scenes, report):
    """plan/cast.json необязателен, но если есть, он должен быть валиден и согласован с references реестра."""
    if not (root / "plan/cast.json").is_file():
        return None
    data = read_json(root, "plan/cast.json", report)
    if data is None:
        return None
    for message in validate(data, load_schema("cast")):
        report.error("plan/cast.json", message.split(":")[0], message.split(": ", 1)[1])
    from tools.cast_registry.cast_registry import references, validate_cast

    for problem in validate_cast(data):
        report.error("plan/cast.json", "$", problem)
    if not isinstance(data, dict) or not isinstance(data.get("entities"), list):
        return data
    for entity in data["entities"]:
        if not isinstance(entity, dict):
            continue
        for image in entity.get("images", []) or []:
            if isinstance(image, str) and not (root / "source" / image).is_file():
                report.error("plan/cast.json", f"{entity.get('id')}.images", f"нет файла source/{image}")
    if not any(isinstance(e, dict) and e.get("kind") == "world" for e in data["entities"]):
        report.warning(
            "plan/cast.json", "entities", "нет сущности world: время суток, погода и стороны дороги негде хранить"
        )
    try:
        derived = references(data)
    except (KeyError, TypeError):
        return data
    if isinstance(scenes, dict) and scenes.get("references") != derived:
        report.error(
            "plan/scenes.json",
            "references",
            "карта references расходится с кастингом: python3 -B tools/cast_registry/cast_registry.py sync",
        )
    return data


def lint_description(root, data, report):
    path = root / "source/description.md"
    if not path.is_file() or not isinstance(data, dict):
        return
    text = path.read_text(encoding="utf-8")
    for key, reference in data.get("references", {}).items():
        name = reference.get("name", "")
        if reference.get("path", "").startswith("source/heroes/") and name and name.split()[0] not in text:
            report.warning("source/description.md", key, f"персонаж «{name}» из реестра не упомянут в сценарии")


def lint_snapshot(root, name, report, model_warning=True):
    snapshot = read_json(root, name, report)
    if snapshot is None:
        return
    for key in sorted(set(snapshot) & SNAPSHOT_FORBIDDEN):
        report.error(name, key, "служебное поле времени, состояния или баланса не хранится в assets")
    present = {}
    for canonical, aliases in SNAPSHOT_ALIASES.items():
        found = [k for k in (canonical, *aliases) if k in snapshot]
        if found:
            present[canonical] = found[0]
            if found[0] != canonical:
                report.warning(name, found[0], f"устаревшее имя поля; каноническое — {canonical}")
    if "model" not in snapshot or "prompt" not in present:
        report.error(name, "$", "снимок должен называть модель и промпт")
    kling = "command" in snapshot and ("parameters" in present or "argv" in snapshot)
    external = "provider" in present
    if not kling and not external:
        report.error(name, "$", "нет ни команды Kling с параметрами, ни поля provider внешнего сервиса")
    if "generation_id" not in present:
        report.error(name, "generation_id", "поле обязательно; при неизвестном ID — null и причина в provenance")
    elif snapshot[present["generation_id"]] is None and not snapshot.get("provenance"):
        report.error(name, "provenance", "ID задания отсутствует, но причина не записана")
    parameters = snapshot.get(present.get("parameters", "parameters"), {})
    if (
        kling
        and model_warning
        and snapshot.get("model") in MULTI_SHOT_MODELS
        and isinstance(parameters, dict)
        and "prefer_multi_shots" not in parameters
        and "prefer_multi_shots" not in snapshot
    ):
        report.warning(
            name,
            "parameters",
            (
                "запрос к модели с авто-раскадровкой отправлен без "
                "prefer_multi_shots: у сервиса значение по умолчанию true"
            ),
        )


def lint_assets(root, report):
    schema = load_schema("manifest")
    for manifest in sorted((root / "assets/shots").glob("M*/manifest.json")):
        name = str(manifest.relative_to(root))
        package = read_json(root, name, report)
        if package is None:
            continue
        for message in validate(package, schema):
            report.error(name, message.split(":")[0], message.split(": ", 1)[1])
        request = package.get("generation", {}).get("request") if isinstance(package, dict) else None
        if isinstance(request, dict) and request.get("path"):
            lint_snapshot(root, str((manifest.parent / request["path"]).relative_to(root)), report)


def lint_packages(root, report):
    workflow_schema, request_schema = load_schema("workflow"), load_schema("request")
    folders = [p for base in ("plan/awaiting", "plan/batches") for p in sorted((root / base).glob("*")) if p.is_dir()]
    for folder in folders:
        workflow = folder / "workflow.json"
        if workflow.is_file():
            data = read_json(root, str(workflow.relative_to(root)), report)
            if data is not None:
                for message in validate(data, workflow_schema):
                    report.error(str(workflow.relative_to(root)), message.split(":")[0], message.split(": ", 1)[1])
                if (
                    folder.parent.name == "awaiting"
                    and isinstance(data, dict)
                    and data.get("stage")
                    not in (
                        "ready",
                        "needs_revision",
                        "edit_review",
                        "submitted",
                        "downloaded",
                        "image_request_choice",
                        "image_submitted",
                        "image_downloaded",
                    )
                ):
                    report.error(
                        str(workflow.relative_to(root)),
                        "stage",
                        (
                            "пакет в очереди должен быть на этапе ready, needs_revision, "
                            "edit_review, submitted, downloaded или "
                            "image_request_choice/image_submitted/image_downloaded"
                        ),
                    )
        for request in list(folder.glob("request.json")) + list(folder.glob("*/request.json")):
            data = read_json(root, str(request.relative_to(root)), report)
            if data is not None:
                for message in validate(data, request_schema):
                    report.error(str(request.relative_to(root)), message.split(":")[0], message.split(": ", 1)[1])
                if (
                    isinstance(data, dict)
                    and data.get("kind") == "video"
                    and data.get("model") in MULTI_SHOT_MODELS
                    and "prefer_multi_shots" not in data.get("parameters", {})
                ):
                    report.error(
                        str(request.relative_to(root)), "parameters", "prefer_multi_shots обязателен для этой модели"
                    )


def lint(root=ROOT):
    root = Path(root).resolve()
    report = Report()
    data = lint_scenes(root, report)
    lint_cast(root, data, report)
    lint_description(root, data, report)
    lint_assets(root, report)
    lint_packages(root, report)
    return report


def render(report):
    lines = []
    for item in report.errors + report.warnings:
        lines.append(
            (
                f"{'ОШИБКА' if item['level'] == 'error' else 'предупреждение'}  "
                f"{item['file']} · {item['where']}: {item['message']}"
            )
        )
    lines.append(f"Ошибок: {len(report.errors)}, предупреждений: {len(report.warnings)}.")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--strict", action="store_true", help="Предупреждения тоже считать ошибками")
    args = parser.parse_args()
    report = lint(ROOT)
    if args.json:
        print(json.dumps({"errors": report.errors, "warnings": report.warnings}, ensure_ascii=False, indent=2))
    else:
        print(render(report))
    if report.errors or (args.strict and report.warnings):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
