"""Тесты протокола согласований с приложением: кандидаты опор, вопрос, ответ, ожидание."""

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


class DecisionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "plan/batches").mkdir(parents=True)
        (self.root / "plan/scenes.json").write_text(json.dumps(SCENES, ensure_ascii=False))
        (self.root / "plan/project.json").write_text(
            json.dumps({"schema_version": 1, "name": "Т", "animatic_video": "t.mp4"})
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

    def test_init_records_owner_before_later_preparation(self):
        """Ошибка подготовки после init не должна превращать пакет приложения во внешний."""
        package = self.root / "plan/batches/M01-attempt-app"
        created = tool.init("M01", package, root=self.root, executor="app")
        self.assertEqual(created["executor"], "app")
        self.assertEqual(json.loads((package / "workflow.json").read_text())["executor"], "app")
        self.assertEqual(self.workflow()["executor"], "agent")
        with self.assertRaisesRegex(ValueError, "Исполнитель"):
            tool.init("M01", self.root / "plan/batches/M01-invalid", root=self.root, executor="other")

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

    def test_executor_is_owned_by_app_or_agent_without_changing_stage_or_submitting(self):
        for executor in ("agent", "app"):
            with self.subTest(executor=executor):
                stage = self.workflow()["stage"]
                tool.ask(self.package, "request_choice", root=self.root, executor=executor)
                data = self.workflow()
                self.assertEqual(data["executor"], executor)
                self.assertEqual(data["pending_decision"]["executor"], executor)
                # Решение send лишь записывается: платная отправка остаётся отдельной операцией владельца.
                with (
                    patch.object(subprocess, "run", side_effect=AssertionError("Недопустимая отправка")),
                    patch.object(subprocess, "Popen", side_effect=AssertionError("Недопустимая отправка")),
                ):
                    data = tool.decide(self.package, "send", root=self.root)
                self.assertEqual(data["stage"], stage)
                self.assertEqual(data["executor"], executor)
                self.assertEqual(data["decision"]["verdict"], "send")
                self.assertIsNone(data["request_dir"])
                self.assertFalse((self.package / "request").exists())
        # Старый Python-вызов с positional root сохраняется; отсутствие executor читается как agent.
        data = self.workflow()
        del data["executor"]
        tool.save_workflow(self.package, data)
        self.assertEqual(tool.report(self.package, self.root)["executor"], "agent")
        data = tool.ask(self.package, "request_choice", None, None, self.root)
        self.assertEqual(data["executor"], "agent")
        self.assertEqual(data["pending_decision"]["executor"], "agent")
        with self.assertRaisesRegex(ValueError, "Исполнитель"):
            tool.ask(self.package, "request_choice", root=self.root, executor="unknown")

    def test_cli_executor_defaults_to_agent_and_accepts_app(self):
        tool_ask = tool.ask
        for executor in (None, "app"):
            argv = ["shot_workflow.py", "ask", "--dir", str(self.package), "--stage", "description_review"]
            if executor:
                argv += ["--executor", executor]
            with (
                patch.object(sys, "argv", argv),
                patch.object(
                    tool,
                    "ask",
                    wraps=lambda directory, stage, question, options, **kwargs: tool_ask(
                        directory, stage, question, options, self.root, **kwargs
                    ),
                ),
            ):
                tool.main()
            self.assertEqual(self.workflow()["executor"], executor or "agent")

    def test_revise_keeps_stage_and_wait_returns_decision_or_timeout(self):
        tool.propose(self.package, "K01", self.root / "k1.png", root=self.root)
        tool.ask(self.package, "keyframes_review", root=self.root)
        clock = iter([0, 1, 2, 3, 100])
        code, decision = tool.wait(
            self.package, timeout=10, interval=0, root=self.root, sleep=lambda _s: None, clock=lambda: next(clock)
        )
        self.assertEqual((code, decision), (2, None))
        tool.decide(self.package, "revise", note="Убрать лишнюю руку", root=self.root)
        code, decision = tool.wait(
            self.package, timeout=10, interval=0, root=self.root, sleep=lambda _s: None, clock=lambda: 0
        )
        self.assertEqual(code, 0)
        self.assertEqual(
            (decision["verdict"], decision["note"], decision["stage"]),
            ("revise", "Убрать лишнюю руку", "keyframes_review"),
        )
        self.assertEqual(self.workflow()["stage"], "keyframes_review")
        self.assertFalse(self.workflow()["keyframes"][0]["approved"])
        with self.assertRaisesRegex(ValueError, "Варианты ответа"):
            tool.ask(self.package, "downloaded", options=["bogus"], root=self.root)
        tool.ask(self.package, "description_review", root=self.root)
        self.assertEqual(self.workflow()["stage"], "keyframes_review")

        # Этап меняется снаружи во время ожидания (агент принял опоры и промпт): wait сравнивает этап
        # с тем, что был на старте, и завершается кодом 3.
        def advance(_seconds):
            tool.approve(self.package, "K01", self.root / "k1.png", root=self.root)
            tool.approve(self.package, "K02", self.root / "k2.png", root=self.root)
            (self.package / "video-prompt.txt").write_text("Промпт", encoding="utf-8")
            tool.approve_prompt(self.package, root=self.root)
            tool.set_stage(self.package, "prompt_review", root=self.root)

        code, decision = tool.wait(self.package, timeout=10, interval=0, root=self.root, sleep=advance, clock=lambda: 0)
        self.assertEqual(code, 3)
        self.assertEqual(decision["stage"], "prompt_review")
        report = tool.report(self.package, root=self.root)
        self.assertEqual(report["pending_decision"]["stage"], "description_review")


if __name__ == "__main__":
    unittest.main()
