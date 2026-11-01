"""Перенос принятой генерации в комплект assets по контракту; @link README.md"""

import sys
from pathlib import Path, PureWindowsPath

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import json
import shutil
import subprocess
from datetime import datetime, timezone
from decimal import Decimal
from fractions import Fraction

from tools.asset_package.asset_package import sha, validate_package
from tools.build_animatic.build_animatic import ENCODE, probe, run
from tools.build_review.build_review import prepare as review_prepare
from tools.check_workspace.check_workspace import package_owners
from tools.common import ROOT, TOOLS_ROOT
from tools.cost_check.cost_check import learn as learn_cost
from tools.scene_registry.scene_registry import (
    SHA256,
    accepted_fingerprints,
    initial_states_for,
    load,
    read_production_status,
    scene_fingerprint,
    write_accepted_fingerprints,
)

FPS = 30
ROLE_LABELS = {"first": "Первый кадр", "last": "Последний кадр", "middle": "Промежуточный кадр"}
AUDIO_POLICY = "Звук генератора сохранён в оригинале; в монтаже используется непрерывная исходная песня."
REBUILD_NOTE = (
    "Принятые байты восстанавливаются копированием video; повтор фильтров сохраняет монтаж, "
    "но не обещает побайтово одинаковое перекодирование."
)
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def descriptor(directory, name):
    path = directory / name
    return {"path": name, "sha256": sha(path), "bytes": path.stat().st_size}


def resolve_package(package=None, work_dir=None, root=ROOT):
    """Папка попытки с request.json и attempt.json; из пакета shot_workflow берётся request_dir."""
    root = Path(root).resolve()
    workflow = None
    if package is not None:
        package = Path(package)
        package = (package if package.is_absolute() else root / package).resolve()
        workflow = json.loads((package / "workflow.json").read_text(encoding="utf-8"))
        work_dir = package / workflow.get("request_dir", "request")
    if work_dir is None:
        raise ValueError("Укажите пакет (--package) или папку попытки (--work-dir).")
    work_dir = Path(work_dir)
    work_dir = (work_dir if work_dir.is_absolute() else root / work_dir).resolve()
    request = json.loads((work_dir / "request.json").read_text(encoding="utf-8"))
    attempt = json.loads((work_dir / "attempt.json").read_text(encoding="utf-8"))
    if attempt.get("status") != "downloaded" or not attempt.get("downloads"):
        raise ValueError("Попытка не в состоянии downloaded: принимать нечего.")
    return package, work_dir, request, attempt, workflow


def frozen_request_files(request, work_dir):
    """Проверяет нужные приёмке файлы до staging: строковый prompt не является текущим контрактом; @link README.md."""
    if not isinstance(request, dict):
        raise ValueError("request.json должен быть объектом.")
    prompt = request.get("prompt")
    if (
        not isinstance(prompt, dict)
        or not isinstance(prompt.get("path"), str)
        or not prompt["path"].strip()
        or not isinstance(prompt.get("sha256"), str)
        or not prompt["sha256"].strip()
    ):
        raise ValueError("request.json: поле prompt должно быть объектом с path и sha256.")
    inputs = request.get("inputs")
    if not isinstance(inputs, list):
        raise ValueError("request.json: поле inputs должно быть списком объектов с path.")

    def local_file(name, field):
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"request.json: поле {field} должно содержать непустой относительный путь.")
        relative = Path(name)
        windows = PureWindowsPath(name)
        if relative.is_absolute() or windows.drive or windows.root or ".." in windows.parts:
            raise ValueError(f"request.json: поле {field} должно задавать путь внутри папки попытки.")
        path = (work_dir / relative).resolve()
        if not path.is_relative_to(work_dir.resolve()):
            raise ValueError(f"request.json: поле {field} должно задавать путь внутри папки попытки.")
        if not path.is_file():
            raise ValueError(f"request.json: файл для {field} не найден: {relative.as_posix()}.")
        return path

    prompt_file = local_file(prompt["path"], "prompt.path")
    input_files = []
    for index, item in enumerate(inputs):
        if not isinstance(item, dict):
            raise ValueError(f"request.json: inputs[{index}] должен быть объектом с path.")
        input_files.append(local_file(item.get("path"), f"inputs[{index}].path"))
    return prompt_file, input_files


def render_edit(original, filter_text, frames, target):
    run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-n",
            "-threads",
            "2",
            "-i",
            str(original),
            "-map",
            "0:v:0",
            "-vf",
            filter_text,
            *ENCODE,
            "-frames:v",
            str(frames),
            str(target),
        ]
    )
    stream = next(s for s in probe(target)["streams"] if s["codec_type"] == "video")
    if (stream["width"], stream["height"], stream["r_frame_rate"], int(stream["nb_frames"])) != (
        1920,
        1080,
        "30/1",
        frames,
    ):
        raise ValueError("Принятый монтаж имеет неверный формат или число кадров.")


def edit_plan(shot, original, frames, root, review=None, cut=None, speed="1", hold_first=0, hold_last=0):
    """Параметры обрезки из рецепта пробы или аргументов; фильтр считает build_review."""
    if review is not None:
        document = json.loads(Path(review).read_text(encoding="utf-8"))
        item = next((s for s in document.get("shots", []) if s.get("id") == shot), None)
        if item is None:
            raise ValueError(f"{shot}: в рецепте пробы нет этого плана.")
        if item.get("kind") != "video" or sha(Path(item["path"])) != sha(original):
            raise ValueError(f"{shot}: проба собрана не из этого оригинала.")
        cut = (item["source_start_frame"], item["source_end_frame_exclusive"])
        speed, hold_first, hold_last = (
            item.get("speed", "1"),
            item.get("hold_first_frames", 0),
            item.get("hold_last_frames", 0),
        )
    if cut is None:
        raise ValueError("Укажите участок: --review или --cut НАЧАЛО:КОНЕЦ на сетке 30 кадров/с.")
    spec = {
        "schema_version": 1,
        "shots": [
            {
                "scene": shot,
                "path": str(original),
                "kind": "video",
                "source_start_frame": int(cut[0]),
                "source_end_frame_exclusive": int(cut[1]),
                "speed": str(speed),
                "hold_first_frames": int(hold_first),
                "hold_last_frames": int(hold_last),
            }
        ],
    }
    plan = review_prepare(spec, root)["shots"][0]
    if plan["frames"] != frames:
        raise ValueError(f"Участок с удержаниями даёт {plan['frames']} кадров, а окно плана — {frames}.")
    return plan


def accept(
    shot,
    package=None,
    work_dir=None,
    review=None,
    cut=None,
    speed="1",
    hold_first=0,
    hold_last=0,
    full=False,
    audio=None,
    audio_recipe=None,
    preparation=(),
    root=ROOT,
    clean=False,
    update_views=True,
    pricing=None,
    replace=False,
):
    root = Path(root).resolve()
    registry = load(root)
    scene = next((s for s in registry["scenes"] if s["id"] == shot), None)
    if scene is None:
        raise ValueError(f"{shot}: план отсутствует в реестре сцен.")
    frames = scene["end_frame_exclusive"] - scene["start_frame"]
    package, work_dir, request, attempt, workflow = resolve_package(package, work_dir, root)
    prompt_file, input_files = frozen_request_files(request, work_dir)
    if not isinstance(request.get("provider"), str) or not request["provider"].strip():
        raise ValueError("В сохранённом запросе не указан провайдер.")
    if request.get("shot") not in (None, shot) or request.get("kind") != "video":
        raise ValueError("Пакет относится к другому плану или не является видеозапросом.")
    target = root / "assets/shots" / shot
    if target.exists() and not replace:
        raise ValueError(
            f"{shot}: комплект уже есть в assets; замена выбранной версии — отдельное решение (--replace)."
        )
    original = work_dir / attempt["downloads"][0]["path"]
    if not original.is_file():
        raise ValueError("Скачанный оригинал не найден в попытке.")
    if scene.get("lipsync") and audio is None:
        raise ValueError(f"{shot}: речевой план требует --audio с точным WAV липсинка.")
    scene_digest, current_digest = acceptance_fingerprint(registry, shot, workflow, root)
    # Повреждённый статус производства обнаруживается до переноса: комплект без записи отпечатка был бы устаревшим.
    accepted_fingerprints(read_production_status(root))
    staging = target.parent / f".accept-{shot}"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        shutil.copyfile(original, staging / "original.mp4")
        media = next(s for s in probe(staging / "original.mp4")["streams"] if s["codec_type"] == "video")
        original_media = {
            k: media[k] for k in ("width", "height", "r_frame_rate", "duration", "nb_frames") if k in media
        }
        # Одинаковые байты входов хранятся одним файлом с несколькими ролями по контракту assets.
        inputs, names = [], {}
        for item, source in zip(request["inputs"], input_files):
            digest = sha(source)
            if digest not in names:
                names[digest] = f"generation-input-{len(names) + 1}{source.suffix.lower()}"
                shutil.copyfile(source, staging / names[digest])
            entry = descriptor(staging, names[digest])
            entry.update(
                slot=item.get("slot") or item.get("flag"),
                role=ROLE_LABELS.get(item.get("role"), item.get("role") or "Вход генерации"),
            )
            inputs.append(entry)
        shutil.copyfile(prompt_file, staging / "generation-prompt.txt")
        audio_entry = None
        if audio is not None:
            shutil.copyfile(Path(audio), staging / "speech.wav")
            audio_entry = descriptor(staging, "speech.wav")
            if audio_recipe is not None:
                shutil.copyfile(Path(audio_recipe), staging / "audio-recipe.json")
        references = []
        for extra in preparation:
            extra = Path(extra).resolve()
            if not extra.is_file():
                raise ValueError(f"Файл подготовки не найден: {extra}")
            relation = "frame_preparation_image" if extra.suffix.lower() in IMAGE_SUFFIXES else "frame_preparation"
            # Общие изображения остаются в source; комплект хранит ссылку и точный хеш.
            # Уникальные кадры и промпты копируются по контракту @link assets/README.md.
            source_root = (root / "source").resolve()
            if extra.is_relative_to(source_root):
                if extra.suffix.lower() not in IMAGE_SUFFIXES:
                    raise ValueError("Из source разрешены только изображения подготовки.")
                entry = descriptor(source_root, str(extra.relative_to(source_root))) | {"root": "source"}
            else:
                folder = "references" if relation == "frame_preparation_image" else "prompts"
                name = f"preparation/{folder}/{sha(extra)[:10]}-{extra.name}"
                (staging / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(extra, staging / name)
                entry = descriptor(staging, name)
            references.append(entry | {"relation": relation})
        if full:
            if original_media.get("r_frame_rate") != "30/1" or int(original_media.get("nb_frames", 0)) != frames:
                raise ValueError("Полный оригинал не совпадает с окном и FPS; задайте участок.")
            shutil.copyfile(staging / "original.mp4", staging / "video.mp4")
            plan = {
                "filter": f"fps={FPS},trim=start_frame=0:end_frame={frames},setpts=N/({FPS}*TB),setsar=1",
                "frames": frames,
                "source_start_frame": 0,
                "source_end_frame_exclusive": frames,
                "source_interval_seconds": [0.0, frames / FPS],
                "speed": "1",
                "motion_frames": frames,
                "hold_first_frames": 0,
                "hold_last_frames": 0,
                "duration_change_seconds": 0.0,
            }
        else:
            plan = edit_plan(shot, staging / "original.mp4", frames, root, review, cut, speed, hold_first, hold_last)
            render_edit(staging / "original.mp4", plan["filter"], frames, staging / "video.mp4")
        speed_value = Decimal(str(plan["speed"]))
        selected = Decimal(plan["source_end_frame_exclusive"] - plan["source_start_frame"]) / FPS
        video = descriptor(staging, "video.mp4")
        original_desc = descriptor(staging, "original.mp4")
        prompt_desc = descriptor(staging, "generation-prompt.txt")
        snapshot = {
            "schema_version": 1,
            "shot": shot,
            # Снимок сохраняет исполнителя исходного запроса, чтобы повтор сравнивал его с выбором проекта.
            "provider": request["provider"],
            "command": request["command"],
            "model": request["model"],
            "parameters": request.get("parameters", {}),
            "outputs": request.get("outputs", 1),
            "request_sha256": attempt.get("request_sha256"),
            "inputs": [
                {"slot": i["slot"], "role": i["role"], "path": i["path"], "sha256": i["sha256"]} for i in inputs
            ],
            "prompt": "generation-prompt.txt",
            "prompt_sha256": prompt_desc["sha256"],
            "generation_id": attempt.get("generation_id"),
            "service_status": attempt.get("service_status"),
            "path_base": "asset_directory",
        }
        if attempt.get("manual_result"):
            snapshot["provenance"] = (
                "Исход отправки остался неизвестен; оригинал загружен пользователем из истории генераций сервиса, "
                "ID задания неизвестен."
            )
        (staging / "generation-request.json").write_text(
            json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        prep = {
            "schema_version": 1,
            "shot": shot,
            "path_base": "asset_directory",
            "generation_inputs": [
                {
                    "path": i["path"],
                    "sha256": i["sha256"],
                    "bytes": i["bytes"],
                    "slot": i["slot"],
                    "role": "Переданный кадр генерации",
                }
                for i in inputs
            ],
            "frame_prompts": [r for r in references if r["relation"] == "frame_preparation"],
            "references": [r for r in references if r["relation"] == "frame_preparation_image"],
            "notes": [f"Режим согласования: {workflow.get('mode')}"] if workflow and workflow.get("mode") else [],
            "reproduction_note": (
                "Точные байты кадров сохранены. Повтор генерации по промпту не гарантирует тех же пикселей."
            ),
        }
        (staging / "preparation.json").write_text(
            json.dumps(prep, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        unique_inputs = {i["path"]: {k: i[k] for k in ("path", "sha256", "bytes")} for i in inputs}
        manifest = {
            "schema_version": 1,
            "shot": shot,
            "kind": "generated_video",
            "generation": {
                "source_shot": shot,
                "original": original_desc,
                "original_media": original_media,
                "prompt": prompt_desc,
                "request": descriptor(staging, "generation-request.json"),
                "generation_id": attempt.get("generation_id"),
                "inputs": inputs,
                "lipsync": bool(scene.get("lipsync")),
                "audio": audio_entry,
                "auxiliary_references": [],
                "preparation": {
                    "index": descriptor(staging, "preparation.json"),
                    "files": [
                        *unique_inputs.values(),
                        *[{k: r[k] for k in ("path", "sha256", "bytes", "root") if k in r} for r in references],
                        prompt_desc,
                        original_desc,
                    ],
                },
            },
            "accepted_edit": {
                "video": video,
                "fps": FPS,
                "frames": frames,
                "duration_seconds": frames / FPS,
                "source_interval_seconds": plan["source_interval_seconds"],
                "source_interval_end_exclusive": True,
                "source_frame_grid_fps": FPS,
                "still_source_time_seconds": None,
                "speed": {
                    "factor": float(speed_value),
                    "ratio": str(Fraction(speed_value)),
                    "selected_source_seconds": float(selected),
                    "motion_output_seconds": plan["motion_frames"] / FPS,
                    "duration_change_seconds": plan["duration_change_seconds"],
                },
                "hold_first_seconds": plan["hold_first_frames"] / FPS,
                "hold_last_seconds": plan["hold_last_frames"] / FPS,
                "audio_policy": AUDIO_POLICY,
                "montage_source": video,
                "rebuild": {
                    "stages": [{"input": "original.mp4", "filter": plan["filter"], "frames": frames}],
                    "source": original_desc,
                    "ffmpeg_version": run(["ffmpeg", "-version"]).decode().splitlines()[0],
                    "note": REBUILD_NOTE,
                },
                "source_frame_interval_exclusive": [plan["source_start_frame"], plan["source_end_frame_exclusive"]],
                "source_fps": original_media.get("r_frame_rate"),
                "fps_conversion": "Выбор кадров без интерполяции движения."
                if original_media.get("r_frame_rate") != "30/1"
                else "Исходная частота кадров совпадает со шкалой.",
            },
        }
        (staging / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        replaced = retire_kit(root, shot) if target.exists() else None
        staging.rename(target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    # Сразу после переноса: комплект без отпечатка считается принятым по прежней постановке (stale).
    write_accepted_fingerprints(root, {shot: scene_digest}, clear_source_reviews=True)
    validate_package(target / "manifest.json", shot, root)
    result = {
        "shot": shot,
        "target": str(target.relative_to(root)),
        "frames": frames,
        "video_sha256": video["sha256"],
        "scene_sha256": scene_digest,
        "replaced": str(replaced.relative_to(root)) if replaced else None,
        "observed_credits": None,
        "cleaned": [],
        "warnings": [],
    }
    if scene_digest != current_digest:
        result["warnings"].append(
            f"{shot}: постановка плана изменилась после подготовки пакета; комплект принят по прежней постановке "
            "и требует нового производства."
        )
    if attempt.get("credits_consumed") is not None:
        # Комплект уже перенесён: сбой записи наблюдения цены не отменяет приёмку и не мешает обновлению
        # представлений и очистке, а возвращается предупреждением.
        try:
            result["observed_credits"] = learn_cost(work_dir, pricing)["credits"]
        except (ValueError, OSError, KeyError, TypeError) as error:
            reason = str(error) if isinstance(error, (ValueError, OSError)) else type(error).__name__
            result["warnings"].append("Наблюдение расхода не записано: " + reason)
    if update_views and root == ROOT.resolve():
        subprocess.run(
            [
                sys.executable,
                "-B",
                str(TOOLS_ROOT / "tools/update_scene_views/update_scene_views.py"),
                "--project",
                str(root),
            ],
            check=True,
            cwd=TOOLS_ROOT,
        )
    if clean:
        result["cleaned"] = clean_work(root, shot, package, work_dir, review)
    return result


def acceptance_fingerprint(registry, shot, workflow, root):
    """Отпечаток постановки, по которой сделан комплект, и текущий отпечаток плана.

    Пакет shot_workflow запоминает scene_sha256 при подготовке; без пакета или поля берётся текущая постановка.
    """
    current = scene_fingerprint(registry, shot, initial_states_for(root))
    saved = workflow.get("scene_sha256") if isinstance(workflow, dict) else None
    if saved is None:
        return current, current
    if not isinstance(saved, str) or not SHA256.fullmatch(saved):
        raise ValueError(f"{shot}: scene_sha256 в workflow.json пакета должен состоять из 64 hex-символов.")
    return saved, current


def retire_kit(root, shot):
    """Прежний комплект целиком переезжает в assets/replaced/Mxx/<время>: оплаченные оригиналы и манифест не удаляются.

    Папка вне assets/shots не участвует в индексе, проверках и сборке; @link ../../templates/project/assets/README.md.
    """
    current = root / "assets/shots" / shot
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive = root / "assets/replaced" / shot / stamp
    if archive.exists():
        raise ValueError(f"{shot}: папка {archive.relative_to(root)} уже существует.")
    archive.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(current), str(archive))
    return archive


def clean_work(root, shot, package=None, work_dir=None, review=None):
    """После проверки комплекта удаляет переданный пакет, файлы пробы, все пакеты плана в plan/batches
    и опустевшие папки проб; assets, очередь других планов и чужие пакеты не трогает."""
    root = Path(root).resolve()
    from tools.montage_files import retained_montage_folders

    retained = retained_montage_folders(root)
    batches, awaiting = (root / "plan/batches").resolve(), (root / "plan/awaiting").resolve()
    removed = []

    def remove_dir(folder):
        folder = Path(folder).resolve()
        if any(folder == item or folder.is_relative_to(item) or item.is_relative_to(folder) for item in retained):
            return False
        if (
            folder.exists()
            and folder not in (batches, awaiting)
            and (folder.is_relative_to(batches) or folder.is_relative_to(awaiting))
        ):
            shutil.rmtree(folder)
            removed.append(str(folder.relative_to(root)))
            return True
        return False

    for folder in (package, work_dir):
        if folder is not None and remove_dir(folder):
            break
    if review is not None:
        for extra in (Path(review), Path(review).with_suffix(".mp4")):
            if (
                extra.exists()
                and extra.resolve().is_relative_to(batches)
                and not any(extra.resolve().is_relative_to(item) for item in retained)
            ):
                extra.unlink()
                removed.append(str(extra.resolve().relative_to(root)))
    # Остальные пакеты и пробы, все планы которых уже приняты: проба с незавершённым соседом остаётся.
    accepted = {p.parent.name for p in (root / "assets/shots").glob("M*/manifest.json")} | {shot}
    for folder in sorted(batches.iterdir()) if batches.is_dir() else []:
        if folder.is_dir():
            owners = package_owners(folder)
            if owners and owners <= accepted and (shot in owners or folder.name.startswith(shot + "-")):
                remove_dir(folder)
    # Пустые папки проб: файлы уже удалены, папка не нужна.
    for folder in sorted(batches.iterdir()) if batches.is_dir() else []:
        if folder.is_dir() and not any(folder.iterdir()):
            folder.rmdir()
            removed.append(str(folder.relative_to(root)))
    return removed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shot")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--package", help="Папка пакета shot_workflow с workflow.json")
    source.add_argument("--work-dir", help="Папка попытки media_request с request.json и attempt.json")
    edit = parser.add_mutually_exclusive_group(required=True)
    edit.add_argument("--review", help="JSON рецепта пробы build_review с этим планом")
    edit.add_argument(
        "--cut", metavar="НАЧАЛО:КОНЕЦ", help="Участок оригинала на сетке 30 кадров/с, конец исключительно"
    )
    edit.add_argument("--full", action="store_true", help="Оригинал уже совпадает с окном и FPS: побайтовая копия")
    parser.add_argument("--speed", default="1")
    parser.add_argument("--hold-first", type=int, default=0)
    parser.add_argument("--hold-last", type=int, default=0)
    parser.add_argument("--audio", help="speech.wav для речевого плана")
    parser.add_argument("--audio-recipe", help="audio-recipe.json к WAV")
    parser.add_argument(
        "--preparation",
        nargs="*",
        default=[],
        help="Дополнительные файлы подготовки: промпты кадров, промежуточные изображения",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help=(
            "После проверки удалить все пакеты плана в plan/batches, переданный пакет очереди, "
            "пробу и пустые папки проб"
        ),
    )
    parser.add_argument("--no-views", action="store_true", help="Не обновлять представления")
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Заменить уже принятый комплект: прежний переезжает в assets/replaced/Mxx/<время>",
    )
    args = parser.parse_args()
    try:
        cut = tuple(int(x) for x in args.cut.split(":")) if args.cut else None
        if cut is not None and len(cut) != 2:
            raise ValueError("Участок задаётся как НАЧАЛО:КОНЕЦ.")
        result = accept(
            args.shot,
            args.package,
            args.work_dir,
            args.review,
            cut,
            args.speed,
            args.hold_first,
            args.hold_last,
            args.full,
            args.audio,
            args.audio_recipe,
            args.preparation,
            clean=args.clean,
            update_views=not args.no_views,
            replace=args.replace,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, KeyError, TypeError, StopIteration) as error:
        parser.exit(
            1,
            (
                str(error)
                if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError)
                else "Ошибка файлов попытки или медиа; сырой вывод скрыт."
            )
            + "\n",
        )


if __name__ == "__main__":
    main()
