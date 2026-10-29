"""Тесты протокола согласований с приложением: кандидаты опор, вопрос и ответ."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.scene_registry import scene_registry
from tools.shot_workflow import shot_workflow as tool

SCENES = {
    "schema_version": 1,
    "fps": 30,
    "audio": {"path": "source/track.mp3", "end_seconds": "2"},
    "references": {"mira": {"name": "Мира", "path": "source/heroes/mira.png"}},
    "visual_direction": "правила",
    "sequences": [{"id": "s", "title": "С", "direction": ""}],
    "scenes": [
        {
            "id": "M01",
            "original": "",
            "sequence": "s",
            "start_frame": 0,
            "end_frame_exclusive": 60,
            "camera": "к",
            "action": "Едут",
            "continuity": "",
            "references": ["mira"],
            "lipsync": False,
            "card": {"primary_reference": "mira"},
            "state_from": None,
            "state_changes": {},
        }
    ],
}

# Блок generation.video выбранного проекта обязателен для плана опор.
GENERATION = {
    "generation": {
        "video": {
            "provider": "test",
            "resolution": "1080p",
            "aspect_ratio": "16:9",
            "watermark": False,
            "duration_rule": "min_supported_strictly_greater_than_window",
        },
        "image": None,
    }
}


class DecisionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "plan/batches").mkdir(parents=True)
        (self.root / "plan/scenes.json").write_text(json.dumps(SCENES, ensure_ascii=False))
        (self.root / "plan/project.json").write_text(
            json.dumps({"schema_version": 1, "name": "Т", "animatic_video": "t.mp4", **GENERATION})
        )
        scene_registry._INITIAL_CACHE.clear()
        for module in (scene_registry, tool):
            item = patch.object(module, "ROOT", self.root)
            item.start()
            self.addCleanup(item.stop)
        self.package = self.root / "plan/batches/M01-attempt-01"
        tool.init("M01", self.package, root=self.root)
        tool.plan_keyframes(self.package, 3, root=self.root)
        for name in ("k1.png", "k2.png"):
            (self.root / name).write_bytes(b"\x89PNG " + name.encode())

    def workflow(self):
        return json.loads((self.package / "workflow.json").read_text())

    def test_propose_ask_decide_approve_frames_and_prompt(self):
        tool.propose(self.package, "K01", self.root / "k1.png", root=self.root)
        tool.propose(self.package, "K02", self.root / "k2.png", root=self.root)
        data = self.workflow()
        self.assertEqual(data["stage"], "keyframes_review")
        self.assertFalse(any(k["approved"] for k in data["keyframes"]))
        self.assertTrue((self.package / "frames/K01.png").is_file())
        tool.ask(self.package, "keyframes_review", root=self.root)
        data = self.workflow()
        self.assertEqual(data["pending_decision"]["options"], ["approve", "revise"])
        self.assertIsNone(data["decision"])
        with self.assertRaisesRegex(ValueError, "допустимы ответы"):
            tool.decide(self.package, "send", root=self.root)
        tool.decide(self.package, "approve", root=self.root)
        data = self.workflow()
        self.assertTrue(all(k["approved"] for k in data["keyframes"]))
        self.assertEqual(set(data["approved_frames"]), {"K01", "K02"})
        self.assertEqual(data["decision"]["verdict"], "approve")
        self.assertIsNone(data["pending_decision"])
        # промпт: вопрос и принятие через решение
        (self.package / "video-prompt.txt").write_text("Промпт", encoding="utf-8")
        tool.ask(self.package, "prompt_review", question="Ок?", root=self.root)
        tool.decide(self.package, "approve", root=self.root)
        data = self.workflow()
        self.assertEqual(data["stage"], "prompt_review")
        self.assertTrue(data["prompt"]["approved"])
        self.assertIsNotNone(data["approved_prompt_sha256"])

    def test_send_is_recorded_without_changing_stage_or_submitting(self):
        stage = self.workflow()["stage"]
        data = tool.ask(self.package, "request_choice", root=self.root)
        self.assertNotIn("executor", data)
        self.assertNotIn("executor", data["pending_decision"])
        # Решение send лишь записывается: платную отправку выполняет приложение отдельной операцией.
        with (
            patch.object(subprocess, "run", side_effect=AssertionError("Недопустимая отправка")),
            patch.object(subprocess, "Popen", side_effect=AssertionError("Недопустимая отправка")),
        ):
            data = tool.decide(self.package, "send", root=self.root)
        self.assertEqual(data["stage"], stage)
        self.assertEqual(data["decision"]["verdict"], "send")
        self.assertIsNone(data["request_dir"])
        self.assertFalse((self.package / "request").exists())
        self.assertNotIn("executor", tool.report(self.package, self.root))

    def test_cli_ask_records_question(self):
        tool_ask = tool.ask
        argv = ["shot_workflow.py", "ask", "--dir", str(self.package), "--stage", "description_review"]
        with (
            patch.object(sys, "argv", argv),
            patch.object(
                tool,
                "ask",
                wraps=lambda directory, stage, question, options, frame=None: tool_ask(
                    directory, stage, question, options, self.root, frame
                ),
            ),
        ):
            tool.main()
        self.assertEqual(self.workflow()["pending_decision"]["stage"], "description_review")

    def test_revise_keeps_stage_and_records_note(self):
        tool.propose(self.package, "K01", self.root / "k1.png", root=self.root)
        tool.ask(self.package, "keyframes_review", root=self.root)
        data = tool.decide(self.package, "revise", note="Убрать лишнюю руку", root=self.root)
        decision = data["decision"]
        self.assertEqual(
            (decision["verdict"], decision["note"], decision["stage"]),
            ("revise", "Убрать лишнюю руку", "keyframes_review"),
        )
        self.assertIsNone(data["pending_decision"])
        self.assertEqual(self.workflow()["stage"], "keyframes_review")
        self.assertFalse(self.workflow()["keyframes"][0]["approved"])
        with self.assertRaisesRegex(ValueError, "Варианты ответа"):
            tool.ask(self.package, "downloaded", options=["bogus"], root=self.root)
        tool.ask(self.package, "description_review", root=self.root)
        self.assertEqual(self.workflow()["stage"], "keyframes_review")
        report = tool.report(self.package, root=self.root)
        self.assertEqual(report["pending_decision"]["stage"], "description_review")


if __name__ == "__main__":
    unittest.main()
