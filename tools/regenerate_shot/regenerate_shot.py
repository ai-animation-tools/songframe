"""Повтор генерации плана по сохранённому запросу без нового согласования; @link README.md

Берёт замороженный запрос плана (последний пакет в plan/batches или plan/awaiting с подготовленной попыткой,
иначе снимок принятого комплекта assets/shots/Mxx/generation-request.json),
создаёт новый пакет с попыткой `retry_of` и вопросом отправки для приложения, печатает request_sha256
и оценку стоимости. Отправку выполняет приложение после ответа send. Если данных запроса нет или они
в чужом формате, останавливается с кодом 3: ничего не выдумывается.
"""

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools import request_snapshot
from tools.asset_package.asset_package import descriptor_file
from tools.common import ROOT, read_json, sha
from tools.cost_check import cost_check
from tools.kling_request import kling_request
from tools.scene_registry.scene_registry import generation_settings, load_project
from tools.shot_workflow import shot_workflow

NO_DATA = 3
PACKAGE_ROOTS = ("plan/batches", "plan/awaiting")
# Подготовка общая; проверку ограничений и стоимости обслуживают только уже подключённые адаптеры.
ADAPTERS = {"kling": kling_request}


def find_package_request(root, shot):
    """Последняя по времени подготовленная попытка плана среди рабочих пакетов и очереди."""
    candidates = []
    for base in PACKAGE_ROOTS:
        folder = Path(root) / base
        if not folder.is_dir():
            continue
        for workflow_path in folder.glob("*/workflow.json"):
            data = read_json(workflow_path)
            if not isinstance(data, dict) or data.get("shot") != shot or not data.get("request_dir"):
                continue
            request = workflow_path.parent / data["request_dir"] / "request.json"
            if request.is_file():
                candidates.append((request.stat().st_mtime, workflow_path.parent, request))
    if not candidates:
        return None, None
    candidates.sort()
    _, package, request = candidates[-1]
    return package, request


def checked_prompt(path, expected, label):
    """Сверяет обязательный SHA-256 с точными байтами сохранённого промпта."""
    if not isinstance(expected, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", expected):
        raise LookupError(f"{label}: у промпта нет корректного SHA-256.")
    if not path.is_file():
        raise LookupError(f"{label}: нет файла промпта {path.name}.")
    if sha(path) != expected.lower():
        raise LookupError(f"{label}: хеш промпта отличается от сохранённого.")
    return str(path.resolve())


def saved_spec(data, shot, kind, inputs, prompt_file):
    """Переносит явно сохранённые поля в спецификацию prepare; cli_argv не исполняется."""
    spec = {key: data[key] for key in ("provider", "command", "model", "parameters", "outputs")}
    spec.update(schema_version=1, shot=shot, kind=kind, inputs=inputs, prompt_file=prompt_file)
    if "model_selection" in data:
        spec["model_selection"] = data["model_selection"]
    return spec


def spec_from_frozen(request_path, shot):
    """Читает request.json попытки в общем замороженном формате."""
    request_path = Path(request_path)
    data = read_json(request_path)
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise LookupError(f"{request_path}: это не замороженный запрос попытки.")
    try:
        prompt = data["prompt"]
        if not isinstance(prompt, dict) or not isinstance(prompt.get("path"), str) or not prompt["path"].strip():
            raise ValueError("Промпт должен содержать path и sha256.")
        if not isinstance(data["inputs"], list):
            raise ValueError("inputs должен быть списком.")
        inputs = []
        for item in data["inputs"]:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not item["path"].strip():
                raise ValueError("У входа нет непустого path.")
            entry = {key: item[key] for key in ("slot", "role", "sha256") if key in item}
            inputs.append(entry | {"flag": item["flag"], "path": str((request_path.parent / item["path"]).resolve())})
        prompt_file = checked_prompt(request_path.parent / prompt["path"], prompt["sha256"], str(request_path))
        return saved_spec(data, shot, data["kind"], inputs, prompt_file)
    except (KeyError, OSError, ValueError, TypeError) as error:
        raise LookupError(f"{request_path}: повреждён замороженный запрос: {error}") from None


def spec_from_asset(root, shot):
    """Читает снимок принятого комплекта по контракту accept_shot; @link README.md."""
    asset = Path(root) / "assets/shots" / shot
    data = read_json(asset / "generation-request.json")
    if not isinstance(data, dict):
        raise LookupError(f"У плана {shot} нет снимка запроса в принятом комплекте.")
    provider = data.get("provider")
    if not isinstance(provider, str) or not provider.strip():
        raise LookupError(f"{shot}: провайдер снимка {provider!r}; нужна непустая строка provider.")
    if data.get("schema_version") != 1 or data.get("path_base") != "asset_directory":
        raise LookupError(f"{shot}: нужны schema_version=1 и path_base=asset_directory.")
    if data.get("elements") or data.get("audio_inputs"):
        raise LookupError(f"{shot}: дополнительные elements/audio_inputs не описаны в inputs; повтор невозможен.")
    try:
        prompt = data["prompt"]
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("Промпт должен быть непустым именем файла.")
        if not isinstance(data["inputs"], list):
            raise ValueError("inputs должен быть списком.")
        inputs = []
        for item in data["inputs"]:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not item["path"].strip():
                raise ValueError("У входа нет непустого path.")
            # Именованный слот комплекта — вход input. Другие флаги должны быть сохранены явно.
            entry = {key: item[key] for key in ("slot", "role", "sha256") if key in item}
            inputs.append(
                entry | {"flag": item.get("flag", "input"), "path": str(descriptor_file(asset, item, root=root))}
            )
        prompt_path = descriptor_file(asset, {"path": prompt}, root=root)
        prompt_file = checked_prompt(prompt_path, data["prompt_sha256"], shot)
        return saved_spec(data, shot, data.get("kind", "video"), inputs, prompt_file)
    except (KeyError, OSError, ValueError, TypeError) as error:
        raise LookupError(f"{shot}: повреждён снимок запроса: {error}") from None


def validate_saved_spec(spec, shot):
    """Проверяет совместимость и сохранённые байты до создания нового пакета."""
    try:
        request_snapshot.validate_spec(spec)
        adapter = ADAPTERS.get(spec["provider"].strip().casefold())
        if adapter:
            adapter.validate_spec(spec)
        if adapter and not spec["command"].startswith("text_to_") and not spec["inputs"]:
            raise ValueError("Для этой команды нет сохранённых входов.")
        prompt = Path(spec["prompt_file"]).read_bytes().decode("utf-8")
        if not prompt.strip() or (adapter and re.match(r"^--[A-Za-z]", prompt)):
            raise ValueError("Промпт пуст или начинается с флага CLI.")
        for item in spec["inputs"]:
            path = Path(item["path"])
            if not path.is_file():
                raise ValueError(f"Вход запроса отсутствует: {path}.")
            if "sha256" in item and sha(path) != item["sha256"]:
                raise ValueError(f"Хеш входа {path.name} отличается от сохранённого.")
    except (OSError, ValueError, TypeError) as error:
        raise LookupError(f"{shot}: сохранённый запрос нельзя повторить: {error}") from None


def next_attempt_dir(root, shot):
    batches = Path(root) / "plan/batches"
    numbers = [
        int(m.group(1))
        for p in batches.glob(f"{shot}-attempt-*")
        if (m := re.fullmatch(rf"{re.escape(shot)}-attempt-(\d+)", p.name))
    ]
    return batches / f"{shot}-attempt-{(max(numbers) + 1 if numbers else 1):02d}"


def check_settings(spec, settings):
    """Снимок должен соответствовать настройкам генерации проекта: иначе повтор молча сменит формат."""
    parameters = spec.get("parameters", {})
    problems = []
    if spec["provider"].strip().casefold() != settings["provider"].strip().casefold():
        problems.append(f"провайдер запроса {spec['provider']} отличается от провайдера проекта {settings['provider']}")
    if (
        "resolution" in parameters
        and "resolution" in settings
        and str(parameters["resolution"]) != settings["resolution"]
    ):
        problems.append(
            f"разрешение запроса {parameters['resolution']} отличается от настроек проекта {settings['resolution']}"
        )
    if (
        "aspect_ratio" in parameters
        and "aspect_ratio" in settings
        and str(parameters["aspect_ratio"]) != settings["aspect_ratio"]
    ):
        problems.append(f"пропорции запроса {parameters['aspect_ratio']} отличаются от {settings['aspect_ratio']}")
    return problems


def regenerate(root, shot, source="auto", work_dir=None, cli="kling", use_account=True, pricing_path=None):
    """Создаёт новый пакет и подготовленную попытку по сохранённому запросу; возвращает сведения для таблицы."""
    package = None
    spec = None
    errors = []
    if source in ("auto", "package"):
        package, request = find_package_request(root, shot)
        if request is not None:
            # Последний запрос задаёт источник повтора: его повреждение нельзя скрывать снимком assets.
            spec = spec_from_frozen(request, shot)
        elif source == "package":
            raise LookupError(f"У плана {shot} нет пакета с подготовленной попыткой.")
    if spec is None and source in ("auto", "asset"):
        try:
            spec = spec_from_asset(root, shot)
            package = None
        except LookupError as error:
            errors.append(str(error))
    if spec is None:
        raise LookupError(" ".join(errors) or f"У плана {shot} нет сохранённого запроса.")
    validate_saved_spec(spec, shot)
    settings = generation_settings(load_project(root), spec["kind"])
    mismatches = check_settings(spec, settings)
    if mismatches:
        raise LookupError(f"{shot}: " + "; ".join(mismatches) + ". Повтор остановлен.")
    directory = Path(work_dir) if work_dir else next_attempt_dir(root, shot)
    workflow = shot_workflow.init(shot, directory, root=root, retry_of=str(package) if package else None)
    with tempfile.TemporaryDirectory(prefix="regenerate-") as temporary:
        spec_path = Path(temporary) / "request.json"
        spec_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
        adapter = ADAPTERS.get(spec["provider"].strip().casefold())
        prepare = adapter.prepare if adapter else request_snapshot.prepare
        prepared = prepare(spec_path, Path(directory) / "request")
    # Опоры и промпт унаследованы от исходного запроса: этапы проходятся без согласований, по одному шагу.
    for stage in ("keyframes_review", "prompt_review"):
        shot_workflow.set_stage(directory, stage, root=root)
    shot_workflow.set_stage(directory, "request_choice", request_dir="request", root=root)
    # Вопрос продолжают кнопки приложения; сам вопрос согласия на отправку не означает.
    shot_workflow.ask(directory, "request_choice", root=root)
    frozen = read_json(Path(directory) / "request/request.json")
    if adapter:
        pricing = cost_check.load_pricing(pricing_path or cost_check.PRICING)
        report = cost_check.check(frozen, pricing, cli=cli, use_account=use_account)
    else:
        report = {key: frozen[key] for key in ("model", "kind", "command", "parameters", "outputs")}
        report.update(
            estimate_credits=None,
            estimate_source=None,
            balance_credits=None,
            balance_source="для провайдера не подключена проверка стоимости и баланса",
            verdict="cost_or_balance_unknown",
            verdict_label=cost_check.VERDICTS["cost_or_balance_unknown"],
            reasons=[f"Для провайдера {spec['provider']} не подключена проверка стоимости и баланса."],
        )
    return {
        "shot": shot,
        "package": str(directory),
        "work_dir": str(Path(directory) / "request"),
        "retry_of": workflow.get("retry_of"),
        "request_sha256": prepared["request_sha256"],
        "provider": prepared["provider"],
        "model": prepared["model"],
        "parameters": prepared["parameters"],
        "inputs": prepared["inputs"],
        "prompt_chars": len(prepared["prompt_text"]),
        "warnings": prepared["warnings"],
        "cost": report,
        "source": "package" if package else "asset",
    }


def main():
    parser = argparse.ArgumentParser(description="Повтор генерации плана по сохранённому запросу.")
    parser.add_argument("shot")
    parser.add_argument("--source", choices=["auto", "package", "asset"], default="auto")
    parser.add_argument("--work-dir", help="Папка нового пакета; по умолчанию plan/batches/Mxx-attempt-NN")
    parser.add_argument("--cli", default="kling")
    parser.add_argument("--no-account", action="store_true", help="Не запрашивать остаток у аккаунта")
    parser.add_argument(
        "--pricing", type=Path, help="Файл тарифов вместо tools/cost_check/pricing.json (прогоны без расхода)"
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        info = regenerate(
            ROOT,
            args.shot,
            args.source,
            args.work_dir,
            cli=args.cli,
            use_account=not args.no_account,
            pricing_path=args.pricing,
        )
    except LookupError as error:
        parser.exit(NO_DATA, f"{error}\n")
    except ValueError as error:
        parser.exit(1, f"{error}\n")
    if not args.json:
        print(
            f"Пакет {info['package']} (повтор {info['retry_of'] or 'принятого комплекта'}), "
            f"запрос {info['request_sha256']}"
        )
        print(
            f"Модель {info['model']}, параметры {json.dumps(info['parameters'], ensure_ascii=False)}, "
            f"входов {len(info['inputs'])}, промпт {info['prompt_chars']} символов"
        )
        print(cost_check.table(info["cost"]))
        for warning in info["warnings"]:
            print("Предупреждение: " + warning)
    if args.json:
        print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
