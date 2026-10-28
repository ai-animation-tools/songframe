"""Image-ветка использует frozen Kling attempt и отдельный выбор кандидата. @link README.md"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import json
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from tools.kling_request import kling_request
from tools.lint_registry import lint_registry
from tools.shot_workflow import shot_workflow as tool
from tools.shot_workflow.test_shot_workflow_decisions import SCENES


class ImageWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="image-workflow-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "plan/batches").mkdir(parents=True)
        (self.root / "plan/scenes.json").write_text(json.dumps(SCENES), encoding="utf-8")
        (self.root / "plan/project.json").write_text(
            json.dumps({"schema_version": 1, "name": "Тест", "animatic_video": "test.mp4"}), encoding="utf-8"
        )
        self.package = self.root / "plan/batches/M01-attempt-01"
        tool.init("M01", self.package, root=self.root)
        tool.plan_keyframes(self.package, 3, root=self.root)
        tool.ask(self.package, "description_review", root=self.root, executor="app")
        tool.decide(self.package, "approve", root=self.root)
        # Prepare локален; ни один сценарий теста не должен вызвать сервис генерации.
        guard = patch.object(kling_request, "call_cli", side_effect=AssertionError("Сетевой вызов запрещён"))
        guard.start()
        self.addCleanup(guard.stop)

    def workflow(self):
        return tool.load_workflow(self.package)

    def prepare(self, name="image-01", kind="image", shot="M01"):
        prompt = self.root / "prompt.txt"
        prompt.write_text("Тестовая опора.", encoding="utf-8")
        spec = self.root / "spec.json"
        spec.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "shot": shot,
                    "kind": kind,
                    "provider": "kling",
                    "command": "text_to_image" if kind == "image" else "text_to_video",
                    "model": "fixture-model",
                    "parameters": {},
                    "inputs": [],
                    "outputs": 1,
                    "prompt_file": str(prompt),
                }
            ),
            encoding="utf-8",
        )
        directory = self.package / name
        kling_request.prepare(spec, directory)
        return directory

    def state(self, directory, **changes):
        path = directory / "attempt.json"
        data = json.loads(path.read_text())
        data.update(changes)
        kling_request.atomic_json(path, data)
        return data

    def start(self, frame="K01", name="image-01"):
        directory = self.prepare(name)
        tool.set_image_request(self.package, frame, name, root=self.root)
        return directory

    def submit(self, directory):
        tool.decide(self.package, "send", root=self.root)
        self.state(directory, status="submitted", generation_id="fixture-generation")
        return tool.set_stage(self.package, "image_submitted", root=self.root)

    def download(self, directory, suffix=".png", format="PNG", color="red"):
        file = directory / ("original" + suffix)
        Image.new("RGB", (2, 2), color).save(file, format=format)
        self.state(
            directory,
            status="downloaded",
            generation_id="fixture-generation",
            downloads=[{"number": 1, "path": file.name, "bytes": file.stat().st_size}],
        )
        tool.set_stage(self.package, "image_downloaded", root=self.root)
        return file

    def test_two_frames_preserve_video_originals_history_and_separate_acceptance(self):
        video = self.package / "video-request"
        video.mkdir()
        (video / "request.json").write_text(json.dumps({"provider": "kling"}), encoding="utf-8")
        (video / "original.mp4").write_bytes(b"paid-video-original")
        data = self.workflow()
        data.update(request_dir="video-request", unknown={"keep": True})
        tool.save_workflow(self.package, data)
        immutable = {}
        for frame, name, color in [("K01", "image-01", "red"), ("K02", "image-02", "blue")]:
            directory = self.start(frame, name)
            pending = self.workflow()["pending_decision"]
            self.assertEqual(pending["options"], ["send", "park", "revise"])
            self.assertEqual(pending["executor"], "app")
            self.submit(directory)
            file = self.download(directory, color=color)
            immutable.update({path: path.read_bytes() for path in directory.iterdir() if path.is_file()})
            data = tool.select_image(self.package, str(file), root=self.root)
            self.assertEqual(data["stage"], "keyframes_review")
            self.assertIsNone(data["pending_decision"])
            candidate = next(item for item in data["keyframes"] if item["id"] == frame)
            self.assertFalse(candidate["approved"])
            self.assertTrue(data["description_approved"])
            self.assertEqual(candidate["path"], f"keyframes/{frame}.png")
            self.assertEqual(tool.sha(self.package / candidate["path"]), tool.sha(file))
            self.assertEqual(data["request_dir"], "video-request")
            if frame == "K01":
                tool.approve(self.package, frame, self.package / candidate["path"], root=self.root)
                accepted = (self.package / candidate["path"]).read_bytes()
        self.assertEqual(len(data["image_requests"]), 2)
        self.assertEqual(data["unknown"], {"keep": True})
        self.assertTrue(data["keyframes"][0]["approved"])
        self.assertEqual((self.package / "keyframes/K01.png").read_bytes(), accepted)
        self.assertEqual((video / "original.mp4").read_bytes(), b"paid-video-original")
        for path, content in immutable.items():
            self.assertEqual(path.read_bytes(), content)
        tool.ask(self.package, "keyframes_review", root=self.root, executor="app")
        self.assertTrue(
            all(frame["approved"] for frame in tool.decide(self.package, "approve", root=self.root)["keyframes"])
        )

    def test_description_approval_is_durable_with_legacy_fallback_and_revise_reset(self):
        directory = self.prepare()
        data = self.workflow()
        del data["description_approved"]
        tool.save_workflow(self.package, data)
        data = tool.set_image_request(self.package, "K01", directory.name, root=self.root)
        self.assertTrue(data["description_approved"])
        original = (directory / "attempt.json").read_bytes()
        tool.ask(self.package, "description_review", root=self.root, executor="app")
        data = tool.decide(self.package, "revise", root=self.root)
        self.assertFalse(data["description_approved"])
        with self.assertRaisesRegex(ValueError, "утвердите описание"):
            tool.set_image_request(self.package, "K01", directory.name, root=self.root)
        self.assertEqual((directory / "attempt.json").read_bytes(), original)
        tool.ask(self.package, "description_review", root=self.root, executor="app")
        self.assertTrue(tool.decide(self.package, "approve", root=self.root)["description_approved"])

    def test_reasking_prepared_request_preserves_executor_history_and_attempt(self):
        directory = self.start()
        data = self.workflow()
        data["image_requests"][0]["unknown"] = {"keep": True}
        tool.save_workflow(self.package, data)
        original = (directory / "attempt.json").read_bytes()
        for verdict in ("park", "revise"):
            tool.decide(self.package, verdict, root=self.root)
            data = tool.set_image_request(self.package, "K01", "image-01", root=self.root)
            self.assertEqual(data["executor"], "app")
            self.assertEqual(len(data["image_requests"]), 1)
            self.assertEqual(data["image_requests"][0]["unknown"], {"keep": True})
            self.assertEqual((directory / "attempt.json").read_bytes(), original)
        data.pop("executor")
        data["pending_decision"] = None
        tool.save_workflow(self.package, data)
        self.assertEqual(tool.set_image_request(self.package, "K01", "image-01", root=self.root)["executor"], "agent")

    def test_park_moves_prepared_image_without_video_request_or_reset(self):
        directory = self.start()
        tool.decide(self.package, "park", root=self.root)
        original = (directory / "attempt.json").read_bytes()
        self.package = tool.park(self.package, root=self.root)
        data = self.workflow()
        self.assertEqual(data["stage"], "image_request_choice")
        self.assertEqual(data["wait_reason"], "user_saved")
        self.assertIsNone(data["request_dir"])
        self.assertEqual((self.package / "image-01/attempt.json").read_bytes(), original)
        self.assertEqual(tool.report(self.package, self.root)["problems"], [])
        errors = [item for item in lint_registry.lint(self.root).errors if item["file"].startswith("plan/awaiting/")]
        self.assertEqual(errors, [])
        data = tool.set_image_request(self.package, "K01", "image-01", root=self.root)
        self.assertEqual(data["pending_decision"]["options"], ["send", "park", "revise"])

    def test_unknown_submission_cannot_reenter_send_or_replace_active_request(self):
        directory = self.start()
        other = self.prepare("image-02")
        tool.decide(self.package, "send", root=self.root)
        self.state(directory, status="submission_unknown")
        tool.set_stage(self.package, "image_submitted", root=self.root)
        before = (self.package / "workflow.json").read_bytes()
        attempt_before = (directory / "attempt.json").read_bytes()
        for operation in [
            lambda: tool.set_image_request(self.package, "K02", other.name, root=self.root),
            lambda: tool.set_stage(self.package, "image_request_choice", root=self.root),
            lambda: tool.set_stage(self.package, "image_downloaded", root=self.root),
            lambda: tool.select_image(self.package, directory / "original.png", root=self.root),
        ]:
            with self.assertRaises(ValueError):
                operation()
        self.assertEqual((self.package / "workflow.json").read_bytes(), before)
        self.assertEqual((directory / "attempt.json").read_bytes(), attempt_before)

    def test_submitted_transition_requires_send_and_recorded_attempt(self):
        directory = self.start()
        with self.assertRaisesRegex(ValueError, "send"):
            tool.set_stage(self.package, "image_submitted", root=self.root)
        tool.decide(self.package, "send", root=self.root)
        with self.assertRaisesRegex(ValueError, "attempt.json"):
            tool.set_stage(self.package, "image_submitted", root=self.root)
        self.state(directory, status="submitted", generation_id="id")
        tool.set_stage(self.package, "image_submitted", root=self.root)
        with self.assertRaisesRegex(ValueError, "downloaded"):
            tool.set_stage(self.package, "image_downloaded", root=self.root)

    def test_set_request_rejects_wrong_kind_frame_shot_and_changed_frozen_prompt(self):
        image = self.prepare()
        self.prepare("video", kind="video")
        self.prepare("wrong-shot", shot="M02")
        before = (self.package / "workflow.json").read_bytes()
        for frame, name in [
            ("K99", image.name),
            ("K01", "video"),
            ("K01", "wrong-shot"),
            ("K01", "../outside"),
            ("K01", str(image)),
        ]:
            with self.subTest(frame=frame, name=name), self.assertRaises((ValueError, FileNotFoundError)):
                tool.set_image_request(self.package, frame, name, root=self.root)
        (image / "prompt.txt").write_text("Промпт подменён", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Промпт или вход изменён"):
            tool.set_image_request(self.package, "K01", image.name, root=self.root)
        self.assertEqual((self.package / "workflow.json").read_bytes(), before)

    def test_select_accepts_real_jpeg_and_webp_without_conversion(self):
        for suffix, format in [(".jpeg", "JPEG"), (".webp", "WEBP")]:
            with self.subTest(format=format):
                directory = self.start("K01", "image-" + format)
                self.submit(directory)
                original = self.download(directory, suffix, format)
                content = original.read_bytes()
                data = tool.select_image(self.package, original, root=self.root)
                self.assertEqual(data["keyframes"][0]["path"], "keyframes/K01" + suffix)
                self.assertEqual((self.package / data["keyframes"][0]["path"]).read_bytes(), content)
                self.assertEqual(original.read_bytes(), content)

    def test_select_rejects_unregistered_wrong_format_and_approved_frame(self):
        directory = self.start()
        self.submit(directory)
        original = self.download(directory)
        outside = self.root / "outside.png"
        outside.write_bytes(original.read_bytes())
        original_bytes = original.read_bytes()
        for file in [outside, self.package / "keyframes/K01.png"]:
            with self.assertRaisesRegex(ValueError, "downloads"):
                tool.select_image(self.package, file, root=self.root)
        # Настоящий JPEG с расширением PNG нельзя незаметно перекодировать или переименовать.
        Image.new("RGB", (2, 2), "blue").save(original, format="JPEG")
        self.state(directory, downloads=[{"number": 1, "path": original.name, "bytes": original.stat().st_size}])
        with self.assertRaisesRegex(ValueError, "Расширение"):
            tool.select_image(self.package, original, root=self.root)
        original.write_bytes(b"not an image")
        self.state(directory, downloads=[{"number": 1, "path": original.name, "bytes": original.stat().st_size}])
        with self.assertRaisesRegex(ValueError, "настоящий"):
            tool.select_image(self.package, original, root=self.root)
        original.write_bytes(original_bytes)
        self.state(directory, downloads=[{"number": 1, "path": original.name, "bytes": original.stat().st_size}])
        data = self.workflow()
        data["keyframes"][0].update(approved=True, path="accepted.png", sha256=tool.sha(original))
        (self.package / "accepted.png").write_bytes(original_bytes)
        tool.save_workflow(self.package, data)
        with self.assertRaisesRegex(ValueError, "Принятую"):
            tool.select_image(self.package, original, root=self.root)
        self.assertEqual((self.package / "accepted.png").read_bytes(), original_bytes)

    def test_switch_after_download_requires_selected_candidate_and_preserves_history_sha(self):
        directory = self.start()
        self.submit(directory)
        original = self.download(directory)
        next_dir = self.prepare("next")
        with self.assertRaises(ValueError):
            tool.set_image_request(self.package, "K02", next_dir.name, root=self.root)
        tool.select_image(self.package, original, root=self.root)
        data = self.workflow()
        data["image_requests"][0]["selected_sha256"] = "0" * 64
        tool.save_workflow(self.package, data)
        with self.assertRaisesRegex(ValueError, "не совпадает"):
            tool.set_image_request(self.package, "K02", next_dir.name, root=self.root)
        self.assertEqual(len(self.workflow()["image_requests"]), 1)

    def test_rejected_candidates_reset_paths_but_preserve_originals_and_allow_sequential_retry(self):
        original_bytes = {}
        candidate_bytes = {}
        for frame, name in [("K01", "first"), ("K02", "second")]:
            directory = self.start(frame, name)
            self.submit(directory)
            original = self.download(directory)
            original_bytes[original] = original.read_bytes()
            data = tool.select_image(self.package, original, root=self.root)
            self.assertEqual(data["image_requests"][-1]["selected_sha256"], tool.sha(original))
            self.assertIn("selected_at", data["image_requests"][-1])
            candidate = self.package / data["keyframes"][int(frame[1:]) - 1]["path"]
            candidate_bytes[candidate] = candidate.read_bytes()
        tool.ask(self.package, "keyframes_review", root=self.root, executor="app")
        data = tool.decide(self.package, "revise", root=self.root)
        self.assertTrue(all(frame["path"] is None and frame["sha256"] is None for frame in data["keyframes"]))
        for path, content in {**original_bytes, **candidate_bytes}.items():
            self.assertEqual(path.read_bytes(), content)
        for frame, name in [("K01", "retry-first"), ("K02", "retry-second")]:
            directory = self.start(frame, name)
            self.submit(directory)
            original = self.download(directory, color="blue")
            tool.select_image(self.package, original, root=self.root)
        data = self.workflow()
        self.assertEqual(len(data["image_requests"]), 4)
        self.assertTrue(all(entry.get("selected_sha256") for entry in data["image_requests"]))
        for path, content in original_bytes.items():
            self.assertEqual(path.read_bytes(), content)

    def test_revised_description_can_replace_old_frame_ids_after_durable_original_selection(self):
        directory = self.start()
        self.submit(directory)
        original = self.download(directory)
        data = tool.select_image(self.package, original, root=self.root)
        proof = data["image_requests"][0].copy()
        attempt_bytes = (directory / "attempt.json").read_bytes()
        original_bytes = original.read_bytes()
        # Применение нового description меняет список/пути опор, но сохраняет историю генерации.
        data.update(stage="description_review", description_approved=False)
        data["keyframes"] = [
            {"id": "K03", "role": "first", "time_seconds": 0, "path": None, "sha256": None, "approved": False}
        ]
        tool.save_workflow(self.package, data)
        tool.ask(self.package, "description_review", root=self.root, executor="app")
        tool.decide(self.package, "approve", root=self.root)
        next_request = self.prepare("revised-description")
        data = tool.set_image_request(self.package, "K03", next_request.name, root=self.root)
        self.assertEqual(data["image_requests"][0], proof)
        self.assertEqual(data["image_frame_id"], "K03")
        self.assertEqual((directory / "attempt.json").read_bytes(), attempt_bytes)
        self.assertEqual(original.read_bytes(), original_bytes)

    def test_selection_proof_does_not_allow_unknown_or_failed_submission_to_be_replaced(self):
        directory = self.start()
        self.submit(directory)
        original = self.download(directory)
        tool.select_image(self.package, original, root=self.root)
        next_request = self.prepare("next")
        before = (self.package / "workflow.json").read_bytes()
        for status in ("submitting", "submission_unknown", "submitted", "running", "downloading", "failed"):
            self.state(directory, status=status)
            with self.subTest(status=status), self.assertRaisesRegex(ValueError, "Предыдущая отправка"):
                tool.set_image_request(self.package, "K02", next_request.name, root=self.root)
            self.assertEqual((self.package / "workflow.json").read_bytes(), before)

    def test_revise_preserves_approved_frame_and_legacy_selection_is_upgraded(self):
        directory = self.start("K02")
        self.submit(directory)
        original = self.download(directory)
        data = tool.select_image(self.package, original, root=self.root)
        data["image_requests"][0].pop("selected_sha256")
        data["image_requests"][0].pop("selected_at")
        tool.save_workflow(self.package, data)
        # Старый пакет без selected_sha256 по-прежнему доказывает выбор совпадающей копией.
        next_request = self.prepare("legacy-next")
        data = tool.set_image_request(self.package, "K01", next_request.name, root=self.root)
        self.assertEqual(data["image_requests"][0]["selected_sha256"], tool.sha(original))
        self.submit(next_request)
        first_original = self.download(next_request, color="blue")
        tool.select_image(self.package, first_original, root=self.root)
        accepted = self.package / "keyframes/K01.png"
        tool.approve(self.package, "K01", accepted, root=self.root)
        content = accepted.read_bytes()
        tool.ask(self.package, "keyframes_review", root=self.root, executor="app")
        data = tool.decide(self.package, "revise", root=self.root)
        self.assertTrue(data["keyframes"][0]["approved"])
        self.assertEqual(data["keyframes"][0]["path"], "keyframes/K01.png")
        self.assertEqual(accepted.read_bytes(), content)
        self.assertIsNone(data["keyframes"][1]["path"])
        self.assertIsNone(data["keyframes"][1]["sha256"])
        self.assertEqual(data["approved_frames"]["K01"], tool.sha(accepted))

    def test_image_branch_does_not_change_legacy_video_transition_order(self):
        self.assertEqual(
            tool.STAGES,
            [
                "description_review",
                "keyframes_review",
                "prompt_review",
                "request_choice",
                "ready",
                "submitted",
                "downloaded",
                "edit_review",
                "accepted",
            ],
        )
        self.assertTrue(tool.allowed_transition("description_review", "keyframes_review"))
        self.assertTrue(tool.allowed_transition("keyframes_review", "image_request_choice"))
        self.assertFalse(tool.allowed_transition("image_request_choice", "image_downloaded"))
        self.assertFalse(tool.allowed_transition("image_submitted", "keyframes_review"))
        self.assertFalse(tool.allowed_transition("prompt_review", "image_request_choice"))
        self.assertEqual(tool.report(self.package, self.root)["image_requests"], [])

    def test_cli_contract_and_report_use_separate_image_fields(self):
        directory = self.prepare()
        with (
            patch.object(
                sys,
                "argv",
                [
                    "shot_workflow.py",
                    "set-image-request",
                    "--dir",
                    str(self.package),
                    "--frame",
                    "K01",
                    "--request-dir",
                    directory.name,
                ],
            ),
            patch.object(tool, "ROOT", self.root),
        ):
            tool.main()
        self.submit(directory)
        original = self.download(directory)
        with (
            patch.object(
                sys, "argv", ["shot_workflow.py", "select-image", "--dir", str(self.package), "--file", str(original)]
            ),
            patch.object(tool, "ROOT", self.root),
        ):
            tool.main()
        info = tool.report(self.package, self.root)
        self.assertEqual(info["image_attempt_status"], "downloaded")
        self.assertEqual(info["image_frame_id"], "K01")
        self.assertIsNone(info["request_dir"])
        self.assertIn("image-01", tool.table(info))


if __name__ == "__main__":
    unittest.main()
