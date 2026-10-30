"""Производные документы из реестра сцен и технических комплектов; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import hashlib
import json
import os
import re
import subprocess
from decimal import ROUND_HALF_UP, Decimal

from tools.common import ROOT
from tools.project_inputs import project_inputs_match
from tools.scene_registry.scene_registry import (
    PRODUCTION_STATUS,
    accepted_fingerprints,
    clock,
    shot_acceptance,
    shots,
    source_video_snapshot,
    validate,
    validate_project,
)


class Sources:
    """Читает рабочие файлы с диска, индекс и историю — через Git."""

    def __init__(self, ref=None):
        self.ref = ref
        if ref is None:
            # Рабочие представления читают фактические материалы; Git нужен только для индекса и истории.
            self.files = set()
            for directory, folders, files in os.walk(ROOT):
                folders[:] = [name for name in folders if name not in (".git", ".local", "__pycache__", "node_modules")]
                self.files.update((Path(directory) / name).relative_to(ROOT).as_posix() for name in files)
        else:
            args = ["ls-files", "-z"] if ref == ":" else ["ls-tree", "-r", "--name-only", "-z", ref]
            try:
                self.files = set(subprocess.check_output(["git", "-C", str(ROOT), *args]).decode().split("\0")) - {""}
            except FileNotFoundError as error:
                raise ValueError(
                    "Для проверки индекса и снимков установите Git. Рабочие файлы проверяются без Git."
                ) from error
        self.inputs = {}

    def text(self, path):
        if path not in self.files:
            raise ValueError(f"Нет обязательного файла: {path}")
        value = (
            (ROOT / path).read_text()
            if self.ref is None
            else subprocess.check_output(
                ["git", "-C", str(ROOT), "show", (":" if self.ref == ":" else self.ref + ":") + path]
            ).decode()
        )
        self.inputs[path] = hashlib.sha256(value.encode()).hexdigest()
        return value

    def json(self, path):
        return json.loads(self.text(path))

    def require(self, path):
        if path not in self.files:
            raise ValueError(f"Нет материала: {path}")

    def digest(self, path):
        """В снимке LFS читаем oid, не выдавая хеш текстового указателя за медиа."""
        if self.ref is None:
            return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
        raw = subprocess.check_output(
            ["git", "-C", str(ROOT), "show", (":" if self.ref == ":" else self.ref + ":") + path]
        )
        match = (
            re.search(rb"^oid sha256:([a-f0-9]{64})$", raw, re.M)
            if raw.startswith(b"version https://git-lfs.github.com/spec/v1")
            else None
        )
        return match[1].decode() if match else hashlib.sha256(raw).hexdigest()


def cell(text):
    return re.sub(r"\s+", " ", str(text)).replace("|", "\\|").strip()


def derived_label(scene, separator=" · "):
    """Пометка «из Mxx» у плана из материала другого плана; у обычного плана пусто."""
    source = scene.get("derived_from")
    return f"{separator}из {source['shot']}" if source else ""


def prepared(sources):
    data = validate(sources.json("plan/scenes.json"))
    items = shots(data)
    packages = {}
    for scene in items:
        path = f"assets/shots/{scene['id']}/manifest.json"
        if path in sources.files:
            packages[scene["id"]] = sources.json(path)
    return data, items, packages


def in_progress(sources):
    """Планы с рабочим пакетом производства: незавершённая работа видна только по workflow.json пакетов."""
    result = set()
    for path in sources.files:
        parts = path.split("/")
        package = len(parts) == 4 and parts[0] == "plan" and parts[1] in ("batches", "awaiting")
        if not package or parts[3] != "workflow.json":
            continue
        try:
            workflow = sources.json(path)
        except ValueError:
            continue
        if isinstance(workflow, dict) and isinstance(workflow.get("shot"), str):
            result.add(workflow["shot"])
    return result


def progress(items, states, fps):
    """Строит диаграмму и проценты из тех же состояний, что и строки ROADMAP."""
    counts = {state: 0 for state in ["Готово", "Постановка изменена", "В процессе", "Запланировано"]}
    total_frames = sum(s["frames"] for s in items)
    ready_frames = 0
    for scene in items:
        state = states[scene["id"]]
        counts[state] += 1
        if state == "Готово":
            ready_frames += scene["frames"]

    def percent(value, total):
        result = Decimal(value) * 100 / total if total else Decimal(0)
        return format(result.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP), "f").replace(".", ",") + "%"

    lines = ["## Готовность проекта", ""]
    if items:
        lines += ["```mermaid", "pie showData", "    title Состояние планов"]
        # Нулевые секторы не передаются Mermaid; все статусы остаются в таблице.
        for state, count in counts.items():
            if count:
                lines.append(f'    "{state} — {percent(count, len(items))}" : {count}')
        lines += ["```", ""]
    lines += ["| Состояние | Планов | Доля от общего числа |", "| --- | ---: | ---: |"]
    for state, count in counts.items():
        # Строка изменённой постановки появляется только при таких планах; прочие состояния видны всегда.
        if count or state != "Постановка изменена":
            lines.append(f"| {state} | {count} | {percent(count, len(items))} |")
    ready_time = clock((Decimal(ready_frames) / fps).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))
    total_time = clock((Decimal(total_frames) / fps).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))
    lines += [
        "",
        f"**По хронометражу готово {percent(ready_frames, total_frames)}** — {ready_time} из {total_time}.",
        (
            "Доли по планам считаются по их количеству, по хронометражу — по "
            "кадровым границам. Готов план, выбранный комплект которого в assets "
            "принят по текущей постановке; после её правки план требует нового производства."
        ),
        "",
    ]
    return lines


# Подписи столбца «В полном монтаже»: клип, текстовая карточка или карточка принятых опор.
MEDIA_LABELS = {"video": "Видео", "card": "Карточка", "keyframes": "Опоры"}


def render(sources):
    """ROADMAP выводит текущее состояние, не читая копии постановки из Markdown."""
    data, items, packages = prepared(sources)
    # Просмотр не зависит от готовности провайдеров и настроек другого медиа.
    project = validate_project(sources.json("plan/project.json"), validate_generation=False)
    work = sources.json(PRODUCTION_STATUS)
    latest_path = work["current_animatic"]
    compiled = {s["id"]: s for s in sources.json(latest_path)["shots"]} if latest_path in sources.files else {}
    manifest = sources.json(latest_path) if latest_path in sources.files else {}
    hashes = manifest.get("source_hashes")
    # Проверяем все записанные медиа; поля проекта принадлежат только project_inputs.
    fresh = (
        latest_path in sources.files
        and sources.json(latest_path).get("scene_registry_sha256")
        == hashlib.sha256(sources.text("plan/scenes.json").encode()).hexdigest()
        and project_inputs_match(
            sources.json(latest_path),
            project,
            animatic=True,
        )
        and isinstance(hashes, dict)
        and bool(hashes)
        and all(name in sources.files and sources.digest(name) == digest for name, digest in hashes.items())
    )
    build_state = (
        "Полная сборка ожидает просмотра."
        if fresh
        else "Сборка устарела относительно исходников; требуется пересборка."
    )
    active = in_progress(sources)

    # Принятие привязано к постановке: правило общее с shot_status, @link ../scene_registry/README.md#принятие-планов
    def source_snapshot(sid):
        # Для Git-снимка берётся SHA сохранённого файла/LFS oid; рабочий проект читает фактические байты.
        if sources.ref is None:
            return source_video_snapshot(ROOT, sid)
        try:
            package = packages[sid]
            if (
                package.get("schema_version") != 1
                or package.get("shot") != sid
                or package.get("kind") == "derived_video"
            ):
                return None
            video = package["accepted_edit"]["video"]
            name = video["path"]
            if (
                not isinstance(name, str)
                or not name
                or Path(name).is_absolute()
                or ".." in Path(name).parts
                or video.get("root", "asset") != "asset"
            ):
                return None
            path = f"assets/shots/{sid}/{name}"
            digest = sources.digest(path) if path in sources.files else None
            return digest if digest == video["sha256"] else None
        except (KeyError, OSError, ValueError, TypeError, AttributeError):
            return None

    acceptance = shot_acceptance(data, packages, accepted_fingerprints(work), source_snapshot=source_snapshot)
    labels = {"completed": "Готово", "stale": "Постановка изменена"}
    states = {
        s["id"]: labels.get(acceptance.get(s["id"])) or ("В процессе" if s["id"] in active else "Запланировано")
        for s in items
    }
    ready = sum(state == "Готово" for state in states.values())
    lines = [
        f"# ROADMAP — состояние клипа «{project['name']}»",
        "",
        (
            "> Автоматическое представление plan/scenes.json, локальных "
            "ассетов и состояния работ. Вручную не редактировать."
        ),
        "",
        (
            f"Всего {len(items)} планов; готовы {ready}. [Текущий "
            f"полный монтаж](plan/animatic/latest/README.md). {build_state}"
        ),
        "",
        "| План | Тайминг | Действие | Состояние | Материалы | В полном монтаже |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    table_start = lines.index("| План | Тайминг | Действие | Состояние | Материалы | В полном монтаже |")
    lines[table_start:table_start] = progress(items, states, data["fps"]) + ["## Планы", ""]
    for s in items:
        sid = s["id"]
        package = packages.get(sid)
        state = states[sid]
        link = f"[Постановка](plan/storyboard.md#{sid.lower()})"
        if package:
            video = f"assets/shots/{sid}/" + package["accepted_edit"]["video"]["path"]
            sources.require(video)
            link += f" · [Манифест](assets/shots/{sid}/manifest.json) · [Видео]({video})"
        included = MEDIA_LABELS.get(compiled.get(sid, {}).get("media"), "Карточка") if fresh else "Устаревшая сборка"
        lines.append(
            (
                f"| **{sid}**{derived_label(s)} | {s['interval']} · {s['duration']} с | "
                f"{cell(s['action'])} | **{state}** | {link} | {included} |"
            )
        )
    lines += [
        "",
        (
            "Изменять постановку и монтажные границы только в [реестре "
            "сцен](plan/scenes.json). [Сценарий](source/description.md) "
            "описывает общую историю. Генерации и обработка сохраняются в "
            "локальных манифестах assets. Незавершённая работа — в рабочих "
            "пакетах `plan/batches` и `plan/awaiting` (страница «Производство»)."
        ),
        "",
        (
            "Представления обновляет приложение: кнопка «Пересобрать карточки» в строке "
            "«Карточки и списки» на странице «Проверки»; проверка той же строки "
            "находит рассинхрон."
        ),
        "",
    ]
    return "\n".join(lines)


def documents(sources):
    data, items, packages = prepared(sources)
    project = validate_project(sources.json("plan/project.json"), validate_generation=False)
    banner = (
        "> Автоматическое представление [plan/scenes.json]({registry}). "
        "Изменять только реестр; этот файл не является отдельным "
        "источником постановки.\n"
    )
    # Заголовок и разделитель используют один набор столбцов. Иначе Markdown
    # при несовпадении числа ячеек показывает весь список обычным текстом.
    edit_columns = [
        "План",
        "Исходный план",
        "Начало → конец",
        "Секунды",
        "Крупность и камера",
        "Действие",
        "Непрерывность",
        "Референсы",
    ]
    edit = [
        f"# Монтажный список клипа «{project['name']}»",
        "",
        banner.format(registry="scenes.json"),
        "| " + " | ".join(edit_columns) + " |",
        "| " + " | ".join("---" for _ in edit_columns) + " |",
    ]
    for s in items:
        edit.append(
            "| "
            + " | ".join(
                cell(v)
                for v in [
                    s["id"] + derived_label(s),
                    s["original"],
                    s["interval"],
                    s["duration"],
                    s["camera"],
                    s["action"],
                    s["continuity"],
                    " ".join(s["references"]),
                ]
            )
            + " |"
        )
    story = [
        f"# Постановка сцен клипа «{project['name']}»",
        "",
        banner.format(registry="scenes.json"),
        (
            "Общая история — в [сценарии](../source/description.md); "
            "роли, внешность и начальное состояние персонажей — в кастинге "
            "[plan/cast.json](cast.json) (страница «Кастинг»); общие визуальные "
            "правила и речевые планы — в [визуальном справочнике](context/characters.md)."
        ),
        "",
    ]
    for group in data["sequences"]:
        members = [s for s in items if s["sequence"] == group["id"]]
        if not members:
            continue
        story += [
            "## " + ("Вступление" if group["id"] == "intro" else "Сцена " + group["id"]) + ". " + group["title"],
            "",
            group["direction"],
            "",
        ]
        for s in members:
            story += [
                f'<a id="{s["id"].lower()}"></a>',
                f"### {s['id']}. {s['title']}",
                "",
                f"**Монтаж:** {s['interval']} · {s['duration']} с.",
                "",
            ]
            if s.get("derived_from"):
                origin = s["derived_from"]["shot"]
                story += [f"**Материал:** из [{origin}](#{origin.lower()}), без собственной генерации.", ""]
            story += [
                f"**Камера:** {s['camera']}",
                "",
                s["action"],
                "",
                f"**Непрерывность:** {s['continuity']}",
                "",
                s.get("notes", ""),
                "",
            ]
            # Показываем источник и локальные изменения, а не сохраняем полную
            # вычисленную копию состояния в каждом разделе раскадровки.
            # Инструменты принадлежат комплексу, поэтому ссылки на tools внутри проекта нет.
            source = s.get("state_from")
            origin = source.get("scene") if isinstance(source, dict) else source
            phase = source.get("phase", "after") if isinstance(source, dict) else "after"
            link = f"[{origin}](#{origin.lower()}) ({phase})" if origin else "начало сюжетной линии"
            story += [f"**Состояние:** {link}; сводку до/после получить инструментом `scene_registry` комплекса.", ""]
            for moment, delta in s.get("state_changes", {}).items():
                facts = "; ".join(
                    f"{entity}.{key}: {value if value is not None else 'не задано'}"
                    for entity, attributes in delta.items()
                    for key, value in attributes.items()
                )
                story += [f"**Изменения {moment}:** {facts}", ""]
    index = {
        "schema_version": 2,
        "description": (
            "Автоматический индекс локальных технических комплектов; постановка и тайминг принадлежат plan/scenes.json."
        ),
        "shots": {
            sid: {
                "asset_manifest": {
                    "path": f"assets/shots/{sid}/manifest.json",
                    "sha256": hashlib.sha256(sources.text(f"assets/shots/{sid}/manifest.json").encode()).hexdigest(),
                }
            }
            for sid in packages
        },
    }
    output = {
        "plan/edit-list.md": "\n".join(edit) + "\n",
        "plan/storyboard.md": "\n".join(story),
        "assets/shots/manifest.json": json.dumps(index, ensure_ascii=False, indent=2) + "\n",
        "ROADMAP.md": render(sources),
    }
    # Общие правила имеют один источник, а речевые планы выводятся из флага Mxx.
    # Отдельная копия правил и вручную поддерживаемый список липсинка не нужны.
    speech = [s for s in items if s.get("lipsync")]
    speech_view = (
        "\n\n## Речевые планы\n\nВсего "
        + str(len(speech))
        + ". "
        + ", ".join(f"[{s['id']}](../storyboard.md#{s['id'].lower()})" for s in speech)
        + ".\n"
        if speech
        else "\n\n## Речевые планы\n\nРечевые планы не назначены.\n"
    )
    output["plan/context/characters.md"] = (
        banner.format(registry="../scenes.json") + "\n" + data["visual_direction"].strip() + speech_view
    )
    for s in items:
        sid = s["id"]
        if sid not in packages:
            continue
        p = packages[sid]
        g = p["generation"]
        edit = p["accepted_edit"]
        links = [
            f"[Полный оригинал]({g['original']['path']})",
            f"[Принятый монтаж]({edit['video']['path']})",
            f"[Промпт]({g['prompt']['path']})",
        ]
        if g.get("audio"):
            links.append(f"[Аудио липсинка]({g['audio']['path']})")
        output[f"assets/shots/{sid}/README.md"] = (
            (
                f"# {sid} — технический комплект\n\n> Автоматическое "
                f"представление. Постановка и тайминг — только в [реестре "
                f"сцен](../../../plan/scenes.json) и его "
                f"[представлении](../../../plan/storyboard.md#{sid.lower()}).\n\n"
            )
            + " · ".join(links)
            + (
                f"\n\n[manifest.json](manifest.json) хранит файлы, хеши и рецепт "
                f"обработки генерации. Принятый клип: {edit['frames']} кадров при "
                f"{edit['fps']} кадр/с. Положение на шкале клипа в ассете не "
                f"дублируется.\n"
            )
        )
    audio = sources.json("plan/audio/timing.json")
    timing = [
        "# Речевые и музыкальные оценки",
        "",
        (
            "> Автоматическое представление [timing.json](timing.json). Эти "
            "оценки не задают монтажные границы: они принадлежат [реестру "
            "сцен](../scenes.json)."
        ),
        "",
        audio["status"],
        "",
        "## Структура песни",
        "",
        "| Часть | Начало | Конец | Примечание |",
        "| --- | --- | --- | --- |",
    ]
    for item in audio["sections"]:
        timing.append(
            "| "
            + " | ".join(
                cell(x)
                for x in [item["name"], clock(str(item["start"])), clock(str(item["end"])), item.get("note", "")]
            )
            + " |"
        )
    timing += [
        "",
        "## Оценки строк вокала",
        "",
        "| ID | Строка исходного текста | Начало | Конец | Ограничения оценки |",
        "| --- | --- | --- | --- | --- |",
    ]
    for item in audio["lines"]:
        timing.append(
            "| "
            + " | ".join(
                cell(x)
                for x in [
                    item["id"],
                    item.get("source_line", ""),
                    clock(str(item["start"])),
                    clock(str(item["end"])),
                    item.get("note", ""),
                ]
            )
            + " |"
        )
    # Разметка самодостаточна: диагностические ответы ASR и нарезки трека
    # не входят в постоянные источники проекта. Инструмент принадлежит комплексу,
    # а не папке клипа. @link ../../templates/project/plan/README.md
    timing += [
        "",
        (
            "Точный текст — [source/text.md](../../source/text.md), исходное "
            "аудио — [source/track.mp3](../../source/track.mp3). Анализ "
            "выполняет инструмент `transcribe_local` комплекса; временные "
            "результаты сохранять вне папки проекта, во временной папке ОС. Слуховые поправки "
            "и новые оценки вносить в timing.json; постановку сцен здесь не "
            "повторять."
        ),
        "",
    ]
    output["plan/audio/timing.md"] = "\n".join(timing)
    return {
        name: "\n".join(line.rstrip() for line in text.splitlines()).rstrip() + "\n" for name, text in output.items()
    }
