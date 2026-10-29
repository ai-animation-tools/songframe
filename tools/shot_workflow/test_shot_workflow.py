"""Этапы, опоры, промпт и перенос пакета в очередь на временной фикстуре; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import os
import subprocess
import tempfile
import unittest
import unittest.mock

from tools.lint_registry import lint_registry
from tools.shot_workflow import shot_workflow as tool
from tools.testing import fake_media_request as fake

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
        (self.root / "plan/project.json").write_text(json.dumps({"schema_version": 1, **GENERATION}))

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
        (request_dir / "request.json").write_text(json.dumps({"provider": "test"}))
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

    def test_prompt_warning_limit_comes_from_video_provider_adapter(self):
        tool.init("M02", self.package, root=self.root)
        tool.plan_keyframes(self.package, 4, root=self.root)
        for keyframe in ("K01", "K02"):
            tool.approve(self.package, keyframe, self.frame, self.root)
        (self.package / "video-prompt.txt").write_text("Длинный промпт плана.", encoding="utf-8")
        # Провайдер без адаптера или адаптер без предела: предупреждения нет.
        self.assertEqual(tool.approve_prompt(self.package, root=self.root)[1], [])
        fake.enable(self)
        self.assertEqual(tool.approve_prompt(self.package, root=self.root)[1], [])
        with unittest.mock.patch.object(fake, "PROMPT_WARNING_CHARS", 10, create=True):
            warnings = tool.approve_prompt(self.package, root=self.root)[1]
        self.assertEqual(warnings, ["Промпт длиннее 10 символов (21)."])

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
                                    "provider": "test",
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
        # Проект без блока generation не читается по прежнему правилу: нужна явная настройка видео.
        project_path.write_text(json.dumps({}))
        data["timing"]["window_seconds"] = 3
        tool.save_workflow(self.package, data)
        with self.assertRaisesRegex(ValueError, "generation.video"):
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

    def keyframe_package(self, candidates=("K01", "K02")):
        """Пакет с тремя опорами и кандидатами для указанных опор."""
        tool.init("M02", self.package, root=self.root)
        tool.plan_keyframes(self.package, 4, [(2.0, "середина")], self.root)
        for frame in candidates:
            source = self.root / f"{frame}.png"
            source.write_bytes(frame.encode())
            tool.propose(self.package, frame, source, self.root)

    def test_init_writes_empty_notes_and_old_format_is_rejected(self):
        data = tool.init("M02", self.package, root=self.root)
        self.assertEqual(data["keyframe_notes"], [])
        stored = json.loads((self.package / "workflow.json").read_text(encoding="utf-8"))
        del stored["keyframe_notes"]
        (self.package / "workflow.json").write_text(json.dumps(stored), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "keyframe_notes"):
            tool.load_workflow(self.package)

    def test_ask_about_single_keyframe(self):
        self.keyframe_package()
        data = tool.ask(self.package, "keyframes_review", root=self.root, frame="K02")
        pending = data["pending_decision"]
        self.assertEqual(
            (pending["question"], pending["options"], pending["frame"]),
            ("Утвердить опору K02?", ["approve", "revise"], "K02"),
        )
        with self.assertRaisesRegex(ValueError, "нет кандидата"):
            tool.ask(self.package, "keyframes_review", root=self.root, frame="K03")
        with self.assertRaisesRegex(ValueError, "не входит в план"):
            tool.ask(self.package, "keyframes_review", root=self.root, frame="K09")
        with self.assertRaisesRegex(ValueError, "keyframes_review"):
            tool.ask(self.package, "prompt_review", root=self.root, frame="K01")
        # Без --frame вопрос прежний и поля frame нет.
        data = tool.ask(self.package, "keyframes_review", root=self.root)
        self.assertEqual(data["pending_decision"]["question"], "Утвердить опоры?")
        self.assertNotIn("frame", data["pending_decision"])
        tool.ask(self.package, "keyframes_review", root=self.root, frame="K01")
        tool.decide(self.package, "approve", root=self.root)
        with self.assertRaisesRegex(ValueError, "уже утверждена"):
            tool.ask(self.package, "keyframes_review", root=self.root, frame="K01")

    def test_approve_single_keyframe_keeps_other_candidates(self):
        self.keyframe_package()
        tool.ask(self.package, "keyframes_review", root=self.root, frame="K02")
        data = tool.decide(self.package, "approve", root=self.root)
        frames = {k["id"]: k for k in data["keyframes"]}
        self.assertTrue(frames["K02"]["approved"])
        self.assertFalse(frames["K01"]["approved"])
        self.assertEqual(frames["K01"]["path"], "frames/K01.png")
        self.assertEqual(data["approved_frames"], {"K02": frames["K02"]["sha256"]})
        self.assertEqual((data["decision"]["verdict"], data["pending_decision"]), ("approve", None))
        # Изменённый файл кандидата не принимается.
        tool.ask(self.package, "keyframes_review", root=self.root, frame="K01")
        (self.package / "frames/K01.png").write_bytes(b"other")
        with self.assertRaisesRegex(ValueError, "изменён"):
            tool.decide(self.package, "approve", root=self.root)
        self.assertFalse(tool.load_workflow(self.package)["keyframes"][0]["approved"])

    def test_revise_single_keyframe_records_note_with_scope(self):
        self.keyframe_package()
        tool.ask(self.package, "keyframes_review", root=self.root, frame="K02")
        data = tool.decide(self.package, "revise", note="  Фонарь левее  ", root=self.root, note_scope="frame")
        frames = {k["id"]: k for k in data["keyframes"]}
        self.assertEqual(
            (frames["K02"]["path"], frames["K02"]["sha256"], frames["K02"]["approved"]), (None, None, False)
        )
        self.assertEqual(frames["K01"]["path"], "frames/K01.png")
        self.assertTrue((self.package / "frames/K02.png").is_file())
        [note] = data["keyframe_notes"]
        self.assertEqual(
            {key: note[key] for key in ("id", "frame", "note", "scope", "active")},
            {"id": 1, "frame": "K02", "note": "Фонарь левее", "scope": "frame", "active": True},
        )
        self.assertTrue(note["at"])
        # По умолчанию замечание распространяется на следующие опоры; пустое не записывается.
        tool.ask(self.package, "keyframes_review", root=self.root, frame="K01")
        data = tool.decide(self.package, "revise", note="Теплее свет", root=self.root)
        last = data["keyframe_notes"][-1]
        self.assertEqual((last["id"], last["frame"], last["scope"]), (2, "K01", "following"))
        self.propose_again("K01")
        tool.ask(self.package, "keyframes_review", root=self.root, frame="K01")
        data = tool.decide(self.package, "revise", note=" ", root=self.root)
        self.assertEqual(len(data["keyframe_notes"]), 2)
        # Ответ без опоры снимает всех неутверждённых и пишет замечание с frame=null.
        self.propose_again("K01")
        tool.ask(self.package, "keyframes_review", root=self.root)
        data = tool.decide(self.package, "revise", note="Общий тон", root=self.root)
        self.assertEqual((data["keyframe_notes"][-1]["frame"], data["keyframe_notes"][-1]["id"]), (None, 3))
        self.assertTrue(all(k["path"] is None for k in data["keyframes"]))
        with self.assertRaises(ValueError):
            tool.decide(self.package, "revise", note="x", root=self.root, note_scope="all")

    def propose_again(self, frame):
        source = self.root / f"{frame}-again.png"
        source.write_bytes(b"again " + frame.encode())
        tool.propose(self.package, frame, source, self.root)

    def approve_all(self):
        self.keyframe_package(("K01", "K02", "K03"))
        tool.ask(self.package, "keyframes_review", root=self.root)
        return tool.decide(self.package, "approve", root=self.root)

    def test_reopen_returns_approved_keyframe_with_note(self):
        self.approve_all()
        with self.assertRaisesRegex(ValueError, "замечание"):
            tool.reopen(self.package, "K02", " ", root=self.root)
        data = tool.reopen(self.package, "K02", "Руки в кадре", "frame", root=self.root)
        frame = data["keyframes"][1]
        self.assertEqual((frame["approved"], frame["path"], frame["sha256"]), (False, None, None))
        self.assertNotIn("K02", data["approved_frames"])
        self.assertEqual(set(data["approved_frames"]), {"K01", "K03"})
        self.assertEqual(
            (data["stage"], data["pending_decision"], data["current_keyframe"]), ("keyframes_review", None, "K02")
        )
        self.assertEqual(
            {key: data["decision"][key] for key in ("stage", "verdict", "note")},
            {"stage": "keyframes_review", "verdict": "revise", "note": "Руки в кадре"},
        )
        self.assertEqual((data["prompt"]["approved"], data["approved_prompt_sha256"]), (False, None))
        self.assertEqual(data["keyframe_notes"][-1]["frame"], "K02")
        self.assertTrue((self.package / "frames/K02.png").is_file())
        with self.assertRaisesRegex(ValueError, "не утверждена"):
            tool.reopen(self.package, "K02", "Ещё раз", root=self.root)

    def test_reopen_is_refused_after_prompt_approval_or_request(self):
        self.approve_all()
        (self.package / "video-prompt.txt").write_text("Один план.", encoding="utf-8")
        tool.approve_prompt(self.package, root=self.root)
        before = (self.package / "workflow.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "Видеопромпт уже утверждён"):
            tool.reopen(self.package, "K01", "Другой ракурс", root=self.root)
        self.assertEqual((self.package / "workflow.json").read_bytes(), before)
        data = tool.load_workflow(self.package)
        data["prompt"]["approved"] = False
        data["request_dir"] = "request"
        tool.save_workflow(self.package, data)
        with self.assertRaisesRegex(ValueError, "запрос подготовлен"):
            tool.reopen(self.package, "K01", "Другой ракурс", root=self.root)

    def test_set_note_toggles_activity_and_show_lists_active_notes(self):
        self.keyframe_package()
        tool.ask(self.package, "keyframes_review", root=self.root, frame="K01")
        tool.decide(self.package, "revise", note="Без тумана", root=self.root)
        self.assertIn("Без тумана", tool.table(tool.report(self.package, self.root)))
        data = tool.set_note(self.package, 1, False, self.root)
        self.assertFalse(data["keyframe_notes"][0]["active"])
        info = tool.report(self.package, self.root)
        self.assertEqual(info["keyframe_notes"][0]["note"], "Без тумана")
        self.assertNotIn("Без тумана", tool.table(info))
        self.assertTrue(tool.set_note(self.package, 1, True, self.root)["keyframe_notes"][0]["active"])
        with self.assertRaisesRegex(ValueError, "Замечания 7 нет"):
            tool.set_note(self.package, 7, True, self.root)

    def test_cli_keyframe_commands(self):
        self.keyframe_package()
        script = str(Path(__file__).with_name("shot_workflow.py"))
        env = {**os.environ, "SONGFRAME_PROJECT": str(self.root)}

        def run(*args):
            return subprocess.run(
                [sys.executable, "-B", script, *args, "--dir", str(self.package)],
                env=env,
                capture_output=True,
                text=True,
            )

        self.assertEqual(run("ask", "--stage", "keyframes_review", "--frame", "K01").returncode, 0)
        result = run("decide", "--verdict", "revise", "--note", "Ниже горизонт", "--note-scope", "frame")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(run("set-note", "--id", "1", "--active", "false").returncode, 0)
        shown = json.loads(run("show", "--json").stdout)
        self.assertEqual((shown["keyframe_notes"][0]["scope"], shown["keyframe_notes"][0]["active"]), ("frame", False))
        tool.ask(self.package, "keyframes_review", root=self.root, frame="K02")
        tool.decide(self.package, "approve", root=self.root)
        result = run("reopen", "K02", "--note", "Без бликов")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(tool.load_workflow(self.package)["keyframe_notes"][-1]["scope"], "following")
        self.assertNotEqual(run("reopen", "K02", "--note", "").returncode, 0)

    def test_workflow_schema_describes_notes_and_frame_question(self):
        schema = lint_registry.load_schema("workflow")
        self.keyframe_package()
        tool.ask(self.package, "keyframes_review", root=self.root, frame="K01")
        tool.decide(self.package, "revise", note="Мягче тени", root=self.root, note_scope="frame")
        tool.ask(self.package, "keyframes_review", root=self.root, frame="K02")
        data = tool.load_workflow(self.package)
        self.assertEqual(lint_registry.validate(data, schema), [])
        broken = json.loads(json.dumps(data))
        broken["keyframe_notes"][0]["scope"] = "all"
        broken["pending_decision"]["frame"] = "кадр"
        errors = lint_registry.validate(broken, schema)
        self.assertTrue(any(".keyframe_notes[0].scope" in e for e in errors), errors)
        self.assertTrue(any(".pending_decision.frame" in e for e in errors), errors)
        del broken["keyframe_notes"]
        self.assertIn("$: нет обязательного поля keyframe_notes", lint_registry.validate(broken, schema))

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
