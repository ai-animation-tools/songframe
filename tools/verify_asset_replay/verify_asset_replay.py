"""Проверяет воспроизведение принятых комплектов; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import json
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed

from tools.asset_package.asset_package import replay, sha, validate_package
from tools.common import ROOT


def run(arguments):
    result = subprocess.run(arguments, capture_output=True)
    if result.returncode:
        raise ValueError("Ошибка технической проверки воспроизведения.")
    return result.stdout


def sample(path, frames):
    selection = "+".join(f"eq(n\\,{index})" for index in sorted({0, frames // 2, frames - 1}))
    return run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-threads",
            "2",
            "-i",
            str(path),
            "-vf",
            f"select={selection},scale=320:180",
            "-fps_mode",
            "vfr",
            "-pix_fmt",
            "yuv420p",
            "-f",
            "rawvideo",
            "-",
        ]
    )


def verify(sid, temporary):
    path = ROOT / "assets/shots" / sid / "manifest.json"
    package = validate_package(path, sid)
    edit = package["accepted_edit"]
    copied, rendered = temporary / f"{sid}-copy.mp4", temporary / f"{sid}-rebuilt.mp4"
    replay(path, copied)
    assert sha(copied) == edit["video"]["sha256"]
    replay(path, rendered, from_original=True)
    meta = json.loads(
        run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,nb_frames,r_frame_rate,duration",
                "-of",
                "json",
                str(rendered),
            ]
        )
    )["streams"][0]
    assert (int(meta["nb_frames"]), meta["r_frame_rate"], meta["width"], meta["height"]) == (
        edit["frames"],
        "30/1",
        1920,
        1080,
    ), (sid, meta)
    original = path.parent / edit["video"]["path"]
    a, b = sample(original, edit["frames"]), sample(rendered, edit["frames"])
    assert len(a) == len(b) and len(a) > 0, sid
    rms = (sum((x - y) ** 2 for x, y in zip(a, b)) / len(a)) ** 0.5
    # Здесь проверяется сохранение кадровых границ и преобразований, а не новая
    # художественная приёмка. Небольшая разница повторного H.264 ожидаема.
    assert rms < 12, (sid, rms)
    return {
        "shot": sid,
        "accepted_copy_sha256_matches": True,
        "rebuild_frames": edit["frames"],
        "resolution": [1920, 1080],
        "fps": 30,
        "sampled_frame_indices": sorted({0, edit["frames"] // 2, edit["frames"] - 1}),
        "sampled_yuv_rms": rms,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--preserved", type=Path)
    args = parser.parse_args()
    if args.report.resolve().is_relative_to(ROOT):
        raise ValueError("Отчёт проверки нужно сохранить вне папки проекта.")
    registry = json.loads((ROOT / "assets/shots/manifest.json").read_text())
    results = []
    failures = []
    with tempfile.TemporaryDirectory(prefix="accepted-replay-") as temporary:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = {pool.submit(verify, sid, Path(temporary)): sid for sid in registry["shots"]}
            for future in as_completed(futures):
                try:
                    result = future.result()
                    results.append(result)
                    print(result["shot"], "воспроизведён", f"RMS={result['sampled_yuv_rms']:.3f}", flush=True)
                except (AssertionError, ValueError) as error:
                    failures.append({"shot": futures[future], "error": str(error)})
                    print(futures[future], "проверка не пройдена", flush=True)
    media_preserved = None
    if args.preserved:
        snapshot = json.loads(args.preserved.read_text())
        assert all(sha(ROOT / name) == digest for name, digest in snapshot["media"].items())
        media_preserved = len(snapshot["media"])
    report = {
        "status": "failed" if failures else "passed",
        "failures": failures,
        "shots": sorted(results, key=lambda x: float(x["shot"][1:])),
        "preserved_media_checked": media_preserved,
        "animatic_rebuilt": False,
        "note": "Проверены все хеши, точное копирование, повтор фильтров, размер и длина; "
        "визуальное сравнение ограничено тремя кадрами каждого плана.",
    }
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    assert not failures, failures
    print("Проверка всех принятых комплектов завершена.", flush=True)
