"""Этапы, опоры, промпт и перенос пакета в очередь на временной фикстуре; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import tempfile
import unittest

from tools.shot_workflow import shot_workflow as tool


def scene(sid, start, end, source, changes):
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
        "lipsync": False,
        "card": {"primary_reference": "П"},
        "state_from": source,
        "state_changes": changes,
    }


class ShotWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="shot-workflow-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "plan/batches").mkdir(parents=True)
        (self.root / "plan/awaiting").mkdir(parents=True)
        self.registry = {
            "schema_version": 1,
            "fps": 30,
            "audio": {"path": "source/track.mp3", "end_seconds": "6"},
            "references": {"П": {"name": "Мира", "path": "source/heroes/mira.jpg"}},
            "visual_direction": "# Правила",
            "sequences": [{"id": "s", "title": "Сцена", "direction": "направление"}],
            "scenes": [
                scene("M01", 0, 90, None, {"before": {"mira": {"position": "у лодки"}}}),
                scene("M02", 90, 180, "M01", {}),
            ],
        }
        self.write_registry()
        self.frame = self.root / "draft.png"
        self.frame.write_bytes(b"png bytes")
        self.package = self.root / "plan/batches/M02-attempt-01"

    def write_registry(self):
        (self.root / "plan/scenes.json").write_text(json.dumps(self.registry, ensure_ascii=False), encoding="utf-8")

    def test_full_cycle_from_init_to_queue(self):
        data = tool.init("M02", self.package, "shot", self.root)
        self.assertEqual(
            (data["stage"], data["timing"]["window_seconds"], data["timing"]["frames"]), ("description_review", 3.0, 90)
        )
        with self.assertRaises(ValueError):
            tool.plan_keyframes(self.package, 3, root=self.root)
        data = tool.plan_keyframes(self.package, 4, [(2.5, "появление фонаря")], self.root)
        self.assertEqual(
            [(k["id"], k["role"], k["time_seconds"]) for k in data["keyframes"]],
            [("K01", "first", 0.0), ("K02", "middle", 2.5), ("K03", "last", 4.0)],
        )
        self.assertEqual(data["current_keyframe"], "K01")
        with self.assertRaises(ValueError):
            tool.approve_prompt(self.package, root=self.root)
        data = tool.approve(self.package, "K01", self.frame, self.root)
        self.assertEqual(
            (data["stage"], data["current_keyframe"], data["keyframes"][0]["path"]),
            ("keyframes_review", "K02", "frames/K01.png"),
        )
        self.assertTrue((self.package / "frames/K01.png").is_file())
        tool.approve(self.package, "K02", self.frame, self.root)
        data = tool.approve(self.package, "K03", self.package / "frames/K01.png", self.root)
        self.assertIsNone(data["current_keyframe"])
        self.assertEqual(set(data["approved_frames"]), {"K01", "K02", "K03"})
        (self.package / "video-prompt.txt").write_text("Один непрерывный план.", encoding="utf-8")
        data, warnings = tool.approve_prompt(self.package, root=self.root)
        self.assertEqual((data["stage"], warnings, data["prompt"]["approved"]), ("prompt_review", [], True))
        with self.assertRaises(ValueError):
            tool.set_stage(self.package, "request_choice", root=self.root)
        request_dir = self.package / "request"
        request_dir.mkdir()
        (request_dir / "request.json").write_text("{}")
        data = tool.set_stage(self.package, "request_choice", request_dir="request", root=self.root)
        self.assertEqual(data["stage"], "request_choice")
        info = tool.report(self.package, self.root)
        self.assertEqual(info["problems"], [])
        self.assertIn("cost_check", info["next_action"])
        target = tool.park(self.package, self.root)
        self.assertEqual(target, self.root / "plan/awaiting/M02")
        self.assertFalse(self.package.exists())
        parked = tool.load_workflow(target)
        self.assertEqual((parked["stage"], parked["wait_reason"]), ("ready", "user_saved"))
        self.assertEqual(tool.sha(target / "frames/K01.png"), parked["approved_frames"]["K01"])
        with self.assertRaises(ValueError):
            tool.init("M02", self.root / "plan/batches/M02-attempt-02", root=self.root)
            tool.park(self.root / "plan/batches/M02-attempt-02", self.root)

    def test_duration_rules_allow_equality_only_when_configured(self):
        tool.init("M02", self.package, root=self.root)
        project_path = self.root / "plan/project.json"
        for rule, equality in [
            ("min_supported_strictly_greater_than_window", False),
            ("min_supported_not_less_than_window", True),
            ("exact_window", True),
        ]:
            with self.subTest(rule=rule):
                project_path.write_text(
                    json.dumps(
                        {
                            "generation": {
                                "video": {
                                    "provider": "kling",
                                    "resolution": "1080p",
                                    "aspect_ratio": "16:9",
                                    "watermark": False,
                                    "duration_rule": rule,
                                },
                                "image": None,
                            }
                        }
                    ),
                    encoding="utf-8",
                )
                if equality:
                    self.assertEqual(
                        tool.plan_keyframes(self.package, 3, root=self.root)["timing"]["request_seconds"], 3
                    )
                else:
                    with self.assertRaisesRegex(ValueError, "строго больше"):
                        tool.plan_keyframes(self.package, 3, root=self.root)
                with self.assertRaises(ValueError):
                    tool.plan_keyframes(self.package, 2, root=self.root)
                if rule == "exact_window":
                    with self.assertRaisesRegex(ValueError, "равняться"):
                        tool.plan_keyframes(self.package, 4, root=self.root)
                else:
                    self.assertEqual(
                        tool.plan_keyframes(self.package, 4, root=self.root)["timing"]["request_seconds"], 4
                    )
        # Дробное окно округляется вверх для правила «не меньше», но exact_window честно диагностируется.
        data = tool.load_workflow(self.package)
        data["timing"]["window_seconds"] = 3.1
        tool.save_workflow(self.package, data)
        project = json.loads(project_path.read_text())
        with self.assertRaisesRegex(ValueError, "целого монтажного окна"):
            tool.plan_keyframes(self.package, 4, root=self.root)
        project["generation"]["video"]["duration_rule"] = "min_supported_not_less_than_window"
        project_path.write_text(json.dumps(project))
        with self.assertRaisesRegex(ValueError, "не меньше"):
            tool.plan_keyframes(self.package, 3, root=self.root)
        self.assertEqual(tool.plan_keyframes(self.package, 4, root=self.root)["timing"]["request_seconds"], 4)
        project_path.write_text(json.dumps({}))
        data["timing"]["window_seconds"] = 3
        tool.save_workflow(self.package, data)
        with self.assertRaisesRegex(ValueError, "строго больше"):
            tool.plan_keyframes(self.package, 3, root=self.root)

    def test_replanning_keeps_unchanged_approved_frames_and_detects_drift(self):
        tool.init("M02", self.package, "frame", self.root)
        tool.plan_keyframes(self.package, 4, root=self.root)
        tool.approve(self.package, "K01", self.frame, self.root)
        data = tool.plan_keyframes(self.package, 5, [(2.0, "середина")], self.root)
        self.assertTrue(data["keyframes"][0]["approved"])
        self.assertFalse(data["keyframes"][2]["approved"])
        self.assertEqual(data["current_keyframe"], "K02")
        (self.package / "frames/K01.png").write_bytes(b"other bytes")
        self.assertIn("K01: байты опоры изменились после принятия", tool.report(self.package, self.root)["problems"])
        self.registry["scenes"][0]["state_changes"]["before"]["mira"]["position"] = "в кабине"
        self.write_registry()
        self.assertTrue(
            any("изменились после подготовки" in p for p in tool.report(self.package, self.root)["problems"])
        )

    def test_batch_name_is_recorded_and_validated(self):
        data = tool.init("M01", self.package, root=self.root, batch="final-chorus-01")
        self.assertEqual(data["batch"], "final-chorus-01")
        self.assertIn("партия final-chorus-01", tool.table(tool.report(self.package, self.root)))
        with self.assertRaises(ValueError):
            tool.init("M02", self.root / "plan/batches/M02-attempt-01", root=self.root, batch="партия 1")

    def test_retry_keeps_previous_package_and_rejects_other_shot(self):
        tool.init("M02", self.package, root=self.root)
        original = (self.package / "workflow.json").read_bytes()
        retry = self.root / "plan/batches/M02-attempt-02"
        data = tool.init("M02", retry, root=self.root, retry_of=self.package)
        self.assertEqual(data["retry_of"], "plan/batches/M02-attempt-01")
        self.assertEqual((self.package / "workflow.json").read_bytes(), original)
        wrong = self.root / "plan/batches/M01-attempt-02"
        with self.assertRaises(ValueError):
            tool.init("M01", wrong, root=self.root, retry_of=self.package)
        self.assertFalse(wrong.exists())

    def test_transitions_follow_single_vocabulary(self):
        tool.init("M01", self.package, root=self.root)
        with self.assertRaises(ValueError):
            tool.set_stage(self.package, "prompt_review", root=self.root)
        with self.assertRaises(ValueError):
            tool.set_stage(self.package, "ready", root=self.root)
        data = tool.set_stage(self.package, "needs_revision", wait_reason="insufficient_balance", root=self.root)
        self.assertEqual((data["stage"], data["wait_reason"]), ("needs_revision", "insufficient_balance"))
        data = tool.set_stage(self.package, "keyframes_review", root=self.root)
        self.assertEqual((data["stage"], data["wait_reason"]), ("keyframes_review", None))
        self.assertTrue(tool.allowed_transition("request_choice", "submitted"))
        self.assertTrue(tool.allowed_transition("downloaded", "accepted"))
        self.assertFalse(tool.allowed_transition("submitted", "accepted"))
        with self.assertRaises(ValueError):
            tool.package_dir(self.root / "plan/batches", self.root, exist=False)
        with self.assertRaises(ValueError):
            tool.package_dir(self.root / "assets/shots/M01", self.root, exist=False)


if __name__ == "__main__":
    unittest.main()
