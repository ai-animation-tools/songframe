"""Оценка стоимости запроса и остатка кредитов перед таблицей; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import json
import re
import subprocess

from tools.kling_cli import resolve as resolve_kling_cli
from tools.kling_cli import run as run_kling_cli
from tools.kling_request.kling_request import validate_spec, work_path

PRICING = Path(__file__).with_name("pricing.json")
VERDICTS = {
    "ok": "средств достаточно",
    "insufficient_balance": "средств не хватает",
    "cost_or_balance_unknown": "стоимость или баланс неизвестны",
}


def load_pricing(path=PRICING):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("schema_version") != 1 or not isinstance(data.get("models"), dict):
        raise ValueError("Неизвестная схема таблицы цен.")
    data.setdefault("observed", [])
    return data


def save_pricing(data, path=PRICING):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_request(work_dir=None, request=None):
    """Замороженный request.json попытки либо спецификация до подготовки."""
    if work_dir is not None:
        directory = work_path(work_dir)
        return json.loads((directory / "request.json").read_text(encoding="utf-8")), directory
    spec = json.loads(Path(request).read_text(encoding="utf-8"))
    validate_spec(spec)
    return spec, None


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def image_signature(request):
    """Тариф изображения связан со всей конфигурацией запроса, а не с ценой за секунду."""

    def parameters_only(value):
        if isinstance(value, dict):
            return {
                key: parameters_only(item)
                for key, item in value.items()
                if str(key).lower() not in ("prompt", "prompt_text", "prompt_file", "negative_prompt")
                and not re.search(r"credential|token|password|authorization|secret|api[_-]?key", str(key), re.I)
            }
        if isinstance(value, list):
            return [parameters_only(item) for item in value]
        return value

    # Содержимое и локальная подпись role не передаются как тарифные аргументы CLI.
    # Число входов и фактические именованные слоты остаются частью тарифа.
    configuration = {
        "command": request.get("command"),
        "parameters": parameters_only(request.get("parameters", {})),
        "outputs": request.get("outputs", 1),
        "inputs": [{key: item[key] for key in ("flag", "slot") if key in item} for item in request.get("inputs", [])],
    }
    return json.dumps(configuration, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def estimate_image(pricing, request):
    """Наблюдение не переносится на другую команду, разрешение, quality, число результатов или референсов."""
    model = request.get("model")
    signature = image_signature(request)
    observed = [
        item
        for item in pricing["observed"]
        if item.get("model") == model
        and item.get("kind") == "image"
        and item.get("image_signature") == signature
        and number(item.get("credits")) is not None
    ]
    if observed:
        return {
            "credits": number(observed[-1]["credits"]),
            "source": "наблюдение за точно таким же запросом изображения",
            "missing": [],
        }
    # Ручной per_image остаётся явным решением владельца таблицы; learn его не создаёт и не расширяет.
    per_image = number((pricing["models"].get(model) or {}).get("per_image"))
    if per_image is not None:
        return {"credits": per_image * int(request.get("outputs", 1)), "source": "таблица цен", "missing": []}
    return {
        "credits": None,
        "source": None,
        "missing": [f"цена изображения {model} не задана и точная конфигурация запроса не наблюдалась"],
    }


def estimate(pricing, request):
    """Оценка в кредитах по таблице цен; при пробеле — по наблюдениям того же тарифа."""
    model, kind = request.get("model"), request.get("kind")
    if kind == "image":
        return estimate_image(pricing, request)
    parameters = request.get("parameters", {})
    outputs = int(request.get("outputs", 1))
    resolution = str(parameters["resolution"]) if "resolution" in parameters else None
    duration = number(parameters.get("duration"))
    entry = pricing["models"].get(model)
    missing = []
    if entry is None:
        return {"credits": None, "source": None, "missing": [f"модель {model} отсутствует в таблице цен"]}
    if kind == "video":
        if resolution is None:
            missing.append("в запросе нет resolution")
        if duration is None:
            missing.append("в запросе нет duration")
        if missing:
            return {"credits": None, "source": None, "missing": missing}
        per_second = number((entry.get("per_second") or {}).get(resolution))
        if per_second is not None:
            credits = (number(entry.get("base_credits")) or 0) + per_second * duration
            return {"credits": credits * outputs, "source": "таблица цен", "missing": []}
        observed = [
            o
            for o in pricing["observed"]
            if o.get("model") == model
            and o.get("kind", "video") == "video"
            and str(o.get("resolution")) == resolution
            and number(o.get("credits")) is not None
        ]
        exact = [o for o in observed if number(o.get("duration")) == duration and int(o.get("outputs", 1)) == 1]
        if exact:
            return {
                "credits": number(exact[-1]["credits"]) * outputs,
                "source": "наблюдение за прежним запросом",
                "missing": [],
            }
        if observed:
            last = observed[-1]
            per_second = number(last["credits"]) / number(last["duration"]) / int(last.get("outputs", 1))
            return {
                "credits": per_second * duration * outputs,
                "source": "наблюдение, пересчёт по секундам",
                "missing": [],
            }
        return {
            "credits": None,
            "source": None,
            "missing": [f"цена {model} при {resolution} не задана и не наблюдалась"],
        }
    return {"credits": None, "source": None, "missing": ["неизвестный вид результата"]}


def find_balance(value, path=""):
    """Ищет числовое поле остатка в ответе account, не сохраняя сам ответ."""
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            name = f"{path}.{key}" if path else str(key)
            if (
                isinstance(item, (int, float))
                and not isinstance(item, bool)
                and re.search(r"credit|balance|remain|point", str(key), re.I)
            ):
                found.append((name, float(item)))
            else:
                found += find_balance(item, name)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found += find_balance(item, f"{path}[{index}]")
    return found


def account_balance(cli="kling", timeout=60):
    try:
        resolve_kling_cli(cli)
    except OSError as error:
        return None, str(error)
    try:
        # Цена и submit используют тот же CLI; Electron-режим остаётся только в его дочернем процессе.
        result = run_kling_cli([cli, "account", "--quiet"], timeout)
        body = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None, "ответ account не получен или не разобран"
    if not isinstance(body, dict) or body.get("ok") is False or body.get("isError"):
        return None, "account вернул ошибку"
    found = find_balance(body.get("body", body))
    if not found:
        return None, "в ответе account нет числового поля остатка"
    preferred = [f for f in found if re.search(r"remain|available|balance|left", f[0], re.I)]
    name, value = (preferred or found)[0]
    return value, name


def check(request, pricing, balance=None, balance_source=None, cli="kling", use_account=True, timeout=60):
    estimated = estimate(pricing, request)
    if balance is None and use_account:
        balance, balance_source = account_balance(cli, timeout)
    elif balance is not None:
        balance_source = balance_source or "указан вручную"
    else:
        balance_source = "запрос к аккаунту отключён"
    credits = estimated["credits"]
    if credits is None or balance is None:
        verdict = "cost_or_balance_unknown"
    elif balance >= credits:
        verdict = "ok"
    else:
        verdict = "insufficient_balance"
    reasons = list(estimated["missing"])
    if balance is None:
        reasons.append("остаток неизвестен: " + str(balance_source))
    return {
        "model": request.get("model"),
        "kind": request.get("kind"),
        "command": request.get("command"),
        "parameters": request.get("parameters", {}),
        "outputs": request.get("outputs", 1),
        "estimate_credits": credits,
        "estimate_source": estimated["source"],
        "balance_credits": balance,
        "balance_source": balance_source,
        "verdict": verdict,
        "verdict_label": VERDICTS[verdict],
        "reasons": reasons,
    }


def learn(work_dir, pricing_path=PRICING):
    """Записывает фактический расход отправленной попытки как наблюдение тарифа."""
    directory = work_path(work_dir)
    request = json.loads((directory / "request.json").read_text(encoding="utf-8"))
    attempt = json.loads((directory / "attempt.json").read_text(encoding="utf-8"))
    credits = number(attempt.get("credits_consumed"))
    if credits is None:
        raise ValueError("В attempt.json нет credits_consumed; наблюдение не записано.")
    parameters = request.get("parameters", {})
    if request["kind"] == "image":
        observation = {
            "model": request["model"],
            "kind": "image",
            "command": request.get("command"),
            "img_resolution": parameters.get("img_resolution"),
            "quality": parameters.get("quality"),
            "image_signature": image_signature(request),
            "outputs": request.get("outputs", 1),
            "credits": credits,
        }
    else:
        observation = {
            "model": request["model"],
            "kind": request["kind"],
            "resolution": parameters.get("resolution"),
            "duration": parameters.get("duration"),
            "outputs": request.get("outputs", 1),
            "credits": credits,
        }
    pricing = load_pricing(pricing_path)
    if observation not in pricing["observed"]:
        pricing["observed"].append(observation)
        save_pricing(pricing, pricing_path)
    return observation


def table(report):
    parameters = report["parameters"]
    details = (
        f"command={report.get('command', '—')}, img_resolution={parameters.get('img_resolution', '—')}, "
        f"quality={parameters.get('quality', '—')}, результатов {report['outputs']}"
        if report["kind"] == "image"
        else (
            f"duration={parameters.get('duration', '—')}, resolution={parameters.get('resolution', '—')}, "
            f"результатов {report['outputs']}"
        )
    )
    lines = [
        "| Параметр | Значение |",
        "| --- | --- |",
        f"| Модель | {report['model']} ({report['kind']}) |",
        f"| Параметры | {details} |",
        f"| Оценка | {format_credits(report['estimate_credits'])} ({report['estimate_source'] or 'нет данных'}) |",
        f"| Остаток | {format_credits(report['balance_credits'])} ({report['balance_source']}) |",
        f"| Вердикт | {report['verdict_label']} (`{report['verdict']}`) |",
    ]
    for reason in report["reasons"]:
        lines.append(f"| Причина | {reason} |")
    return "\n".join(lines)


def format_credits(value):
    if value is None:
        return "неизвестно"
    return f"{value:g} кредитов"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("check")
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--work-dir", type=Path)
    group.add_argument("--request", type=Path)
    p.add_argument("--balance", type=float, help="Остаток из кабинета, если account недоступен.")
    p.add_argument("--no-account", action="store_true", help="Не обращаться к аккаунту.")
    p.add_argument("--pricing", type=Path, default=PRICING)
    p.add_argument("--cli", default="kling")
    p.add_argument("--timeout", type=float, default=60)
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("learn")
    p.add_argument("--work-dir", type=Path, required=True)
    p.add_argument("--pricing", type=Path, default=PRICING)
    args = parser.parse_args()
    try:
        if args.action == "learn":
            observation = learn(args.work_dir, args.pricing)
            print("Наблюдение записано: " + json.dumps(observation, ensure_ascii=False))
            return
        request, _ = load_request(args.work_dir, args.request)
        report = check(
            request, load_pricing(args.pricing), args.balance, None, args.cli, not args.no_account, args.timeout
        )
        print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else table(report))
        if report["verdict"] != "ok":
            raise SystemExit(2)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(
            1,
            (
                str(error)
                if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError)
                else "Ошибка локальных данных; сырой вывод скрыт."
            )
            + "\n",
        )


if __name__ == "__main__":
    main()
