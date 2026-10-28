"""Перенос попытки в комплект assets на временной фикстуре с настоящим видео; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import unittest.mock

from tools.accept_shot import accept_shot as tool
from tools.asset_package.asset_package import validate_package


def scene(sid, start, end, lipsync=False):
    return {
        "id": sid,
        "original": sid,
        "sequence": "s",
        "title": "План " + sid,
        "start_frame": start,
        "end_frame_exclusive": end,
        "camera": "статика",
        "action": "действие",
        "continuity": "связь",
        "references": ["П"],
        "lipsync": lipsync,
        "card": {"primary_reference": "П"},
        "state_from": None,
        "state_changes": {},
    }


class AcceptShotTests(unittest.TestCase):
    def test_cleanup_preserves_saved_manual_montage_and_its_sources(self):
        drafts = self.root / "plan/montage"
        drafts.mkdir()
        (drafts / "draft.json").write_text(
            json.dumps({"clips": [{"path": str(self.work.relative_to(self.root) / "original.mp4")}]})
        )
        export = self.root / "plan/batches/review-manual-test"
        export.mkdir()
        review = export / "review.json"
        review.write_text('{"shots": [{"id": "M02"}]}')
        review.with_suffix(".mp4").write_bytes(b"export")
        (export / "montage.json").write_text('{"clips": []}')
        removed = tool.clean_work(self.root, "M02", package=self.package, review=review)
        self.assertEqual(removed, [])
        self.assertTrue((self.work / "original.mp4").is_file())
        self.assertTrue(review.with_suffix(".mp4").is_file())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="accept-shot-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # Наблюдения расхода пишутся в каталог состояния; у теста он свой.
        self.state = self.root / "state"
        patcher = unittest.mock.patch.dict(os.environ, {"SONGFRAME_LOCAL_DIR": str(self.state)})
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in ("plan/batches", "plan/awaiting", "assets/shots", "source"):
            (self.root / name).mkdir(parents=True)
        self.registry = {
            "schema_version": 1,
            "fps": 30,
            "audio": {"path": "source/track.mp3", "end_seconds": "4"},
            "references": {"П": {"name": "Мира", "path": "source/heroes/mira.jpg"}},
            "visual_direction": "# Правила",
            "sequences": [{"id": "s", "title": "Сцена", "direction": "направление"}],
            "scenes": [scene("M01", 0, 60), scene("M02", 60, 120)],
        }
        self.write_registry()
        (self.root / "plan/project.json").write_text(
            json.dumps({"schema_version": 1, "name": "Тест", "animatic_video": "test.mp4"})
        )
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100",
                "-t",
                "5",
                "-ac",
                "2",
                str(self.root / "source/track.mp3"),
            ],
            check=True,
        )
        self.package = self.root / "plan/batches/M02-attempt-01"
        self.work = self.package / "request"
        (self.work / "inputs").mkdir(parents=True)
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=1920x1080:r=24",
                "-frames:v",
                "96",
                "-pix_fmt",
                "yuv420p",
                str(self.work / "original.mp4"),
            ],
            check=True,
        )
        (self.work / "inputs/01.png").write_bytes(b"first frame bytes")
        (self.work / "prompt.txt").write_text("Один непрерывный план.", encoding="utf-8")
        request = {
            "schema_version": 1,
            "shot": "M02",
            "kind": "video",
            "provider": "test",
            "command": "image_to_video",
            "model": "test-video",
            "parameters": {"duration": "3", "resolution": "1080p", "enable_audio": "false"},
            "outputs": 1,
            "inputs": [
                {
                    "flag": "input",
                    "slot": "first_image",
                    "role": "first",
                    "path": "inputs/01.png",
                    "sha256": "x",
                    "bytes": 17,
                },
                {
                    "flag": "input",
                    "slot": "tail_image",
                    "role": "last",
                    "path": "inputs/01.png",
                    "sha256": "x",
                    "bytes": 17,
                },
            ],
            "prompt": {"path": "prompt.txt", "sha256": "y"},
            "video_without_watermark": True,
        }
        (self.work / "request.json").write_text(json.dumps(request, ensure_ascii=False))
        (self.work / "attempt.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "request_sha256": "abc",
                    "status": "downloaded",
                    "generation_id": "job-1",
                    "service_status": "completed",
                    "credits_consumed": 30,
                    "downloads": [{"number": 1, "path": "original.mp4", "bytes": 1}],
                }
            )
        )
        (self.package / "workflow.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "shot": "M02",
                    "stage": "downloaded",
                    "request_dir": "request",
                    "mode": "shot",
                    "keyframes": [],
                }
            )
        )
        self.pricing = self.root / "pricing.json"
        self.pricing.write_text(json.dumps({"schema_version": 1, "models": {}, "observed": []}))

    def write_registry(self):
        (self.root / "plan/scenes.json").write_text(json.dumps(self.registry, ensure_ascii=False), encoding="utf-8")

    def accept(self, **kwargs):
        options = dict(package=self.package, root=self.root, update_views=False, pricing=self.pricing)
        options.update(kwargs)
        return tool.accept("M02", **options)

    def test_cut_builds_valid_package_with_deduplicated_inputs(self):
        result = self.accept(cut=(12, 72))
        target = self.root / "assets/shots/M02"
        manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(result["frames"], 60)
        self.assertTrue((target / "original.mp4").is_file() and (target / "video.mp4").is_file())
        self.assertEqual(
            hashlib.sha256((target / "original.mp4").read_bytes()).hexdigest(),
            hashlib.sha256((self.work / "original.mp4").read_bytes()).hexdigest(),
        )
        self.assertEqual(
            [i["path"] for i in manifest["generation"]["inputs"]], ["generation-input-1.png", "generation-input-1.png"]
        )
        self.assertEqual([i["role"] for i in manifest["generation"]["inputs"]], ["Первый кадр", "Последний кадр"])
        edit = manifest["accepted_edit"]
        self.assertEqual(
            (edit["frames"], edit["source_frame_interval_exclusive"], edit["speed"]["ratio"]), (60, [12, 72], "1")
        )
        self.assertEqual(edit["source_interval_seconds"], [0.4, 2.4])
        self.assertEqual(edit["source_fps"], "24/1")
        validate_package(target / "manifest.json", "M02", self.root)
        snapshot = json.loads((target / "generation-request.json").read_text(encoding="utf-8"))
        self.assertEqual(snapshot["provider"], "test")
        self.assertEqual(snapshot["generation_id"], "job-1")
        self.assertNotIn("credits_consumed", snapshot)
        self.assertEqual(result["observed_credits"], 30.0)
        self.assertEqual(result["warnings"], [])
        # Таблица цен только читается; наблюдение лежит в каталоге состояния провайдера.
        self.assertEqual(json.loads(self.pricing.read_text())["observed"], [])
        observations = json.loads((self.state / "providers/test/pricing-observations.json").read_text())
        self.assertEqual([item["credits"] for item in observations["observed"]], [30.0])
        self.assertTrue(self.package.exists())

    def test_observation_write_failure_is_warning_after_kit_transfer(self):
        # Файл на месте каталога состояния: запись наблюдения невозможна, но комплект уже перенесён.
        self.state.write_text("не каталог")
        result = self.accept(cut=(12, 72), clean=True)
        target = self.root / "assets/shots/M02"
        validate_package(target / "manifest.json", "M02", self.root)
        self.assertIsNone(result["observed_credits"])
        self.assertEqual(len(result["warnings"]), 1)
        self.assertIn("Наблюдение расхода не записано", result["warnings"][0])
        self.assertFalse(self.package.exists())

    def test_manual_result_without_id_records_provenance(self):
        attempt = json.loads((self.work / "attempt.json").read_text())
        attempt.update(generation_id=None, manual_result=True)
        (self.work / "attempt.json").write_text(json.dumps(attempt))
        self.accept(cut=(12, 72))
        target = self.root / "assets/shots/M02"
        snapshot = json.loads((target / "generation-request.json").read_text(encoding="utf-8"))
        self.assertIsNone(snapshot["generation_id"])
        self.assertIn("загружен пользователем", snapshot["provenance"])
        validate_package(target / "manifest.json", "M02", self.root)

    def test_speed_and_holds_fill_window_and_review_recipe_is_reused(self):
        with self.assertRaises(ValueError):
            self.accept(cut=(0, 90))
        result = self.accept(cut=(0, 90), speed="1.5")
        manifest = json.loads((self.root / "assets/shots/M02/manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["accepted_edit"]["speed"]["ratio"], "3/2")
        self.assertEqual(manifest["accepted_edit"]["speed"]["duration_change_seconds"], -1.0)
        self.assertEqual(result["video_sha256"], manifest["accepted_edit"]["video"]["sha256"])

    def test_review_recipe_must_come_from_the_same_original(self):
        review = self.root / "plan/batches/M02-review/review.json"
        review.parent.mkdir()
        review.write_text(
            json.dumps(
                {
                    "status": "review_pending",
                    "shots": [
                        {
                            "id": "M02",
                            "kind": "video",
                            "path": str(self.work / "original.mp4"),
                            "source_start_frame": 6,
                            "source_end_frame_exclusive": 36,
                            "speed": "1",
                            "hold_first_frames": 10,
                            "hold_last_frames": 20,
                        }
                    ],
                }
            )
        )
        review.with_suffix(".mp4").write_bytes(b"review video")
        result = self.accept(review=review, clean=True)
        manifest = json.loads((self.root / "assets/shots/M02/manifest.json").read_text(encoding="utf-8"))
        edit = manifest["accepted_edit"]
        self.assertEqual(
            (edit["hold_first_seconds"], edit["hold_last_seconds"], edit["source_frame_interval_exclusive"]),
            (10 / 30, 20 / 30, [6, 36]),
        )
        self.assertFalse(self.package.exists())
        self.assertFalse(review.exists() or review.with_suffix(".mp4").exists())
        # Опустевшая папка пробы удаляется вместе с её файлами.
        self.assertEqual(
            sorted(result["cleaned"]),
            sorted(
                [
                    "plan/batches/M02-attempt-01",
                    "plan/batches/M02-review/review.json",
                    "plan/batches/M02-review/review.mp4",
                    "plan/batches/M02-review",
                ]
            ),
        )
        self.assertFalse(review.parent.exists())

    def test_clean_removes_every_package_of_the_shot_but_keeps_other_shots(self):
        batches = self.root / "plan/batches"
        (batches / "M02-attempt-02").mkdir()
        (batches / "M02-attempt-02/workflow.json").write_text(
            json.dumps(
                {"schema_version": 1, "shot": "M02", "stage": "keyframes_review", "request_dir": None, "keyframes": []}
            )
        )
        (batches / "retry-m02").mkdir()
        retry = {"shot": "M02", "kind": "video", "provider": "test"}
        (batches / "retry-m02/request.json").write_text(json.dumps(retry))
        (batches / "M02-review-v01").mkdir()
        (batches / "M01-M02-review").mkdir()
        (batches / "M01-M02-review/review-01.json").write_text(
            json.dumps({"status": "review_pending", "shots": [{"id": "M01"}, {"id": "M02"}]})
        )
        (batches / "M01-attempt-01").mkdir()
        (batches / "M01-attempt-01/workflow.json").write_text(
            json.dumps({"schema_version": 1, "shot": "M01", "stage": "ready", "request_dir": None})
        )
        (batches / "notes").mkdir()
        (batches / "notes/readme.txt").write_text("не пакет")
        (self.root / "plan/awaiting/M01").mkdir()
        (self.root / "plan/awaiting/M01/workflow.json").write_text(
            json.dumps({"schema_version": 1, "shot": "M01", "stage": "ready"})
        )
        self.assertEqual(self.accept(cut=(0, 60))["cleaned"], [])
        self.assertTrue(self.package.exists())
        shutil.rmtree(self.root / "assets/shots/M02")
        result = self.accept(cut=(0, 60), clean=True)
        self.assertEqual(
            sorted(result["cleaned"]),
            sorted(
                [
                    "plan/batches/M02-attempt-01",
                    "plan/batches/M02-attempt-02",
                    "plan/batches/retry-m02",
                    "plan/batches/M02-review-v01",
                ]
            ),
        )
        # Проба M01–M02 остаётся: M01 ещё не принят.
        self.assertEqual({p.name for p in batches.iterdir()}, {"M01-attempt-01", "notes", "M01-M02-review"})
        self.assertTrue((self.root / "plan/awaiting/M01/workflow.json").exists())

    def test_preparation_keeps_shared_source_reference_without_copy(self):
        # Общий референс остаётся в source; уникальный кадр и промпт сохраняются
        # внутри комплекта. Проверяем ссылки и байты после настоящего переноса.
        shared = self.root / "source/reference.png"
        shared.write_bytes(b"shared reference bytes")
        frame = self.package / "reference.png"
        frame.write_bytes(b"unique reference bytes")
        prompt = self.package / "frame-prompt.txt"
        prompt.write_text("Кадр по общему и уникальному референсам.", encoding="utf-8")
        self.accept(cut=(0, 60), preparation=[shared, frame, prompt])
        target = self.root / "assets/shots/M02"
        manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
        prep = json.loads((target / "preparation.json").read_text(encoding="utf-8"))
        source_entry = next(x for x in manifest["generation"]["preparation"]["files"] if x.get("root") == "source")
        self.assertEqual(source_entry["path"], "reference.png")
        self.assertEqual(source_entry["sha256"], tool.sha(shared))
        self.assertEqual(prep["references"][0]["root"], "source")
        local = next(x for x in prep["references"] if x.get("root") != "source")
        self.assertEqual((target / local["path"]).read_bytes(), frame.read_bytes())
        self.assertEqual((target / prep["frame_prompts"][0]["path"]).read_bytes(), prompt.read_bytes())
        self.assertFalse(any(p.is_file() and p.read_bytes() == shared.read_bytes() for p in target.rglob("*")))
        validate_package(target / "manifest.json", "M02", self.root)

    def test_lipsync_requires_audio_and_existing_package_is_not_replaced(self):
        self.registry["scenes"][1]["lipsync"] = True
        self.write_registry()
        with self.assertRaises(ValueError):
            self.accept(cut=(12, 72))
        self.assertFalse((self.root / "assets/shots/M02").exists())
        self.assertFalse((self.root / "assets/shots/.accept-M02").exists())
        wav = self.root / "speech.wav"
        wav.write_bytes(b"RIFF wav bytes")
        self.accept(cut=(12, 72), audio=wav)
        manifest = json.loads((self.root / "assets/shots/M02/manifest.json").read_text(encoding="utf-8"))
        self.assertTrue(manifest["generation"]["lipsync"])
        self.assertEqual(manifest["generation"]["audio"]["path"], "speech.wav")
        with self.assertRaises(ValueError):
            self.accept(cut=(12, 72), audio=wav)

    def test_replace_moves_previous_kit_to_assets_replaced(self):
        first = self.accept(cut=(12, 72))
        previous_manifest = (self.root / "assets/shots/M02/manifest.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "--replace"):
            self.accept(cut=(0, 60))
        second = self.accept(cut=(0, 60), replace=True)
        self.assertNotEqual(first["video_sha256"], second["video_sha256"])
        archive = self.root / second["replaced"]
        self.assertTrue(archive.is_relative_to(self.root / "assets/replaced/M02"))
        self.assertEqual((archive / "manifest.json").read_bytes(), previous_manifest)
        self.assertTrue((archive / "original.mp4").is_file() and (archive / "video.mp4").is_file())
        manifest = json.loads((self.root / "assets/shots/M02/manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["accepted_edit"]["video"]["sha256"], second["video_sha256"])
        validate_package(self.root / "assets/shots/M02/manifest.json", "M02", self.root)


if __name__ == "__main__":
    unittest.main()
