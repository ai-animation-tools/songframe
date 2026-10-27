"""Повтор генерации плана по сохранённому запросу без нового согласования; @link README.md

Берёт замороженный запрос плана (последний пакет в plan/batches или plan/awaiting с подготовленной попыткой,
иначе снимок принятого комплекта assets/shots/Mxx/generation-request.json в формате замороженного запроса),
создаёт новый пакет с попыткой `retry_of`, печатает request_sha256 и оценку стоимости. С `--submit`
отправляет, ждёт результат и делает техническую сводку. Если данных запроса нет или они в чужом формате,
останавливается с кодом 3: ничего не выдумывается.
"""

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.common import ROOT, read_json
from tools.cost_check import cost_check
from tools.kling_request import kling_request
from tools.scene_registry.scene_registry import generation_settings, load_project
from tools.shot_workflow import shot_workflow

NO_DATA = 3
PACKAGE_ROOTS = ("plan/batches", "plan/awaiting")


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


def spec_from_frozen(request_path, shot):
    """Спецификация prepare из замороженного request.json попытки: пути входов и промпта абсолютные."""
    data = read_json(request_path)
    if not isinstance(data, dict) or data.get("schema_version") != 1 or "command" not in data or "model" not in data:
        raise LookupError(f"{request_path}: это не замороженный запрос попытки.")
    base = request_path.parent
    inputs = []
    for item in data.get("inputs", []):
        if "flag" not in item or "path" not in item:
            raise LookupError(f"{request_path}: у входа нет flag или path, повтор невозможен.")
        entry = {k: item[k] for k in ("flag", "slot", "role", "sha256") if k in item}
        entry["path"] = str((base / item["path"]).resolve())
        inputs.append(entry)
    prompt = data.get("prompt")
    prompt_path = base / (prompt["path"] if isinstance(prompt, dict) else str(prompt or "prompt.txt"))
    if not prompt_path.is_file():
        raise LookupError(f"{request_path}: нет файла промпта {prompt_path.name}.")
    return {
        "schema_version": 1,
        "shot": shot,
        "kind": data.get("kind", "video"),
        "command": data["command"],
        "model": data["model"],
        "parameters": data.get("parameters", {}),
        "inputs": inputs,
        "prompt_file": str(prompt_path.resolve()),
        "outputs": data.get("outputs", 1),
    }


def spec_from_asset(root, shot):
    """Спецификация из снимка принятого комплекта в формате замороженного запроса (accept_shot комплекса)."""
    asset = Path(root) / "assets/shots" / shot
    snapshot_path = asset / "generation-request.json"
    data = read_json(snapshot_path)
    if not isinstance(data, dict):
        raise LookupError(f"У плана {shot} нет снимка запроса в принятом комплекте.")
    provider = str(data.get("provider", "")).lower()
    if provider and provider != "kling":
        raise LookupError(f"{shot}: генерация делалась в {data.get('provider')}, повтор через Kling невозможен.")
    inputs = data.get("inputs")
    if (
        not provider
        or not isinstance(inputs, list)
        or "command" not in data
        or "model" not in data
        or not isinstance(data.get("prompt"), str)
    ):
        raise LookupError(
            f"{shot}: снимок запроса в старом формате (без провайдера или списка входов), "
            "повтор невозможен; подготовьте план заново по этапам."
        )
    spec_inputs = []
    for item in inputs:
        if "slot" not in item or "path" not in item:
            raise LookupError(f"{shot}: у входа снимка нет slot или path.")
        spec_inputs.append(
            {
                "flag": "input",
                "slot": item["slot"],
                "role": item.get("role", ""),
                "path": str((asset / item["path"]).resolve()),
                **({"sha256": item["sha256"]} if item.get("sha256") else {}),
            }
        )
    prompt_path = asset / data["prompt"]
    if not prompt_path.is_file():
        raise LookupError(f"{shot}: нет файла промпта {data['prompt']} в комплекте.")
    return {
        "schema_version": 1,
        "shot": shot,
        "kind": "video",
        "command": data["command"],
        "model": data["model"],
        "parameters": data.get("parameters", {}),
        "inputs": spec_inputs,
        "prompt_file": str(prompt_path.resolve()),
        "outputs": data.get("outputs", 1),
    }


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
    if settings["provider"].lower() != "kling":
        problems.append(f"провайдер проекта {settings['provider']}, инструмент повторяет только запросы Kling")
    if "resolution" in parameters and str(parameters["resolution"]) != settings["resolution"]:
        problems.append(
            f"разрешение запроса {parameters['resolution']} отличается от настроек проекта {settings['resolution']}"
        )
    if "aspect_ratio" in parameters and str(parameters["aspect_ratio"]) != settings["aspect_ratio"]:
        problems.append(f"пропорции запроса {parameters['aspect_ratio']} отличаются от {settings['aspect_ratio']}")
    return problems


def regenerate(root, shot, source="auto", work_dir=None, cli="kling", use_account=True, pricing_path=None):
    """Создаёт новый пакет и подготовленную попытку по сохранённому запросу; возвращает сведения для таблицы."""
    settings = generation_settings(load_project(root))
    package = None
    spec = None
    errors = []
    if source in ("auto", "package"):
        package, request = find_package_request(root, shot)
        if request is not None:
            try:
                spec = spec_from_frozen(request, shot)
            except LookupError as error:
                errors.append(str(error))
                spec = None
        elif source == "package":
            raise LookupError(f"У плана {shot} нет пакета с подготовленной попыткой.")
    if spec is None and source in ("auto", "asset"):
        try:
            spec = spec_from_asset(root, shot)
        except LookupError as error:
            errors.append(str(error))
    if spec is None:
        raise LookupError(" ".join(errors) or f"У плана {shot} нет сохранённого запроса.")
    mismatches = check_settings(spec, settings)
    if mismatches:
        raise LookupError(f"{shot}: " + "; ".join(mismatches) + ". Повтор остановлен.")
    for item in spec["inputs"]:
        if not Path(item["path"]).is_file():
            raise LookupError(f"{shot}: вход запроса отсутствует: {item['path']}.")
    directory = Path(work_dir) if work_dir else next_attempt_dir(root, shot)
    workflow = shot_workflow.init(shot, directory, root=root, retry_of=str(package) if package else None)
    with tempfile.TemporaryDirectory(prefix="regenerate-") as temporary:
        spec_path = Path(temporary) / "request.json"
        spec_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
        prepared = kling_request.prepare(spec_path, Path(directory) / "request")
    # Опоры и промпт унаследованы от исходного запроса: этапы проходятся без согласований, по одному шагу.
    for stage in ("keyframes_review", "prompt_review"):
        shot_workflow.set_stage(directory, stage, root=root)
    shot_workflow.set_stage(directory, "request_choice", request_dir="request", root=root)
    pricing = cost_check.load_pricing(pricing_path or cost_check.PRICING)
    report = cost_check.check(
        read_json(Path(directory) / "request/request.json"), pricing, cli=cli, use_account=use_account
    )
    return {
        "shot": shot,
        "package": str(directory),
        "work_dir": str(Path(directory) / "request"),
        "retry_of": workflow.get("retry_of"),
        "request_sha256": prepared["request_sha256"],
        "model": prepared["model"],
        "parameters": prepared["parameters"],
        "inputs": prepared["inputs"],
        "prompt_chars": len(prepared["prompt_text"]),
        "warnings": prepared["warnings"],
        "cost": report,
        "source": "package" if package else "asset",
    }


def submit_and_watch(root, info, cli="kling", max_minutes=20, interval=20, report=print, pricing_path=None):
    """Отправка ровно один раз, запись расхода, ожидание и техническая сводка. Разрешение на расход даёт вызывающий."""
    work_dir = Path(info["work_dir"])
    if info["cost"]["verdict"] != "ok":
        raise LookupError(f"Отправка остановлена: {info['cost']['verdict_label']} ({info['cost']['verdict']}).")
    kling_request.submit(work_dir, info["request_sha256"], cli=cli)
    try:
        cost_check.learn(work_dir, pricing_path or cost_check.PRICING)
    except ValueError:
        pass
    shot_workflow.set_stage(info["package"], "submitted", root=root)
    results = kling_request.watch([work_dir], cli=cli, max_minutes=max_minutes, interval=interval, report=report)
    state = results.get(str(work_dir), {})
    if state.get("status") == "downloaded":
        shot_workflow.set_stage(info["package"], "downloaded", root=root)
    return state


def main():
    parser = argparse.ArgumentParser(description="Повтор генерации плана по сохранённому запросу.")
    parser.add_argument("shot")
    parser.add_argument("--source", choices=["auto", "package", "asset"], default="auto")
    parser.add_argument("--work-dir", help="Папка нового пакета; по умолчанию plan/batches/Mxx-attempt-NN")
    parser.add_argument(
        "--submit",
        action="store_true",
        help="Сразу отправить, дождаться и сохранить результат (разрешение на расход даёт вызов)",
    )
    parser.add_argument("--max-minutes", type=float, default=20)
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
    if args.submit:
        try:
            state = submit_and_watch(
                ROOT,
                info,
                cli=args.cli,
                max_minutes=args.max_minutes,
                report=(lambda *_: None) if args.json else print,
                pricing_path=args.pricing,
            )
        except (LookupError, ValueError) as error:
            if args.json:
                print(json.dumps({**info, "submitted": False, "error": str(error)}, ensure_ascii=False))
            parser.exit(1, f"{error}\n")
        info = {**info, "submitted": True, "attempt": state}
        if not args.json:
            print(
                f"Состояние попытки: {state.get('status')}"
                + (
                    f"; результат: {', '.join(d.get('path', '') for d in state.get('downloads', []))}"
                    if state.get("downloads")
                    else ""
                )
            )
    if args.json:
        print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
