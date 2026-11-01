"""Реальные кадры FFmpeg, неизменяемая проба и транзакционная приёмка; @link README.md."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import shutil
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import tools.testing.sample_project  # noqa: F401
from tools.asset_package.asset_package import descriptor_file, descriptors, replay, validate_package
from tools.build_review.build_review import probe, run
from tools.derive_shot import derive_shot as tool
from tools.export_edit_bundle.export_edit_bundle import collect, export
from tools.scene_registry.scene_registry import project_shot_acceptance


class DerivedShotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media_temp = tempfile.TemporaryDirectory(prefix="derived-frames-")
        cls.addClassCleanup(cls.media_temp.cleanup)
        cls.video = Path(cls.media_temp.name) / "accepted.mp4"
        # Каждый из первых 12 кадров имеет свою яркость. Проверка пикселей
        # обнаруживает неверный источник, off-by-one, хвост и скрытые удержания.
        run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "nullsrc=s=1920x1080:r=30:d=4,geq=lum='16+mod(N,12)*18':cb=128:cr=128",
                "-an",
                "-c:v",
                "libx264",
                "-threads",
                "2",
                "-crf",
                "18",
                str(cls.video),
            ]
        )
        cls.source_pixels = cls.pixels(cls.video)

    @staticmethod
    def pixels(path):
        return list(
            run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-i",
                    str(path),
                    "-map",
                    "0:v:0",
                    "-vf",
                    "scale=1:1",
                    "-pix_fmt",
                    "gray",
                    "-f",
                    "rawvideo",
                    "-",
                ]
            )
        )

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="derive-shot-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "project"
        shutil.copytree(Path(__file__).resolve().parents[1] / "testdata/sample-project", self.root)
        registry_path = self.root / "plan/scenes.json"
        registry = tool.read_json(registry_path)
        registry["scenes"][-1]["end_frame_exclusive"] = 612
        registry["audio"]["end_seconds"] = "20.4"
        registry_path.write_bytes(tool.json_bytes(registry))
        self.source = self.root / "assets/shots/M02"
        manifest_path = self.source / "manifest.json"
        package = tool.read_json(manifest_path)
        name = "revisions/current/video.mp4"
        destination = self.source / name
        destination.parent.mkdir(parents=True)
        shutil.copyfile(self.video, destination)
        for entry in descriptors(package["accepted_edit"]):
            if entry["path"] == "video.mp4":
                entry.update(tool.descriptor(self.source, name))
        manifest_path.write_bytes(tool.json_bytes(package))
        self.assertEqual(project_shot_acceptance(self.root)["M02"], "completed")

    def build(self, recipe, frames=None):
        if frames is not None:
            path = self.root / "plan/scenes.json"
            registry = tool.read_json(path)
            registry["scenes"][-1]["end_frame_exclusive"] = 600 + frames
            registry["audio"]["end_seconds"] = str((600 + frames) / 30)
            path.write_bytes(tool.json_bytes(registry))
        identifier = uuid4().hex
        recipe_name = f"plan/derived/M05/recipes/{identifier}.json"
        recipe_path = self.root / recipe_name
        recipe_path.parent.mkdir(parents=True, exist_ok=True)
        recipe_path.write_bytes(tool.json_bytes(recipe))
        work_dir = f"plan/derived/M05/{identifier}"
        return tool.build("M05", recipe_name, work_dir, self.root)

    def accept(self, result, **options):
        return tool.accept(result["work_dir"], result["result_token"], root=self.root, **options)

    def assert_pixels(self, result, indices):
        output = self.root / result["work_dir"] / "candidate.mp4"
        values = self.pixels(output)
        self.assertEqual(len(values), len(indices))
        for actual, index in zip(values, indices):
            self.assertLessEqual(abs(actual - self.source_pixels[index]), 2)
        streams = probe(output)["streams"]
        self.assertFalse(any(stream["codec_type"] == "audio" for stream in streams))
        stream = next(stream for stream in streams if stream["codec_type"] == "video")
        self.assertEqual((stream["r_frame_rate"], int(stream["nb_frames"])), ("30/1", len(indices)))

    def selected(self):
        return {
            path.relative_to(self.root).as_posix(): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file() and "derived-history" not in path.parts and "replaced" not in path.parts
        }

    def test_all_modes_use_current_accepted_source_and_exact_frame_order(self):
        cases = [
            ({"mode": "trim", "start_frame": 3}, list(range(3, 15)), 12),
            ({"mode": "fit", "start_frame": 2, "end_frame_exclusive": 8}, [2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7], 12),
            ({"mode": "fit", "start_frame": 2, "end_frame_exclusive": 8}, [3, 5, 7], 3),
            ({"mode": "still", "frame": 7}, [7] * 12, 12),
            ({"mode": "repeat", "start_frame": 3, "end_frame_exclusive": 8}, [3, 4, 5, 6, 7, 3, 4, 5, 6, 7, 3, 4], 12),
        ]
        for recipe, indices, frames in cases:
            with self.subTest(recipe=recipe):
                result = self.build(recipe, frames)
                self.assert_pixels(result, indices)
                preview = self.root / result["work_dir"] / "preview.mp4"
                self.assertEqual(self.pixels(preview), self.pixels(preview.with_name("candidate.mp4")))
                self.assertTrue(any(stream["codec_type"] == "audio" for stream in probe(preview)["streams"]))

    def test_accept_keeps_generation_and_exact_edit_source_and_replays(self):
        # Достижимый JSON ведёт к дополнительному файлу, которого нет в generation.files.
        nested = self.source / "nested.json"
        (self.source / "necessary.txt").write_text("Нужный вход подготовки", encoding="utf-8")
        nested.write_bytes(tool.json_bytes({"input": tool.descriptor(self.source, "necessary.txt")}))
        path = self.source / "manifest.json"
        package = tool.read_json(path)
        package["generation"]["preparation"]["files"].append(tool.descriptor(self.source, "nested.json"))
        # Общий референс остаётся ссылкой, а не новой копией в assets.
        image = self.source / package["generation"]["inputs"][0]["path"]
        shared = self.root / "source/heroes/shared.png"
        shutil.copyfile(image, shared)
        package["generation"]["inputs"].append(
            {"root": "source", "path": "heroes/shared.png", "sha256": tool.sha(shared)}
        )
        path.write_bytes(tool.json_bytes(package))
        result = self.build({"mode": "repeat", "start_frame": 3, "end_frame_exclusive": 8})
        before_work = {p.name: p.read_bytes() for p in (self.root / result["work_dir"]).iterdir()}
        with patch.object(tool, "render_edit", side_effect=AssertionError("Приёмка не рендерит")):
            accepted = self.accept(result)
        target = self.root / "assets/shots/M05"
        manifest = validate_package(target / "manifest.json", "M05", self.root)
        self.assertEqual(manifest["kind"], "derived_video")
        self.assertEqual(manifest["generation"]["original_media"], package["generation"]["original_media"])
        self.assertEqual((target / "original.mp4").read_bytes(), (self.source / "original.mp4").read_bytes())
        accepted_video = target / manifest["accepted_edit"]["video"]["path"]
        used_source = target / manifest["accepted_edit"]["rebuild"]["source"]["path"]
        self.assertEqual(used_source.read_bytes(), self.video.read_bytes())
        self.assertEqual(accepted_video.read_bytes(), before_work["candidate.mp4"])
        self.assertEqual((target / "necessary.txt").read_bytes(), (self.source / "necessary.txt").read_bytes())
        self.assertEqual((target / "nested.json").read_bytes(), nested.read_bytes())
        self.assertFalse((target / "revisions").exists())
        self.assertFalse((target / "heroes/shared.png").exists())
        self.assertEqual(manifest["accepted_edit"]["repeat"], {"full_cycles": 2, "tail_frames": 2, "cycle_frames": 5})
        self.assertEqual(manifest["generation"]["source_scene_sha256"], result["source_scene_sha256"])
        self.assertEqual(manifest["generation"]["source_accepted_video_sha256"], result["source_accepted_video_sha256"])
        self.assertEqual(project_shot_acceptance(self.root)["M05"], "completed")
        rebuilt = Path(self.temp.name) / "replayed.mp4"
        replay(target / "manifest.json", rebuilt, True, self.root)
        for actual, expected in zip(self.pixels(rebuilt), self.pixels(accepted_video)):
            self.assertLessEqual(abs(actual - expected), 2)
        self.assertEqual({p.name: p.read_bytes() for p in (self.root / result["work_dir"]).iterdir()}, before_work)
        again = self.accept(result)
        self.assertTrue(again["idempotent"])
        self.assertEqual(again["history"], accepted["history"])
        row = next(row for row in collect(self.root)["shots"] if row["shot"] == "M05")
        self.assertEqual((row["repeat_full_cycles"], row["repeat_tail_frames"], row["repeat_cycle_frames"]), (2, 2, 5))
        output = Path(self.temp.name) / "export"
        export(output, self.root, copy=True)
        edl = (output / "timeline.edl").read_text()
        self.assertIn("* REPEAT M05: полных циклов 2, хвост 2 кадров, цикл 5 кадров", edl)
        events = [line for line in edl.splitlines() if "M05" in line and " V " in line]
        self.assertEqual(len(events), 3)
        self.assertIn("00:00:20:10 00:00:20:12", events[-1])

    def test_replacement_archives_whole_old_kit_and_requires_flag(self):
        first = self.build({"mode": "still", "frame": 3})
        self.accept(first, update_views=False)
        target = self.root / "assets/shots/M05"
        (target / "user-note.txt").write_text("Сохранить", encoding="utf-8")
        before = tool.tree_files(target)
        status_path = self.root / "plan/production-status.json"
        status = tool.read_json(status_path)
        status["shots"]["M05"]["source_review"] = {}
        status["shots"]["M02"]["source_review"] = {}
        status_path.write_bytes(tool.json_bytes(status))
        second = self.build({"mode": "still", "frame": 7})
        with self.assertRaisesRegex(ValueError, "--replace"):
            self.accept(second, update_views=False)
        self.accept(second, replace=True, update_views=False)
        saved = tool.read_json(status_path)
        self.assertNotIn("source_review", saved["shots"]["M05"])
        self.assertEqual(saved["shots"]["M02"]["source_review"], {})
        archives = list((self.root / "assets/replaced/M05").iterdir())
        self.assertEqual(len(archives), 1)
        self.assertEqual(tool.tree_files(archives[0]), before)
        self.assertNotEqual(tool.tree_files(target), before)

    def test_publish_failure_rolls_back_views_status_and_kit_and_retry_uses_candidate(self):
        first = self.build({"mode": "still", "frame": 3})
        self.accept(first)
        registry_path = self.root / "plan/scenes.json"
        registry = tool.read_json(registry_path)
        registry["scenes"][-1]["action"] += " Новый принятый вариант"
        registry_path.write_bytes(tool.json_bytes(registry))
        result = self.build({"mode": "repeat", "start_frame": 3, "end_frame_exclusive": 8})
        before = self.selected()
        original = tool.publish_file
        count = 0

        def fail(source, target):
            nonlocal count
            count += 1
            original(source, target)
            if count == 2:
                raise OSError("Проверяем откат после частичной публикации")

        with patch.object(tool, "publish_file", side_effect=fail):
            with self.assertRaises(OSError):
                self.accept(result, replace=True)
        self.assertEqual(self.selected(), before)
        rolled_back = [
            tool.read_json(p)
            for p in (self.root / tool.HISTORY).glob("*/journal.json")
            if tool.read_json(p)["state"] == "rolled_back"
        ]
        self.assertEqual(len(rolled_back), 1)
        self.assertIn("plan/production-status.json", [entry["path"] for entry in rolled_back[0]["files"]])
        with patch.object(tool, "render_edit", side_effect=AssertionError("Повтор не рендерит")):
            self.accept(result, replace=True)
        target = self.root / "assets/shots/M05"
        current = tool.read_json(target / "manifest.json")
        self.assertEqual(tool.sha(target / current["accepted_edit"]["video"]["path"]), result["video"]["sha256"])

    def test_recover_after_directory_rename_and_detect_manual_edit(self):
        result = self.build({"mode": "still", "frame": 7})
        before = self.selected()
        original = tool.publish_directory

        def crash(source, target, retired):
            original(source, target, retired)
            raise OSError("Обрыв после rename")

        # Оставляем journal publishing, как после SIGKILL; следующий recover
        # должен вернуть точные старые байты даже без живого процесса приёмки.
        with (
            patch.object(tool, "publish_directory", side_effect=crash),
            patch.object(tool, "restore", side_effect=OSError("Авария")),
        ):
            with self.assertRaises(OSError):
                self.accept(result)
        target_directory = self.root / "assets/shots/M05"
        current = tool.read_json(target_directory / "manifest.json")
        target = target_directory / current["accepted_edit"]["video"]["path"]
        candidate = target.read_bytes()
        target.write_bytes("ручная правка".encode())
        with self.assertRaisesRegex(ValueError, "изменён комплект"):
            tool.recover(self.root)
        target.write_bytes(candidate)
        recovered = tool.recover(self.root)
        self.assertEqual(len(recovered["transactions"]), 1)
        self.assertEqual(self.selected(), before)
        self.assertEqual(tool.recover(self.root)["transactions"], [])
        self.accept(result)

    def test_source_recipe_result_and_target_changes_block_accept_without_writes(self):
        for mutation in ("recipe", "candidate", "source", "target"):
            with self.subTest(mutation=mutation):
                result = self.build({"mode": "still", "frame": 7})
                folder = self.root / result["work_dir"]
                if mutation == "recipe":
                    path = self.root / tool.read_json(folder / "build.json")["recipe_path"]
                elif mutation == "candidate":
                    path = folder / "candidate.mp4"
                elif mutation == "source":
                    path = self.source / "revisions/current/video.mp4"
                else:
                    path = self.root / "plan/scenes.json"
                old = path.read_bytes()
                if mutation == "target":
                    registry = tool.read_json(path)
                    registry["scenes"][-1]["action"] += " Изменено"
                    path.write_bytes(tool.json_bytes(registry))
                else:
                    path.write_bytes(old + b" ")
                before = self.selected()
                with self.assertRaises(ValueError):
                    self.accept(result)
                self.assertEqual(self.selected(), before)
                path.write_bytes(old)

    def test_recover_between_directory_renames_checks_backup_before_any_write(self):
        first = self.build({"mode": "still", "frame": 3})
        self.accept(first, update_views=False)
        second = self.build({"mode": "still", "frame": 7})
        before = self.selected()

        def crash(source, target, retired):
            retired.parent.mkdir(parents=True, exist_ok=True)
            target.rename(retired)
            raise OSError("Авария между переносами папок")

        with (
            patch.object(tool, "publish_directory", side_effect=crash),
            patch.object(tool, "restore", side_effect=OSError("Прерван откат")),
        ):
            with self.assertRaises(OSError):
                self.accept(second, replace=True, update_views=False)
        journals = [
            path
            for path in (self.root / tool.HISTORY).glob("*/journal.json")
            if tool.read_json(path)["state"] == "publishing"
        ]
        self.assertEqual(len(journals), 1)
        journal = tool.read_json(journals[0])
        self.assertFalse((self.root / journal["directory"]["path"]).exists())
        backup = self.root / journal["directory"]["backup"] / "original.mp4"
        data = backup.read_bytes()
        backup.write_bytes(b"broken backup")
        pending = self.selected()
        with self.assertRaisesRegex(ValueError, "резервная копия комплекта"):
            tool.recover(self.root)
        self.assertEqual(self.selected(), pending)
        backup.write_bytes(data)
        tool.recover(self.root)
        self.assertEqual(self.selected(), before)
        self.assertFalse((self.root / journal["directory"]["retired"]).exists())

    def test_generation_paths_and_nested_json_survive_output_name_collisions(self):
        path = self.source / "manifest.json"
        manifest = tool.read_json(path)
        shutil.copyfile(self.source / "original.mp4", self.source / "video.mp4")
        for entry in descriptors(manifest["generation"]):
            if entry["path"] == "original.mp4":
                entry.update(tool.descriptor(self.source, "video.mp4"))
        shutil.copyfile(self.source / "original.mp4", self.source / "edit-source.mp4")
        (self.source / "derived-output").mkdir()
        (self.source / "derived-output/required.txt").write_text("Исходный файл", encoding="utf-8")
        nested = {"inputs": [tool.descriptor(self.source, name) for name in ("video.mp4", "edit-source.mp4")]}
        (self.source / "nested.json").write_bytes(tool.json_bytes(nested))
        manifest["generation"]["preparation"]["files"].extend(
            [tool.descriptor(self.source, name) for name in ("nested.json", "derived-output/required.txt")]
        )
        path.write_bytes(tool.json_bytes(manifest))
        result = self.build({"mode": "still", "frame": 7})
        self.accept(result, update_views=False)
        target = self.root / "assets/shots/M05"
        derived = validate_package(target / "manifest.json", "M05", self.root)
        original = target / derived["generation"]["original"]["path"]
        self.assertEqual(derived["generation"]["original"]["path"], "video.mp4")
        self.assertEqual(original.read_bytes(), (self.source / "video.mp4").read_bytes())
        self.assertEqual(derived["accepted_edit"]["video"]["path"], "derived-output-1/video.mp4")
        accepted = target / derived["accepted_edit"]["video"]["path"]
        self.assertNotEqual(original.read_bytes(), accepted.read_bytes())
        self.assertEqual(tool.sha(accepted), result["video"]["sha256"])
        self.assertEqual((target / "nested.json").read_bytes(), (self.source / "nested.json").read_bytes())
        for item in tool.read_json(target / "nested.json")["inputs"]:
            resolved = descriptor_file(target, item, self.root)
            self.assertEqual(tool.sha(resolved), item["sha256"])
            self.assertEqual(resolved.read_bytes(), (self.source / item["path"]).read_bytes())
        rebuilt = Path(self.temp.name) / "collision-replay.mp4"
        replay(target / "manifest.json", rebuilt, True, self.root)
        self.assertEqual(self.pixels(rebuilt), self.pixels(accepted))
        output = Path(self.temp.name) / "collision-export"
        export(output, self.root, copy=True)
        bundle = tool.read_json(output / "bundle.json")
        row = next(row for row in bundle["shots"] if row["shot"] == "M05")
        self.assertEqual(tool.sha(output / row["accepted_clip"]), result["video"]["sha256"])

    def test_source_image_in_derived_folder_survives_staging_and_asset_check(self):
        path = self.source / "manifest.json"
        manifest = tool.read_json(path)
        image = self.source / manifest["generation"]["inputs"][0]["path"]
        reference = self.root / "source/derived/hero.png"
        reference.parent.mkdir()
        shutil.copyfile(image, reference)
        exact = reference.read_bytes()
        shared = {"root": "source", "path": "derived/hero.png", "sha256": tool.sha(reference)}
        manifest["generation"]["inputs"].append(shared)
        path.write_bytes(tool.json_bytes(manifest))
        result = self.build({"mode": "still", "frame": 7})
        self.accept(result)
        target = self.root / "assets/shots/M05"
        derived = validate_package(target / "manifest.json", "M05", self.root)
        self.assertIn(shared, derived["generation"]["inputs"])
        self.assertEqual(reference.read_bytes(), exact)
        self.assertFalse((target / "derived/hero.png").exists())
        checked = run(
            [
                sys.executable,
                "-B",
                str(tool.TOOLS_ROOT / "tools/check_assets/check_assets.py"),
                "--project",
                str(self.root),
            ]
        )
        self.assertIn("3 выбранных сцен", checked.decode())

    def test_build_rejects_inexact_recipe_bounds_stale_source_and_lipsync(self):
        for recipe in (
            {"mode": "trim", "start_frame": 119},
            {"mode": "still", "frame": True},
            {"mode": "repeat", "start_frame": 1, "end_frame_exclusive": 1},
            {"mode": "fit", "start_frame": 0, "end_frame_exclusive": 3, "hold": 1},
        ):
            with self.assertRaises(ValueError):
                self.build(recipe)
        path = self.root / "plan/production-status.json"
        status = tool.read_json(path)
        original = path.read_bytes()
        status["shots"]["M02"]["scene_sha256"] = "0" * 64
        path.write_bytes(tool.json_bytes(status))
        with self.assertRaisesRegex(ValueError, "Сначала примите источник"):
            self.build({"mode": "still", "frame": 3})
        path.write_bytes(original)
        path = self.root / "plan/scenes.json"
        registry = tool.read_json(path)
        registry["scenes"][-1]["lipsync"] = True
        path.write_bytes(tool.json_bytes(registry))
        with self.assertRaisesRegex(ValueError, "липсинком"):
            self.build({"mode": "still", "frame": 3})

    def test_preview_without_music_is_exact_silent_candidate_copy(self):
        (self.root / "source/track.mp3").unlink()
        result = self.build({"mode": "still", "frame": 7})
        self.assertEqual(result["preview"]["sha256"], result["video"]["sha256"])
        self.assertEqual(result["audio_source"], {"path": "source/track.mp3", "sha256": None})

    def test_audio_changes_require_new_preview_before_accept_writes(self):
        track = self.root / "source/track.mp3"
        manifest_path = self.root / "source/manifest.json"
        registry_path = self.root / "plan/scenes.json"
        saved = {path: path.read_bytes() for path in (track, manifest_path, registry_path)}
        replacement = Path(self.temp.name) / "replacement.mp3"
        run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=997:sample_rate=44100:duration=30",
                "-c:a",
                "libmp3lame",
                str(replacement),
            ]
        )
        for mutation in ("replacement", "deletion", "appearance", "path"):
            with self.subTest(mutation=mutation):
                for path, data in saved.items():
                    path.write_bytes(data)
                if mutation == "appearance":
                    track.unlink()
                result = self.build({"mode": "still", "frame": 7})
                if mutation in {"replacement", "appearance"}:
                    track.write_bytes(replacement.read_bytes())
                    # Повторяем сохранение валидного трека через «Исходники»:
                    # опись обновляется, постановки планов остаются прежними.
                    manifest = tool.read_json(manifest_path)
                    manifest["track"].update(sha256=tool.sha(track), bytes=track.stat().st_size, duration_seconds=30.0)
                    manifest_path.write_bytes(tool.json_bytes(manifest))
                elif mutation == "deletion":
                    track.unlink()
                else:
                    # Даже те же байты под новым объявленным именем требуют новой пробы.
                    alternate = self.root / "source/alternate.mp3"
                    alternate.write_bytes(track.read_bytes())
                    registry = tool.read_json(registry_path)
                    registry["audio"]["path"] = "source/alternate.mp3"
                    registry_path.write_bytes(tool.json_bytes(registry))
                before = self.selected()
                with self.assertRaisesRegex(ValueError, "музыка изменились после пробы"):
                    self.accept(result)
                self.assertEqual(self.selected(), before)

    def test_audio_change_during_build_does_not_publish_preview(self):
        original_render = tool.render_edit

        def change_track(*args):
            original_render(*args)
            (self.root / "source/track.mp3").unlink()

        with patch.object(tool, "render_edit", side_effect=change_track):
            with self.assertRaisesRegex(ValueError, "музыка или рецепт изменились при сборке"):
                self.build({"mode": "still", "frame": 7})
        # Ни готовая проба, ни незавершённая временная папка не публикуются.
        directories = (self.root / "plan/derived/M05").iterdir()
        self.assertEqual([path.name for path in directories], ["recipes"])


if __name__ == "__main__":
    unittest.main()
