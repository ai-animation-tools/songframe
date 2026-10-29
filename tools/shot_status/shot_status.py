"""Статусы планов по реестру, assets, очереди и рабочим попыткам; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import json
import re

from tools.common import ROOT
from tools.scene_registry.scene_registry import load, project_shot_acceptance
from tools.scene_registry.scene_registry import shots as registry_shots

# Названия статусов и этапов описаны в README инструмента; здесь они только вычисляются.
# @link README.md
STATUS_LABELS = {
    "planned": "запланирована",
    "progress": "в работе",
    "completed": "готова",
    "stale": "постановка изменена",
    "unknown": "статус не установлен",
}
STAGE_LABELS = {
    "description_review": "описание на согласовании",
    "image_request_choice": "запрос изображения на подтверждении",
    "image_submitted": "изображение генерируется",
    "image_downloaded": "изображение получено, ожидает выбора",
    "keyframes_review": "опоры на согласовании",
    "prompt_review": "видеопромпт на согласовании",
    "request_choice": "запрос на подтверждении",
    "ready": "отложено в plan/awaiting",
    "awaiting": "отложено в plan/awaiting",
    "needs_revision": "требует исправления",
    "edit_review": "генерация принята, монтажный участок не выбран",
    "accepted": "принята, перенос в assets не завершён",
    "submitted": "генерируется",
    "downloaded": "результат получен, ожидает просмотра",
}
ATTEMPT_LABELS = {
    "prepared": "запрос на подтверждении",
    "submitting": "исход отправки неизвестен",
    "submission_unknown": "исход отправки неизвестен",
    "submitted": "генерируется",
    "running": "генерируется",
    "downloading": "получение результата",
    "download_pending": "получение результата",
    "watermark_free_pending": "получение результата без логотипа",
    "outputs_pending": "получение результатов",
    "downloaded": "результат получен, ожидает просмотра",
    "failed": "ошибка генерации, требует решения",
}
WAIT_LABELS = {
    "user_saved": "отложено по решению пользователя",
    "insufficient_balance": "нехватка средств",
    "cost_or_balance_unknown": "стоимость или баланс неизвестны",
}
SHOT_PREFIX = re.compile(r"^(m\d{2}(?:\.\d+)?)(?![\d.])", re.I)


def read_json(path):
    """Возвращает объект, None для отсутствующего файла и False для повреждённого."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return False


def shot_of(directory, workflow, request):
    for document in (workflow, request):
        if isinstance(document, dict) and isinstance(document.get("shot"), str):
            return document["shot"]
    match = SHOT_PREFIX.match(directory.name)
    return match.group(1).upper() if match else None


def package_state(directory):
    """Этап одного рабочего пакета: очередь или попытка в plan/batches."""
    workflow = read_json(directory / "workflow.json")
    # Свежий пакет хранит request_dir: null до заморозки запроса; это обычное состояние, а не ошибка.
    request_dir = directory / ((workflow.get("request_dir") if isinstance(workflow, dict) else None) or "request")
    attempt = read_json(request_dir / "attempt.json")
    if attempt is None:
        attempt = read_json(directory / "attempt.json")
    request = read_json(request_dir / "request.json")
    if request is None:
        request = read_json(directory / "request.json")
    if workflow is False or attempt is False or request is False:
        return {"shot": shot_of(directory, None, None), "stage": "файлы пакета повреждены", "unknown": True}
    if workflow is None and attempt is None and request is None:
        return None
    shot = shot_of(directory, workflow, request)
    stage = None
    # Состояние исполнения принадлежит attempt.json и важнее этапа подготовки,
    # кроме ещё не отправленного запроса. @link ../media_request/request-format.md
    if isinstance(attempt, dict) and attempt.get("status") not in (None, "prepared"):
        stage = ATTEMPT_LABELS.get(attempt["status"], "состояние попытки: " + str(attempt["status"]))
    elif isinstance(workflow, dict):
        raw = workflow.get("stage")
        stage = STAGE_LABELS.get(raw, "этап: " + str(raw) if raw else None)
        if raw == "keyframes_review" and workflow.get("current_keyframe"):
            stage = f"кадр {workflow['current_keyframe']} на согласовании"
        if workflow.get("wait_reason") in WAIT_LABELS:
            stage = f"{stage}; {WAIT_LABELS[workflow['wait_reason']]}"
    elif isinstance(attempt, dict):
        stage = ATTEMPT_LABELS["prepared"]
    unknown = stage is None or shot is None
    return {"shot": shot, "stage": stage or "этап не определён", "unknown": unknown}


def work_packages(root):
    """Собирает пакеты очереди и рабочих папок по планам; пробы попадают в примечания."""
    packages, reviews = {}, {}
    for folder in sorted((root / "plan/awaiting").glob("M*")):
        if folder.is_dir():
            state = package_state(folder) or {"shot": folder.name, "stage": "пакет очереди без файлов", "unknown": True}
            state.update(kind="awaiting", path=str(folder.relative_to(root)))
            packages.setdefault(state["shot"] or folder.name, []).append(state)
    for folder in sorted((root / "plan/batches").glob("*")):
        if not folder.is_dir():
            continue
        state = package_state(folder)
        if state:
            state.update(kind="batch", path=str(folder.relative_to(root)))
            packages.setdefault(state["shot"] or folder.name, []).append(state)
        for review in folder.glob("*.json"):
            document = read_json(review)
            if isinstance(document, dict) and document.get("status") == "review_pending":
                for item in document.get("shots", []):
                    if isinstance(item, dict) and item.get("id"):
                        reviews.setdefault(item["id"], []).append(str(review.relative_to(root)))
    return packages, reviews


def collect(root=ROOT):
    root = Path(root).resolve()
    data = load(root)
    items = registry_shots(data)
    packages, reviews = work_packages(root)
    acceptance = project_shot_acceptance(root, data)
    rows = []
    for scene in items:
        sid = scene["id"]
        own = packages.get(sid, [])
        notes = [f"{p['kind']}: {p['path']} ({p['stage']})" for p in own]
        notes += [f"проба: {path}" for path in reviews.get(sid, [])]
        if acceptance.get(sid) == "completed":
            # Комплект принят по текущей постановке; незавершённая
            # альтернатива не отменяет готовность и показывается примечанием.
            status, stage = "completed", "выбранный комплект в assets"
        elif acceptance.get(sid) == "stale":
            # Комплект сделан по прежней постановке плана или его источника: нужно новое производство.
            source = (scene.get("derived_from") or {}).get("shot")
            status = "stale"
            if acceptance.get(source) == "stale":
                stage = f"постановка {source} изменена после приёмки: нужно новое производство"
            else:
                stage = "постановка изменена после приёмки: нужно новое производство"
            if own:
                stage += f"; новая работа: {own[0]['stage']}"
        elif any(p["unknown"] for p in own):
            status, stage = "unknown", own[0]["stage"]
        elif own:
            status, stage = "progress", own[0]["stage"]
        else:
            status, stage = "planned", "постановка в реестре, работа не начата"
        rows.append(
            {
                "id": sid,
                "interval": scene["interval"],
                "duration": scene["duration"],
                "lipsync": bool(scene.get("lipsync")),
                "status": status,
                "label": STATUS_LABELS[status],
                "stage": stage,
                "notes": notes,
            }
        )
    queue = [r["id"] for r in rows if any(p["kind"] == "awaiting" for p in packages.get(r["id"], []))]
    candidate = next((r["id"] for r in rows if r["status"] != "completed"), None)
    return {
        "shots": rows,
        "queue": queue,
        "next": candidate,
        "unassigned_packages": {
            k: [p["path"] for p in v] for k, v in packages.items() if k not in {r["id"] for r in rows}
        },
    }


def ancestors(data, sid):
    """Все планы, от которых наследуется состояние sid, включая повтор same."""
    scenes = {s["id"]: s for s in data["scenes"]}
    order = [s["id"] for s in data["scenes"]]
    result, current = [], sid
    while True:
        scene = scenes[current]
        source = scene.get("state_from", order[order.index(current) - 1] if order.index(current) else None)
        if isinstance(source, dict):
            source = source.get("scene")
        if source is None or source in result:
            return result
        result.append(source)
        current = source


def has_changes(scene):
    return any(scene.get("state_changes", {}).get(phase) for phase in ("before", "after"))


def independence(data, ids):
    """Конфликты партии: более поздний план наследует изменения более раннего из той же партии."""
    scenes = {s["id"]: s for s in data["scenes"]}
    missing = [sid for sid in ids if sid not in scenes]
    if missing:
        raise ValueError("Неизвестные планы: " + ", ".join(missing))
    if len(set(ids)) != len(ids):
        raise ValueError("План указан в партии дважды.")
    conflicts = []
    for later in ids:
        chain = ancestors(data, later)
        for earlier in ids:
            if earlier != later and earlier in chain and has_changes(scenes[earlier]):
                conflicts.append(
                    {
                        "shot": later,
                        "depends_on": earlier,
                        "reason": f"{later} наследует состояние после изменений {earlier}",
                    }
                )
    return conflicts


def adjacent_pairs(data, ids):
    """Соседи по шкале: стык между ними нельзя сверить с фактическим кадром, пока оба не готовы."""
    order = [s["id"] for s in data["scenes"]]
    positions = sorted((order.index(sid), sid) for sid in ids)
    return [
        {
            "first": a,
            "second": b,
            "reason": f"{a} и {b} соседи по монтажной шкале: стык между ними проверяется только после получения обоих",
        }
        for (i, a), (j, b) in zip(positions, positions[1:])
        if j == i + 1
    ]


def table(result, status_filter="all"):
    rows = [r for r in result["shots"] if status_filter == "all" or r["status"] == status_filter]
    lines = ["| План | Окно | Статус | Этап | Примечания |", "| --- | --- | --- | --- | --- |"]
    for r in rows:
        lines.append(
            f"| {r['id']} | {r['interval']} · {r['duration']} с | {r['label']} | {r['stage']} | "
            f"{'; '.join(r['notes']) or '—'} |"
        )
    counts = {k: sum(r["status"] == k for r in result["shots"]) for k in STATUS_LABELS}
    summary = ", ".join(f"{STATUS_LABELS[k]}: {v}" for k, v in counts.items() if v)
    lines += ["", f"Всего {len(result['shots'])}; {summary}."]
    if result["queue"]:
        lines.append("Очередь plan/awaiting: " + ", ".join(result["queue"]) + ".")
    lines.append("Кандидат next: " + (result["next"] or "нет, все планы готовы") + ".")
    for shot, paths in result["unassigned_packages"].items():
        lines.append(f"Пакет без плана в реестре: {shot} — {', '.join(paths)}.")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--filter", choices=["all", "planned", "progress", "completed", "stale", "unknown"], default="all"
    )
    parser.add_argument("--json", action="store_true", help="Машиночитаемый вывод для приложения.")
    parser.add_argument("--next", action="store_true", help="Только кандидат next и очередь.")
    parser.add_argument("--independent", nargs="+", metavar="Mxx", help="Проверить независимость партии планов.")
    args = parser.parse_args()
    try:
        if args.independent:
            data = load(ROOT)
            conflicts = independence(data, args.independent)
            adjacent = adjacent_pairs(data, args.independent)
            if args.json:
                print(
                    json.dumps(
                        {"shots": args.independent, "conflicts": conflicts, "adjacent": adjacent},
                        ensure_ascii=False,
                        indent=2,
                    )
                )
            elif conflicts:
                parser.exit(1, "\n".join(c["reason"] for c in conflicts) + "\n")
            else:
                print("Планы независимы по состоянию: " + ", ".join(args.independent) + ".")
                for pair in adjacent:
                    print("Предупреждение: " + pair["reason"] + ".")
            return
        result = collect(ROOT)
        if args.json:
            print(
                json.dumps(
                    result if not args.next else {"next": result["next"], "queue": result["queue"]},
                    ensure_ascii=False,
                    indent=2,
                )
            )
        elif args.next:
            print("Кандидат next: " + (result["next"] or "нет") + ".")
            if result["queue"]:
                print("Очередь plan/awaiting: " + ", ".join(result["queue"]) + ".")
        else:
            print(table(result, args.filter))
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
