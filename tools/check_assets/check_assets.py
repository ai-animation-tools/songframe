"""Проверяет комплекты выбранных сцен; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


from tools.asset_package.asset_package import validate_package
from tools.common import ROOT
from tools.scene_registry.scene_registry import load


def load_motion():
    # Готовность выводится из локального комплекта. Общий индекс — производное
    # представление и не может подменять рецепт или монтажное время сцены.
    data = load(ROOT)
    scenes = {s["id"]: s for s in data["scenes"]}
    result = {}
    for path in sorted((ROOT / "assets/shots").glob("M*/manifest.json")):
        sid = path.parent.name
        if sid not in scenes:
            raise ValueError(f"{sid}: ассет отсутствует в реестре сцен.")
        package = validate_package(path, sid)
        edit = package["accepted_edit"]
        result[sid] = {
            "path": str((path.parent / edit["video"]["path"]).relative_to(ROOT)),
            "frames": edit["frames"],
            "start_frame": 0,
        }
    return result


if __name__ == "__main__":
    motion = load_motion()
    print(f"Проверены все файлы {len(motion)} выбранных сцен; хеши и монтажные длительности совпадают.")
