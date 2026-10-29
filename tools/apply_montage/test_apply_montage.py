"""Монтаж проверяется на копии sample-project, включая сбой публикации; @link README.md."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import json
import shutil
import tempfile
import unittest
from unittest.mock import patch

import tools.testing.sample_project  # noqa: F401
from tools.apply_montage import apply_montage as tool
from tools.asset_package.asset_package import replay, validate_package
from tools.build_review.build_review import prepare, probe, run
from tools.common import sha
from tools.scene_registry.scene_registry import project_shot_acceptance


class ApplyMontageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="apply-montage-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "project"
        shutil.copytree(Path(__file__).resolve().parents[1] / "testdata/sample-project", self.root)

    def draft(self, intervals=(("M02", 5, 125),), accepted=False):
        registry = json.loads((self.root / "plan/scenes.json").read_text())
        scenes = {scene["id"]: scene for scene in registry["scenes"]}
        clips, hashes = [], {}
        for sid, start, end in intervals:
            manifest_path = self.root / "assets/shots" / sid / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            source = manifest["accepted_edit"]["video"] if accepted else manifest["generation"]["original"]
            clips.append(
                {
                    "id": "clip-" + sid,
                    "scene": sid,
                    "path": f"assets/shots/{sid}/" + source["path"],
                    "kind": "video",
                    "source_start_frame": start,
                    "source_end_frame_exclusive": end,
                    "source_frames": None,
                }
            )
            hashes[sid] = sha(manifest_path)
        return {
            "schema_version": 1,
            "name": "Ручной монтаж",
            "clips": clips,
            "audio": {
                "path": "source/track.mp3",
                "start_frame": scenes[clips[0]["scene"]]["start_frame"],
                "end_frame_exclusive": scenes[clips[-1]["scene"]]["end_frame_exclusive"],
            },
            "base_scenes_sha256": sha(self.root / "plan/scenes.json"),
            "base_manifest_sha256": hashes,
        }

    def snapshot(self):
        # Журнал и новые immutable revisions допустимы после ошибки; выбранные
        # файлы, исходники, пакеты и все производные обязаны остаться прежними.
        return {
            path.relative_to(self.root).as_posix(): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file() and "montage-history" not in path.parts and "revisions" not in path.parts
        }

    def test_same_duration_cut_preserves_every_old_asset_and_updates_views(self):
        before = self.snapshot()
        draft = self.draft()
        expected = prepare(
            {
                "schema_version": 1,
                "shots": [
                    {
                        key: value
                        for key, value in draft["clips"][0].items()
                        if key in {"scene", "path", "kind", "source_start_frame", "source_end_frame_exclusive"}
                    }
                ],
            },
            self.root,
        )
        result = tool.apply(draft, self.root)
        asset = self.root / "assets/shots/M02"
        manifest = validate_package(asset / "manifest.json", "M02", self.root)
        edit = manifest["accepted_edit"]
        self.assertEqual(edit["source_frame_interval_exclusive"], [5, 125])
        self.assertEqual(edit["rebuild"]["stages"][0]["filter"], expected["shots"][0]["filter"])
        self.assertEqual((self.root / "plan/scenes.json").read_bytes(), before["plan/scenes.json"])
        for name, data in before.items():
            if name.startswith("assets/shots/M02/") and not name.endswith(("manifest.json", "README.md")):
                self.assertEqual((self.root / name).read_bytes(), data)
        self.assertEqual(
            (asset / "revisions" / result["revision"] / "previous-manifest.json").read_bytes(),
            before["assets/shots/M02/manifest.json"],
        )
        self.assertEqual((self.root / "source/track.mp3").read_bytes(), before["source/track.mp3"])
        self.assertEqual((self.root / "plan/audio/timing.json").read_bytes(), before["plan/audio/timing.json"])
        self.assertTrue((self.root / "plan/batches/M03-attempt-01").is_dir())
        media = next(
            stream for stream in probe(asset / edit["video"]["path"])["streams"] if stream["codec_type"] == "video"
        )
        self.assertEqual((media["r_frame_rate"], int(media["nb_frames"])), ("30/1", 120))
        index = json.loads((self.root / "assets/shots/manifest.json").read_text())
        self.assertEqual(index["shots"]["M02"]["asset_manifest"]["sha256"], sha(asset / "manifest.json"))
        self.assertFalse((self.root / result["history"] / "staging").exists())

    def test_boundary_moves_both_accepted_scenes_together(self):
        before = self.snapshot()
        draft = self.draft((("M01", 0, 255), ("M02", 5, 110)))
        tool.apply(draft, self.root, update_views=False)
        scenes = json.loads((self.root / "plan/scenes.json").read_text())["scenes"]
        self.assertEqual(
            [(scene["start_frame"], scene["end_frame_exclusive"]) for scene in scenes[:2]], [(0, 255), (255, 360)]
        )
        for sid, frames in (("M01", 255), ("M02", 105)):
            manifest = validate_package(self.root / f"assets/shots/{sid}/manifest.json", sid, self.root)
            self.assertEqual(manifest["accepted_edit"]["frames"], frames)
            self.assertEqual(
                (self.root / f"assets/shots/{sid}/original.mp4").read_bytes(),
                before[f"assets/shots/{sid}/original.mp4"],
            )

    def test_boundary_move_keeps_acceptance_only_of_previously_current_shots(self):
        status_path = self.root / "plan/production-status.json"
        status = json.loads(status_path.read_text())
        # M02 принят по прежней постановке: монтаж не должен «простить» сюжетную правку.
        old_m02 = "3" * 64
        status["shots"]["M02"]["scene_sha256"] = old_m02
        status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n")
        self.assertEqual(project_shot_acceptance(self.root), {"M01": "completed", "M02": "stale"})
        result = tool.apply(self.draft((("M01", 0, 255), ("M02", 5, 110))), self.root, update_views=False)
        saved = json.loads(status_path.read_text())
        self.assertNotEqual(saved["shots"]["M01"], status["shots"]["M01"])
        self.assertEqual(saved["shots"]["M02"], {"scene_sha256": old_m02})
        self.assertEqual(
            {key: value for key, value in saved.items() if key != "shots"},
            {key: value for key, value in status.items() if key != "shots"},
        )
        self.assertEqual(project_shot_acceptance(self.root), {"M01": "completed", "M02": "stale"})
        # Статус входит в журнал публикации вместе с реестром и манифестами.
        journal = json.loads((self.root / result["history"] / "journal.json").read_text())
        self.assertIn("plan/production-status.json", [entry["path"] for entry in journal["files"]])

    def test_boundary_move_keeps_both_current_shots_accepted(self):
        tool.apply(self.draft((("M01", 0, 255), ("M02", 5, 110))), self.root)
        self.assertEqual(project_shot_acceptance(self.root), {"M01": "completed", "M02": "completed"})
        self.assertIn("готовы 2", (self.root / "ROADMAP.md").read_text())

    def test_accepted_source_keeps_exact_input_and_replays_without_original_reencoding(self):
        old = json.loads((self.root / "assets/shots/M02/manifest.json").read_text())
        source = self.root / "assets/shots/M02" / old["accepted_edit"]["video"]["path"]
        source_bytes = source.read_bytes()
        tool.apply(self.draft((("M02", 0, 120),), accepted=True), self.root, update_views=False)
        manifest_path = self.root / "assets/shots/M02/manifest.json"
        first = json.loads(manifest_path.read_text())
        first_bytes = (manifest_path.parent / first["accepted_edit"]["video"]["path"]).read_bytes()
        tool.apply(self.draft((("M02", 0, 120),), accepted=True), self.root, update_views=False)
        manifest = validate_package(manifest_path, "M02", self.root)
        edit = manifest["accepted_edit"]
        self.assertEqual(edit["rebuild"]["stages"][0]["input"], first["accepted_edit"]["video"]["path"])
        self.assertEqual((manifest_path.parent / edit["rebuild"]["source"]["path"]).read_bytes(), first_bytes)
        self.assertEqual(source.read_bytes(), source_bytes)
        target = Path(self.temporary.name) / "replayed.mp4"
        replay(manifest_path, target, from_original=True, root=self.root)
        self.assertEqual(
            int(next(stream for stream in probe(target)["streams"] if stream["codec_type"] == "video")["nb_frames"]),
            120,
        )

        # Рецепт повторяет ровно тот локальный источник, который показывал preview.
        def decoded_frames(path):
            return run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v:0", "-f", "framemd5", "-"])

        self.assertEqual(decoded_frames(target), decoded_frames(manifest_path.parent / edit["video"]["path"]))

    def test_invalid_or_stale_drafts_never_mutate_project(self):
        before = self.snapshot()
        cases = []
        stale = self.draft()
        stale["base_manifest_sha256"]["M02"] = "0" * 64
        cases.append(stale)
        stale_registry = self.draft()
        stale_registry["base_scenes_sha256"] = "0" * 64
        cases.append(stale_registry)
        short = self.draft()
        short["clips"][0]["source_start_frame"] = 100
        short["clips"][0]["source_end_frame_exclusive"] = 220
        cases.append(short)
        reversed_order = self.draft((("M02", 0, 120), ("M01", 0, 240)))
        cases.append(reversed_order)
        wrong_duration = self.draft()
        wrong_duration["clips"][0]["source_end_frame_exclusive"] -= 1
        cases.append(wrong_duration)
        card = self.draft()
        card["clips"][0]["kind"] = "card"
        cases.append(card)
        with patch.object(tool, "render_edit") as render:
            for draft in cases:
                with self.subTest(draft=draft), self.assertRaises(ValueError):
                    tool.apply(draft, self.root, update_views=False)
            render.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_render_failure_has_no_partial_mutation(self):
        before = self.snapshot()
        draft = self.draft((("M01", 0, 255), ("M02", 5, 110)))
        render = tool.render_edit
        calls = 0

        def fail_second(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise ValueError("Сбой второго рендера")
            return render(*args)

        with patch.object(tool, "render_edit", side_effect=fail_second), self.assertRaises(ValueError):
            tool.apply(draft, self.root, update_views=False)
        self.assertEqual(calls, 2)
        self.assertEqual(self.snapshot(), before)

    def test_change_during_render_is_rejected_before_publication(self):
        draft = self.draft()
        before = self.snapshot()
        render = tool.render_edit

        def change_registry(*args):
            render(*args)
            path = self.root / "plan/scenes.json"
            path.write_bytes(path.read_bytes() + b"\n")

        with patch.object(tool, "render_edit", side_effect=change_registry), self.assertRaises(ValueError):
            tool.apply(draft, self.root, update_views=False)
        before["plan/scenes.json"] += b"\n"
        self.assertEqual(self.snapshot(), before)

    def test_publication_exception_rolls_back_registry_manifests_and_views(self):
        before = self.snapshot()
        publish = tool.publish_file
        calls = 0

        def fail_after_registry(source, target):
            nonlocal calls
            calls += 1
            publish(source, target)
            if target == self.root / "plan/scenes.json":
                # До ошибки уже опубликованы оба manifest и реестр, а также
                # документы по алфавиту. Откат обязан вернуть весь комплект.
                raise OSError("Сбой после публикации реестра")

        with patch.object(tool, "publish_file", side_effect=fail_after_registry), self.assertRaises(OSError):
            tool.apply(self.draft((("M01", 0, 255), ("M02", 5, 110))), self.root)
        self.assertGreater(calls, 2)
        self.assertEqual(self.snapshot(), before)
        journal = next((self.root / tool.HISTORY).glob("*/journal.json"))
        self.assertEqual(json.loads(journal.read_text())["state"], "rolled_back")

    def test_next_launch_recovers_interrupted_publication(self):
        before = self.snapshot()
        publish = tool.publish_file

        def interrupt(source, target):
            publish(source, target)
            raise KeyboardInterrupt("Имитация аварийного завершения")

        # Остановка процесса не вызывает except/finally. Подмена restore
        # оставляет тот же промежуточный журнал, который прочтёт следующий CLI.
        with (
            patch.object(tool, "publish_file", side_effect=interrupt),
            patch.object(tool, "restore", side_effect=KeyboardInterrupt),
            self.assertRaises(KeyboardInterrupt),
        ):
            tool.apply(self.draft(), self.root, update_views=False)
        tool.recover(self.root)
        self.assertEqual(self.snapshot(), before)
        tool.recover(self.root)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
