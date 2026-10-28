"""Сводка выбранных комплектов из локальных манифестов; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import tempfile
import unittest
from unittest.mock import patch

from tools.check_assets.check_assets import load_motion
from tools.common import sha


class CheckAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="check-assets-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for target in ("tools.check_assets.check_assets.ROOT", "tools.asset_package.asset_package.ROOT"):
            patcher = patch(target, self.root)
            patcher.start()
            self.addCleanup(patcher.stop)
        (self.root / "plan").mkdir()
        (self.root / "plan/scenes.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "fps": 30,
                    "audio": {"end_seconds": "1"},
                    "references": {},
                    "sequences": [{"id": "intro"}],
                    "scenes": [
                        {
                            "id": "M01",
                            "sequence": "intro",
                            "start_frame": 0,
                            "end_frame_exclusive": 30,
                            "references": [],
                            "state_from": None,
                            "state_changes": {},
                        }
                    ],
                }
            )
        )
        self.asset = self.root / "assets/shots/M01"
        self.asset.mkdir(parents=True)
        files = {}
        for name in ("original.mp4", "video.mp4", "frame.png", "prompt.txt", "generation-request.json"):
            (self.asset / name).write_bytes(("Файл " + name).encode())
            files[name] = {"path": name, "sha256": sha(self.asset / name)}
        self.package = {
            "schema_version": 1,
            "shot": "M01",
            "generation": {
                "original": files["original.mp4"],
                "prompt": files["prompt.txt"],
                "request": files["generation-request.json"],
                "inputs": [files["frame.png"]],
                "lipsync": False,
            },
            "accepted_edit": {
                "video": files["video.mp4"],
                "fps": 30,
                "frames": 30,
                "duration_seconds": 1,
                "rebuild": {"stages": [{"input": "original.mp4", "filter": "fps=30", "frames": 30}]},
            },
        }
        (self.asset / "manifest.json").write_text(json.dumps(self.package))

    def test_motion_comes_from_local_manifests_only(self):
        # Общий индекс assets отсутствует и не нужен: готовность выводится из комплектов.
        self.assertEqual(load_motion(), {"M01": {"path": "assets/shots/M01/video.mp4", "frames": 30, "start_frame": 0}})

    def test_package_outside_registry_or_wrong_window_stops_check(self):
        stray = self.root / "assets/shots/M09"
        stray.mkdir()
        (stray / "manifest.json").write_text(json.dumps(dict(self.package, shot="M09")))
        with self.assertRaisesRegex(ValueError, "отсутствует в реестре"):
            load_motion()
        stray.joinpath("manifest.json").unlink()
        stray.rmdir()
        self.package["accepted_edit"]["frames"] = 29
        (self.asset / "manifest.json").write_text(json.dumps(self.package))
        with self.assertRaises(ValueError):
            load_motion()


if __name__ == "__main__":
    unittest.main()
