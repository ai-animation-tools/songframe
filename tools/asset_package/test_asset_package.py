"""Проверяет защиту принятого комплекта от потери и перезаписи; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import tempfile
import unittest
from copy import deepcopy
from unittest.mock import patch

from tools.asset_package.asset_package import descriptor_file, replay, sha, validate_package


class AssetPackageTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="package-test-")
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        # Каждый тест сверяется со своим реестром, не с рабочими сценами проекта.
        root_patch = patch("tools.asset_package.asset_package.ROOT", self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        (self.root / "plan").mkdir()
        self.registry = {
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
        (self.root / "plan/scenes.json").write_text(json.dumps(self.registry))
        self.asset = self.root / "asset"
        self.asset.mkdir()
        files = {}
        for name in ["original.mp4", "video.mp4", "frame.png", "prompt.txt", "speech.wav", "generation-request.json"]:
            (self.asset / name).write_bytes(("Сохранённый файл " + name).encode())
            files[name] = {"path": name, "sha256": sha(self.asset / name)}
        self.package = {
            "schema_version": 1,
            "shot": "M01",
            "generation": {
                "original": files["original.mp4"],
                "prompt": files["prompt.txt"],
                "request": files["generation-request.json"],
                "inputs": [files["frame.png"]],
                "lipsync": True,
                "audio": files["speech.wav"],
            },
            "accepted_edit": {
                "video": files["video.mp4"],
                "fps": 30,
                "frames": 30,
                "duration_seconds": 1,
                "rebuild": {"stages": [{"input": "original.mp4", "filter": "fps=30", "frames": 30}]},
            },
        }
        self.path = self.asset / "manifest.json"
        self.write()

    def write(self):
        self.path.write_text(json.dumps(self.package, ensure_ascii=False))

    def test_derived_receipt_is_required_but_unknown_scene_allows_local_replay(self):
        self.package["kind"] = "derived_video"
        self.package["generation"].update(
            source_shot="M02", source_scene_sha256=None, source_accepted_video_sha256="a" * 64
        )
        self.write()
        # Источник мог исчезнуть: локальный комплект всё равно возвращает принятые байты.
        replay(self.path, self.root / "derived-copy.mp4")
        self.assertEqual(sha(self.root / "derived-copy.mp4"), self.package["accepted_edit"]["video"]["sha256"])
        del self.package["generation"]["source_scene_sha256"]
        self.write()
        with self.assertRaisesRegex(ValueError, "source_scene_sha256"):
            validate_package(self.path)

    def test_repeat_is_integer_cycles_and_partial_tail(self):
        self.package["accepted_edit"]["repeat"] = {"full_cycles": 2, "tail_frames": 6, "cycle_frames": 12}
        self.write()
        validate_package(self.path)
        for value in (
            {"full_cycles": 2, "tail_frames": 7, "cycle_frames": 12},
            {"full_cycles": 1, "tail_frames": 18, "cycle_frames": 12},
            {"count": 2},
            {"full_cycles": True, "tail_frames": 6, "cycle_frames": 12},
        ):
            self.package["accepted_edit"]["repeat"] = value
            self.write()
            with self.assertRaises(ValueError):
                validate_package(self.path)

    def test_detects_lost_or_changed_prompt(self):
        (self.asset / "prompt.txt").write_text("Другой промпт")
        with self.assertRaisesRegex(ValueError, "изменился файл"):
            validate_package(self.path)
        (self.asset / "prompt.txt").unlink()
        with self.assertRaisesRegex(ValueError, "изменился файл"):
            validate_package(self.path)

    def test_package_does_not_require_approval_records(self):
        # Достаточно технического комплекта: отдельные решения пользователя
        # не являются входами проверки или воспроизведения.
        result = validate_package(self.path, "M01")
        self.assertEqual(result["shot"], "M01")
        self.assertNotIn("acceptance", result)

    def test_requires_separate_original_and_edit_even_when_bytes_match(self):
        self.package["accepted_edit"]["video"] = deepcopy(self.package["generation"]["original"])
        self.write()
        with self.assertRaisesRegex(ValueError, "разными файлами"):
            validate_package(self.path)

    def test_requires_request_snapshot(self):
        # Снимок запроса обязателен: без него комплект не воспроизводим по документации.
        del self.package["generation"]["request"]
        self.write()
        with self.assertRaises(ValueError):
            validate_package(self.path, "M01")

    def test_requires_lipsync_audio(self):
        self.package["generation"]["audio"] = None
        self.write()
        with self.assertRaisesRegex(ValueError, "аудио"):
            validate_package(self.path)

    def test_rejects_escaping_package(self):
        self.package["generation"]["prompt"]["path"] = "../prompt.txt"
        self.write()
        with self.assertRaisesRegex(ValueError, "вне папки"):
            validate_package(self.path)

    def test_rejects_wrong_montage_length(self):
        self.package["accepted_edit"]["rebuild"]["stages"][0]["frames"] = 31
        self.write()
        with self.assertRaisesRegex(ValueError, "другую длину"):
            validate_package(self.path)

    def test_replay_preserves_bytes_and_refuses_existing_destination(self):
        target = self.root / "replay.mp4"
        replay(self.path, target)
        self.assertEqual(sha(target), self.package["accepted_edit"]["video"]["sha256"])
        with self.assertRaisesRegex(ValueError, "новый выходной файл"):
            replay(self.path, target)
        self.assertEqual(sha(target), self.package["accepted_edit"]["video"]["sha256"])

    def test_internally_consistent_edit_must_match_registry_window(self):
        edit = self.package["accepted_edit"]
        edit.update(frames=31, duration_seconds=31 / 30)
        edit["rebuild"]["stages"][0]["frames"] = 31
        self.write()
        with self.assertRaisesRegex(ValueError, "монтажным окном"):
            validate_package(self.path, root=self.root)
        target = self.root / "wrong-length.mp4"
        with self.assertRaisesRegex(ValueError, "монтажным окном"):
            replay(self.path, target)
        self.assertFalse(target.exists())

    def test_edit_fps_must_match_registry(self):
        self.package["accepted_edit"].update(fps=15, duration_seconds=2)
        self.write()
        with self.assertRaisesRegex(ValueError, "FPS"):
            validate_package(self.path)

    def test_package_shot_must_exist_in_registry(self):
        self.package["shot"] = "M02"
        self.write()
        with self.assertRaisesRegex(ValueError, "отсутствует в реестре"):
            validate_package(self.path)

    def test_window_length_uses_difference_and_reads_current_registry(self):
        # Перенос окна без смены длины допустим; его изменение обнаруживается
        # при следующем чтении, без копии тайминга внутри ассета.
        self.registry["audio"]["end_seconds"] = "2"
        self.registry["scenes"][0].update(start_frame=30, end_frame_exclusive=60)
        self.registry["scenes"].insert(
            0,
            {
                "id": "M02",
                "sequence": "intro",
                "start_frame": 0,
                "end_frame_exclusive": 30,
                "references": [],
                "state_from": None,
                "state_changes": {},
            },
        )
        path = self.root / "plan/scenes.json"
        path.write_text(json.dumps(self.registry))
        validate_package(self.path)
        self.registry["scenes"][0]["end_frame_exclusive"] = 29
        self.registry["scenes"][1]["start_frame"] = 29
        path.write_text(json.dumps(self.registry))
        with self.assertRaisesRegex(ValueError, "монтажным окном"):
            validate_package(self.path)

    def shared_frame(self):
        folder = self.root / "source/heroes"
        folder.mkdir(parents=True)
        frame = folder / "reference.png"
        (self.asset / "frame.png").replace(frame)
        item = {"root": "source", "path": "heroes/reference.png", "sha256": sha(frame)}
        self.package["generation"]["inputs"] = [item]
        self.write()
        return frame, item

    def test_shared_input_needs_no_local_copy_and_replay_preserves_montage(self):
        # Источник один, но точные байты по-прежнему проверяются перед воспроизведением.
        frame, item = self.shared_frame()
        self.package["generation"]["preparation"] = {"files": [deepcopy(item)]}
        self.write()
        validate_package(self.path, root=self.root)
        self.assertEqual(descriptor_file(self.asset, item, self.root), frame)
        self.assertFalse((self.asset / "frame.png").exists())
        target = self.root / "shared-replay.mp4"
        replay(self.path, target, root=self.root)
        self.assertEqual(sha(target), self.package["accepted_edit"]["video"]["sha256"])

    def test_changed_or_missing_shared_reference_stops_validation(self):
        frame, _ = self.shared_frame()
        frame.write_bytes(b"other reference")
        with self.assertRaisesRegex(ValueError, "изменился файл"):
            validate_package(self.path, root=self.root)
        frame.unlink()
        with self.assertRaisesRegex(ValueError, "изменился файл"):
            validate_package(self.path, root=self.root)

    def test_shared_reference_cannot_escape_source_or_use_unknown_root(self):
        _, item = self.shared_frame()
        for name in ["../asset/frame.png", str(self.asset / "frame.png")]:
            self.package["generation"]["inputs"][0]["path"] = name
            self.write()
            with self.subTest(path=name), self.assertRaisesRegex(ValueError, "вне source"):
                validate_package(self.path, root=self.root)
        outside = self.root / "outside.png"
        outside.write_bytes(b"outside")
        (self.root / "source/link.png").symlink_to(outside)
        self.package["generation"]["inputs"][0]["path"] = "link.png"
        self.write()
        with self.assertRaisesRegex(ValueError, "вне source"):
            validate_package(self.path, root=self.root)
        with self.assertRaisesRegex(ValueError, "Неизвестный корень"):
            descriptor_file(self.asset, {**item, "root": "other"}, self.root)

    def test_original_montage_and_prompt_cannot_be_shared_references(self):
        _, item = self.shared_frame()
        for owner, key in [("generation", "original"), ("generation", "prompt"), ("accepted_edit", "video")]:
            original = self.package[owner][key]
            self.package[owner][key] = {**item, "path": "heroes/other.png"}
            self.write()
            with self.subTest(field=key), self.assertRaisesRegex(ValueError, "только входные изображения"):
                validate_package(self.path, root=self.root)
            self.package[owner][key] = original

    def test_shared_image_does_not_register_a_local_montage_input(self):
        frame, _ = self.shared_frame()
        self.package["generation"]["inputs"][0]["path"] = "frame.png"
        frame.replace(self.root / "source/frame.png")
        (self.asset / "frame.png").write_bytes(b"local unregistered file")
        self.package["accepted_edit"]["rebuild"]["stages"][0]["input"] = "frame.png"
        self.write()
        with self.assertRaisesRegex(ValueError, "Не сохранён вход"):
            validate_package(self.path, root=self.root)

    def test_source_scope_accepts_images_only(self):
        (self.root / "source").mkdir()
        with self.assertRaisesRegex(ValueError, "должен быть изображением"):
            descriptor_file(self.asset, {"root": "source", "path": "track.mp3"}, self.root)


if __name__ == "__main__":
    unittest.main()
