"""Пересоздаёт проект-образец tools/testdata/sample-project по правилам шаблона комплекса; @link README.md

Образец это маленький клип на пять планов: тихий трек на 30 секунд, три строки текста, четыре референса,
кастинг с начальным состоянием, трактовка, реестр сцен с наследованием состояния, два принятых комплекта
(сделаны настоящим accept_shot из подставных оригиналов), пакет плана на согласовании опор, карточки,
производные представления и собранный аниматик. Документы шаблона копируются с плейсхолдерами:
tools/testing.py подставляет пути при копировании образца во временную папку.

    python3 -B tools/testdata/build_sample.py

Нужны ffmpeg, ffprobe и Pillow. Запуск заменяет содержимое sample-project целиком.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SAMPLE = Path(__file__).resolve().parent / "sample-project"
TEMPLATE = REPO / "templates/project"
FPS = 30
TRACK_SECONDS = 30
PROJECT = {
    "schema_version": 1,
    "name": "Пробный клип",
    "animatic_video": "sample-animatic.mp4",
    "generation": {
        "video": {
            "provider": "kling",
            "resolution": "1080p",
            "aspect_ratio": "16:9",
            "watermark": False,
            "duration_rule": "min_supported_strictly_greater_than_window",
        },
        "image": None,
    },
}
LYRICS = ["[Куплет]", "Вечер зажёг фонари у воды", "Ветер качает бумажные огни", "Мы отпускаем огни в небеса"]
IDEA = (
    "# Пробный клип\n\nДвое друзей украшают причал бумажными фонариками и провожают закат у воды. "
    "Образец для тестов комплекса: короткий трек без звука, однотонные референсы и подставные генерации.\n"
)
REFERENCES = [
    ("mira", "character", "Мира", "Мира", "Музыкант, держит фонарик", "heroes/mira.png", (200, 120, 80)),
    ("lev", "character", "Лев", "Лев", "Друг, развешивает фонарики", "heroes/lev.png", (80, 120, 200)),
    ("boat", "vehicle", "Лодка", "Лодка", "Небольшая лодка у причала", "vehicles/boat.png", (90, 90, 90)),
    ("pier", "location", "Причал", "Причал", "Деревянный причал у спокойной воды", "locations/pier.png", (110, 80, 40)),
]
INITIAL_STATE = {
    "world": {"time_of_day": "вечер", "weather": "ясно"},
    "mira": {"clothes_condition": "светлая куртка", "position": "у края причала"},
    "lev": {"position": "рядом с фонарями"},
    "boat": {"dirt": "чистая", "sink": "у причала"},
}
TIMING_LINES = [(1, 2, 8.0, 12.0), (2, 3, 12.0, 16.0), (3, 4, 16.0, 20.0)]
SECTIONS = [("Вступление", 0.0, 8.0), ("Куплет", 8.0, 20.0), ("Проигрыш", 20.0, 30.0)]
TREATMENT = [
    {
        "id": "intro",
        "title": "Вечер у воды",
        "direction": "Общий план причала, спокойный темп.",
        "start": 0.0,
        "end": 8.0,
        "entities": ["boat", "pier"],
        "lipsync": False,
        "max_shot_seconds": 8,
    },
    {
        "id": "verse",
        "title": "Фонарики",
        "direction": "Друзья развешивают фонарики.",
        "start": 8.0,
        "end": 20.0,
        "entities": ["mira", "lev", "boat", "pier"],
        "lipsync": True,
        "max_shot_seconds": 6,
    },
    {
        "id": "outro",
        "title": "Проигрыш",
        "direction": "Повтор общего плана как финальная точка.",
        "start": 20.0,
        "end": 30.0,
        "entities": ["mira", "lev", "boat"],
        "lipsync": False,
        "max_shot_seconds": 10,
    },
]
SCENES = [
    {
        "id": "M01",
        "original": "Вступление",
        "sequence": "intro",
        "title": "Вечер у воды",
        "start_frame": 0,
        "end_frame_exclusive": 240,
        "camera": "Общий план с воздуха, медленный наезд",
        "action": "Лодка покачивается у причала.",
        "continuity": "Начало клипа; лодка у причала.",
        "references": ["boat", "pier"],
        "lipsync": False,
        "card": {"primary_reference": "boat"},
        "state_from": None,
        "state_changes": {"after": {"boat": {"dirt": "с каплями воды"}}},
    },
    {
        "id": "M02",
        "original": LYRICS[1],
        "sequence": "verse",
        "start_frame": 240,
        "end_frame_exclusive": 360,
        "camera": "Средний план на причале",
        "action": "Мира держит фонарик, Лев смотрит на воду.",
        "continuity": "Продолжение вечера из M01.",
        "references": ["mira", "lev", "boat"],
        "lipsync": False,
        "card": {"primary_reference": "boat"},
        "state_from": "M01",
        "state_changes": {"after": {"boat": {"sink": "у края причала"}}},
    },
    {
        "id": "M03",
        "original": LYRICS[2],
        "sequence": "verse",
        "start_frame": 360,
        "end_frame_exclusive": 480,
        "camera": "Общий план сбоку",
        "action": "Фонарики качаются на ветру.",
        "continuity": "Лодка остаётся у причала.",
        "references": ["boat", "pier"],
        "lipsync": False,
        "card": {"primary_reference": "pier"},
        "state_from": "M02",
        "state_changes": {"after": {"boat": {"dirt": "покрыта каплями", "sink": "у края причала"}}},
    },
    {
        "id": "M04",
        "original": LYRICS[3],
        "sequence": "verse",
        "start_frame": 480,
        "end_frame_exclusive": 600,
        "camera": "Крупный план Миры",
        "action": "Мира поднимает фонарик, Лев улыбается.",
        "continuity": "Мира стоит у воды.",
        "references": ["mira", "lev", "boat", "pier"],
        "lipsync": True,
        "card": {"primary_reference": "mira"},
        "state_from": "M03",
        "state_changes": {
            "before": {"mira": {"position": "стоит у края причала"}},
            "after": {"mira": {"clothes_condition": "яркая куртка"}},
        },
    },
    {
        "id": "M05",
        "original": "Проигрыш: повтор общего плана",
        "sequence": "outro",
        "title": "Финальный повтор",
        "start_frame": 600,
        "end_frame_exclusive": 900,
        "camera": "Как в M02, статика",
        "action": "Повтор кадра у воды как финальная точка.",
        "continuity": "Состояние как в M02: повтор, не продолжение.",
        "references": ["mira", "lev", "boat"],
        "lipsync": False,
        "card": {"primary_reference": "boat"},
        "state_from": {"scene": "M02", "phase": "same"},
        "state_changes": {},
    },
]
PROMPTS = {
    "M01": "Небольшая лодка у деревянного причала, спокойная вода, мягкий вечерний свет.",
    "M02": "Двое друзей на причале, бумажные фонарики, спокойная вода, мягкий свет.",
    "M03": "Бумажные фонарики качаются на ветру у воды, общий план сбоку.",
}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def dump(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run(args, cwd=None):
    result = subprocess.run([str(a) for a in args], cwd=cwd, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f"{' '.join(map(str, args))}\n{result.stdout}\n{result.stderr}")
    return result.stdout


def color_video(path, color, fps, frames):
    run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s=1920x1080:r={fps}",
            "-frames:v",
            frames,
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "32",
            "-tune",
            "stillimage",
            path,
        ]
    )


def image(path, color, size=(64, 36)):
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path, "PNG")


def make_sources(work):
    source = work / "source"
    (source / "text.md").write_text("\n".join(LYRICS) + "\n", encoding="utf-8")
    (source / "description.md").write_text(IDEA, encoding="utf-8")
    track = source / "track.mp3"
    run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=stereo",
            "-af",
            f"atrim=end_sample={TRACK_SECONDS * 44100}",
            "-ac",
            "2",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "16k",
            track,
        ]
    )
    # Декодированная длина считается по сэмплам: длительность контейнера MP3 включает заполнение последнего кадра.
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(track), "-f", "s16le", "-ac", "1", "-ar", "44100", "-"],
        capture_output=True,
        check=True,
    ).stdout
    decoded = len(pcm) / 2 / 44100
    container = float(
        run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", track]).strip()
    )
    if abs(decoded - TRACK_SECONDS) > 1 / FPS:
        raise SystemExit(f"Трек декодируется в {decoded} с вместо {TRACK_SECONDS}.")
    references = []
    for rid, kind, name, short, description, rel, color in REFERENCES:
        image(source / rel, color)
        references.append(
            {
                "id": rid,
                "kind": kind,
                "name": name,
                "short_name": short,
                "description": description,
                "prompt": None,
                "files": [
                    {
                        "path": rel,
                        "sha256": sha(source / rel),
                        "bytes": (source / rel).stat().st_size,
                        "view": "full",
                        "note": "",
                    }
                ],
            }
        )
    text = (source / "text.md").read_text(encoding="utf-8")
    dump(
        source / "manifest.json",
        {
            "schema_version": 1,
            "kinds": [
                {"id": "character", "label": "Персонаж", "dir": "heroes"},
                {"id": "vehicle", "label": "Транспорт", "dir": "vehicles"},
                {"id": "location", "label": "Локация", "dir": "locations"},
                {"id": "prop", "label": "Предмет", "dir": "props"},
                {"id": "style", "label": "Стиль", "dir": "style"},
            ],
            "track": {
                "path": "track.mp3",
                "sha256": sha(track),
                "bytes": track.stat().st_size,
                "original_name": "track.mp3",
                "duration_seconds": round(decoded, 6),
            },
            "lyrics": {
                "path": "text.md",
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
                "bytes": len(text.encode()),
                "lines": len(LYRICS) - 1,
                "sections": ["Куплет"],
            },
            "idea": {
                "path": "description.md",
                "sha256": sha(source / "description.md"),
                "bytes": (source / "description.md").stat().st_size,
            },
            "cover": None,
            "references": references,
            "updated_at": "2026-10-25T00:00:00Z",
        },
    )
    dump(
        work / "plan/audio/timing.json",
        {
            "version": 2,
            "status": "Разметка образца: границы заданы вручную и подтверждены",
            "source": "source/track.mp3",
            "sha256": sha(track),
            "duration_decoded": round(decoded, 6),
            "duration_container": round(container, 6),
            "clock": "Секунды от начала декодированного звука, не SMPTE",
            "lines": [
                {"id": i, "source_line": line, "start": start, "end": end, "verified": True}
                for i, line, start, end in TIMING_LINES
            ],
            "sections": [{"name": name, "start": start, "end": end} for name, start, end in SECTIONS],
        },
    )
    return decoded


def make_plan(work, decoded):
    dump(work / "plan/project.json", PROJECT)
    run([sys.executable, "-B", REPO / "tools/cast_registry/cast_registry.py", "--project", work, "init"])
    cast = json.loads((work / "plan/cast.json").read_text(encoding="utf-8"))
    roles = {rid: description for rid, _k, _n, _s, description, _r, _c in REFERENCES}
    for entity in cast["entities"]:
        entity["role"] = roles.get(entity["id"], entity.get("role", ""))
        entity["initial_state"] = INITIAL_STATE.get(entity["id"], {})
    dump(work / "plan/cast.json", cast)
    dump(
        work / "plan/treatment.json",
        {
            "schema_version": 1,
            "logline": "Двое друзей украшают причал фонариками и провожают закат.",
            "sequences": TREATMENT,
        },
    )
    references = {
        rid: ({"name": name, "path": "source/" + rel} | ({"short_name": short} if short != name else {}))
        for rid, _k, name, short, _d, rel, _c in REFERENCES
    }
    dump(
        work / "plan/scenes.json",
        {
            "schema_version": 1,
            "fps": FPS,
            "audio": {"path": "source/track.mp3", "end_seconds": str(TRACK_SECONDS)},
            "references": references,
            "visual_direction": "Причал у воды, мягкий вечерний свет; камера спокойная, без резких движений.",
            "sequences": [
                {"id": part["id"], "title": part["title"], "direction": part["direction"]} for part in TREATMENT
            ],
            "scenes": SCENES,
        },
    )
    print(
        run([sys.executable, "-B", REPO / "tools/cast_registry/cast_registry.py", "--project", work, "check"]).strip()
    )


def make_kit(work, sid, color, pricing):
    """Пакет с подставной генерацией и перенос в assets настоящим accept_shot."""
    from tools.accept_shot import accept_shot

    scene = next(s for s in SCENES if s["id"] == sid)
    frames = scene["end_frame_exclusive"] - scene["start_frame"]
    package = work / "plan/batches" / f"{sid}-attempt-01"
    request_dir = package / "request"
    (request_dir / "inputs").mkdir(parents=True)
    # Оригинал на 24 кадра/с чуть длиннее окна: приёмка режет его на сетке 30 кадров/с.
    color_video(request_dir / "original.mp4", color, 24, round(frames / FPS * 24) + 12)
    image(request_dir / "inputs/01.png", (64, 64, 64), (160, 90))
    (request_dir / "prompt.txt").write_text(PROMPTS[sid] + "\n", encoding="utf-8")
    first = request_dir / "inputs/01.png"
    request = {
        "schema_version": 1,
        "shot": sid,
        "kind": "video",
        "provider": "kling",
        "command": "image_to_video",
        "model": "kling-video-v3_0",
        "parameters": {
            "duration": 5 if frames <= 150 else 10,
            "resolution": "1080p",
            "aspect_ratio": "16:9",
            "prefer_multi_shots": False,
        },
        "outputs": 1,
        "inputs": [
            {
                "flag": "input",
                "slot": "image_1",
                "role": "first",
                "path": "inputs/01.png",
                "sha256": sha(first),
                "bytes": first.stat().st_size,
            }
        ],
        "prompt": {"path": "prompt.txt", "sha256": sha(request_dir / "prompt.txt")},
        "video_without_watermark": True,
    }
    dump(request_dir / "request.json", request)
    dump(
        request_dir / "attempt.json",
        {
            "schema_version": 1,
            "request_sha256": sha(request_dir / "request.json"),
            "status": "downloaded",
            "generation_id": f"sample-{sid.lower()}",
            "service_status": "completed",
            "credits_consumed": 35,
            "downloads": [
                {"number": 1, "path": "original.mp4", "bytes": (request_dir / "original.mp4").stat().st_size}
            ],
        },
    )
    dump(
        package / "workflow.json",
        {
            "schema_version": 1,
            "shot": sid,
            "stage": "downloaded",
            "request_dir": "request",
            "mode": "shot",
            "keyframes": [],
        },
    )
    accept_shot.accept(
        sid, package=package, root=work, cut=(0, frames), update_views=False, pricing=pricing, clean=True
    )


def make_package(work):
    """План M03 на согласовании опор: кандидат первой опоры и вопрос приложению."""
    from tools.shot_workflow import shot_workflow

    package = work / "plan/batches/M03-attempt-01"
    shot_workflow.init("M03", package, root=work)
    shot_workflow.plan_keyframes(package, 5, root=work)
    (package / "description.md").write_text(
        "Бумажные фонарики качаются на ветру у воды; камера сбоку.\n", encoding="utf-8"
    )
    candidate = work / "plan/batches/M03-candidate.png"
    image(candidate, (110, 80, 40), (160, 90))
    shot_workflow.propose(package, "K01", candidate, root=work)
    candidate.unlink()
    (package / "video-prompt.txt").write_text(PROMPTS["M03"] + "\n", encoding="utf-8")
    shot_workflow.ask(package, "keyframes_review", root=work)


def main():
    work = Path(tempfile.mkdtemp(prefix="sample-build-")) / "sample-project"
    shutil.copytree(TEMPLATE, work)
    run(["git", "init", "-q", work])
    os.environ["SONGFRAME_PROJECT"] = str(work)
    sys.path.insert(0, str(REPO))
    decoded = make_sources(work)
    make_plan(work, decoded)
    pricing = work.parent / "pricing.json"
    dump(pricing, {"schema_version": 1, "models": {}, "observed": []})
    make_kit(work, "M01", "0x2f4f6f", pricing)
    make_kit(work, "M02", "0x4f6f2f", pricing)
    make_package(work)
    print(
        run([sys.executable, "-B", REPO / "tools/update_scene_views/update_scene_views.py", "--project", work]).strip()
    )
    from tools.build_animatic import build_animatic

    report = build_animatic.build(root=work)
    print("аниматик:", report["status"], report["shots"], "планов, видео", report["video"], "карточек", report["cards"])
    status = json.loads((work / "plan/production-status.json").read_text(encoding="utf-8"))
    status.update(current_animatic="plan/animatic/latest/manifest.json", current_animatic_status="review")
    dump(work / "plan/production-status.json", status)
    shutil.rmtree(work / "plan/animatic/.cache", ignore_errors=True)
    # ROADMAP описывает сборку и статус: представления обновляются после них.
    print(
        run([sys.executable, "-B", REPO / "tools/update_scene_views/update_scene_views.py", "--project", work]).strip()
    )
    for tool, args in [
        ("update_scene_views", ["--check"]),
        ("lint_registry", []),
        ("check_assets", []),
        ("check_workspace", []),
        ("build_animatic", ["--plan-only"]),
        ("shot_status", ["--next"]),
    ]:
        print(
            f"{tool}:",
            run([sys.executable, "-B", REPO / f"tools/{tool}/{tool}.py", "--project", work, *args])
            .strip()
            .splitlines()[-1],
        )
    shutil.rmtree(work / ".git")
    # .gitignore проекта прятал бы пакет M03 от Git комплекса.
    # В образце он хранится как _gitignore; testing.py возвращает имя.
    (work / ".gitignore").rename(work / "_gitignore")
    for stale in work.rglob("__pycache__"):
        shutil.rmtree(stale)
    if SAMPLE.exists():
        shutil.rmtree(SAMPLE)
    shutil.copytree(work, SAMPLE)
    shutil.rmtree(work.parent)
    total = sum(p.stat().st_size for p in SAMPLE.rglob("*") if p.is_file())
    print(f"Образец записан в {SAMPLE}: {total // 1024} КБ, файлов {sum(1 for p in SAMPLE.rglob('*') if p.is_file())}")


if __name__ == "__main__":
    main()
