"""Обновление, проверка и снимок Git представлений на временном проекте; @link README.md"""

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
from unittest.mock import patch

from PIL import Image

from tools.project_views.project_views import Sources
from tools.update_scene_views.update_scene_views import approved_keyframes, check_snapshot, main, update


class UpdateSceneViewsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="views-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        # Представления читают и пишут только временный проект, не рабочий репозиторий.
        for target in ("tools.project_views.project_views.ROOT", "tools.update_scene_views.update_scene_views.ROOT"):
            patcher = patch(target, self.root)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name in ("source/heroes", "plan/audio", "plan/context", "plan/awaiting"):
            (self.root / name).mkdir(parents=True)
        Image.new("RGB", (320, 200), "red").save(self.root / "source/heroes/mira.png")
        (self.root / "plan/project.json").write_text(
            json.dumps({"schema_version": 1, "name": "Тест", "animatic_video": "test.mp4"})
        )
        self.registry = {
            "schema_version": 1,
            "fps": 30,
            "audio": {"path": "source/track.mp3", "end_seconds": "10"},
            "visual_direction": "Общие правила.",
            "references": {"П": {"path": "source/heroes/mira.png", "name": "Мира", "short_name": "Мира"}},
            "sequences": [{"id": "intro", "title": "Вступление", "direction": "Направление."}],
            "scenes": [
                {
                    "id": sid,
                    "original": sid,
                    "sequence": "intro",
                    "start_frame": start,
                    "end_frame_exclusive": start + 150,
                    "camera": "Статика",
                    "action": "Мира сидит у костра.",
                    "continuity": "Без изменений.",
                    "references": ["П"],
                    "card": {"primary_reference": "П"},
                    "state_from": None if sid == "M01" else "M01",
                    "state_changes": {},
                }
                for sid, start in (("M01", 0), ("M02", 150))
            ],
        }
        self.write_registry()
        (self.root / "plan/production-status.json").write_text(
            json.dumps({"schema_version": 1, "current_animatic": "plan/animatic/latest/manifest.json", "shots": {}})
        )
        (self.root / "plan/audio/timing.json").write_text(
            json.dumps({"status": "Оценка.", "sections": [], "lines": []})
        )
        self.git("init", "-q")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "фикстура")

    def write_registry(self):
        (self.root / "plan/scenes.json").write_text(json.dumps(self.registry, ensure_ascii=False))

    def git(self, *args):
        return subprocess.check_output(
            [
                "git",
                "-C",
                str(self.root),
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "-c",
                "commit.gpgsign=false",
                *args,
            ]
        ).decode()

    def queue_package(self, approved=True, stage="prompt_review"):
        folder = self.root / "plan/awaiting/M02"
        (folder / "frames").mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (640, 360), "blue").save(folder / "frames/K01.png")
        Image.new("RGB", (640, 360), "green").save(folder / "frames/K02.png")
        (folder / "workflow.json").write_text(
            json.dumps(
                {
                    "shot": "M02",
                    "stage": stage,
                    "keyframes": [
                        {"id": "K01", "role": "first", "time_seconds": 0, "approved": True, "path": "frames/K01.png"},
                        {
                            "id": "K02",
                            "role": "last",
                            "time_seconds": 5,
                            "approved": approved,
                            "path": "frames/K02.png",
                        },
                    ],
                }
            )
        )
        return folder

    def cli(self, *args):
        return subprocess.run(
            [
                sys.executable,
                "-B",
                str(Path(__file__).with_name("update_scene_views.py")),
                "--project",
                str(self.root),
                *args,
            ],
            capture_output=True,
            text=True,
        )

    def test_missing_inputs_exit_with_short_message_without_traceback(self):
        """Новый или неполный проект не порождает traceback и производные файлы."""
        for name in ("plan/scenes.json", "plan/project.json", "plan/production-status.json", "plan/audio/timing.json"):
            path = self.root / name
            original = path.read_bytes()
            path.unlink()
            for args in ((), ("--check",)):
                with self.subTest(name=name, args=args):
                    result = self.cli(*args)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")
                    self.assertIn(f"Нет обязательного файла: {name}.", result.stderr)
                    self.assertEqual(len(result.stderr.splitlines()), 1)
                    self.assertNotIn("Traceback", result.stderr)
                    self.assertFalse((self.root / "ROADMAP.md").exists())
                    self.assertFalse((self.root / "plan/animatic").exists())
            path.write_bytes(original)

    def test_missing_registry_in_index_is_reported_without_traceback(self):
        (self.root / "plan/scenes.json").unlink()
        self.git("add", "-u")
        result = self.cli("--check", "--staged")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Нет обязательного файла: plan/scenes.json.", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_cli_keeps_successful_check_and_unexpected_error_diagnostics(self):
        update()
        result = self.cli("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "Представления актуальны.")
        self.assertEqual(result.stderr, "")
        # Общий ValueError может означать ошибку программы: перехватывать его целиком нельзя.
        with (
            patch.object(sys, "argv", ["update_scene_views.py"]),
            patch("tools.update_scene_views.update_scene_views.update", side_effect=ValueError("Ошибка программы")),
        ):
            with self.assertRaisesRegex(ValueError, "Ошибка программы"):
                main()

    def test_working_views_without_git_still_detect_drift(self):
        """Отсутствие Git не заменяет проверку рабочих документов фиктивным успехом."""
        with patch.dict(os.environ, {"PATH": ""}):
            update()
            self.assertEqual(update(check=True), [])
            self.registry["scenes"][0]["action"] = "Мира встаёт."
            self.write_registry()
            self.assertIn("plan/storyboard.md", update(check=True))
            with self.assertRaisesRegex(ValueError, "установите Git"):
                Sources(":")

    def test_update_writes_views_once_and_check_reports_only_drift(self):
        self.assertTrue(update(check=True))
        self.assertFalse((self.root / "ROADMAP.md").exists())
        update()
        for name in (
            "ROADMAP.md",
            "plan/storyboard.md",
            "plan/edit-list.md",
            "plan/context/characters.md",
            "assets/shots/manifest.json",
            "plan/animatic/cards/M01.png",
            "plan/animatic/cards/manifest.json",
        ):
            self.assertTrue((self.root / name).is_file(), name)
        self.assertEqual(update(check=True), [])
        self.registry["scenes"][0]["action"] = "Мира встаёт."
        self.write_registry()
        drift = update(check=True)
        self.assertIn("plan/storyboard.md", drift)
        self.assertIn("plan/animatic/cards/manifest.json", drift)
        self.assertFalse("Мира встаёт." in (self.root / "plan/storyboard.md").read_text())

    def test_only_project_name_changes_cards_and_working_documents(self):
        # Две реальные карточки сохраняют зависимость от названия и референса,
        # но не от настроек следующей генерации или оформления JSON.
        update()
        path = self.root / "plan/project.json"
        project = json.loads(path.read_text())
        receipt = json.loads((self.root / "plan/animatic/cards/manifest.json").read_text())
        self.assertEqual(receipt["project_inputs"], {"name": "Тест"})
        self.assertEqual(len(receipt["cards"]), 2)
        for generation in (
            {"video": {"provider": "test"}},
            {"video": {"model": "другая модель", "provider_selected": True, "options": {"duration": 5}}},
            {"image": {"provider": "codex", "model": "новая"}},
            None,
        ):
            with self.subTest(generation=generation):
                project["generation"] = generation
                project["animatic_video"] = "другое.mp4"
                path.write_text(json.dumps(project, ensure_ascii=False, indent=4))
                self.assertEqual(update(check=True), [])
                self.git("add", "-A")
                self.assertEqual(check_snapshot(Sources(":")), [])
        project["name"] = "Новое имя"
        path.write_text(json.dumps(project))
        changed = update(check=True)
        self.assertIn("plan/storyboard.md", changed)
        self.assertIn("plan/animatic/cards/manifest.json", changed)
        self.assertIn("plan/animatic/cards/M01.png", changed)
        update()
        Image.new("RGB", (320, 200), "green").save(self.root / "source/heroes/mira.png")
        changed = update(check=True)
        self.assertIn("plan/animatic/cards/manifest.json", changed)
        self.assertIn("plan/animatic/cards/M01.png", changed)

    def test_missing_or_invalid_project_inputs_require_fresh_cards(self):
        update()
        path = self.root / "plan/animatic/cards/manifest.json"
        original = json.loads(path.read_text())
        for malformed in (None, [], {"name": 1}, {"name": "Тест", "extra": "лишнее"}, "missing"):
            with self.subTest(project_inputs=malformed):
                receipt = dict(original, project_inputs=malformed)
                if malformed == "missing":
                    receipt.pop("project_inputs")
                path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
                self.assertIn("plan/animatic/cards/manifest.json", update(check=True))
                self.git("add", "-A")
                self.assertIn("plan/animatic/cards/manifest.json", check_snapshot(Sources(":")))

    def test_approved_keyframes_make_transition_card_and_leave_with_package(self):
        self.queue_package(approved=False)
        self.assertIsNone(approved_keyframes(self.root, "M02"))
        update()
        self.assertFalse((self.root / "plan/animatic/cards/M02.last.png").exists())
        self.queue_package()
        keyframes = approved_keyframes(self.root, "M02")
        self.assertEqual([k["id"] for k in keyframes], ["K01", "K02"])
        self.assertEqual(keyframes[1]["path"], "plan/awaiting/M02/frames/K02.png")
        update()
        receipt = json.loads((self.root / "plan/animatic/cards/manifest.json").read_text())
        self.assertEqual(receipt["cards"]["M02"]["last"]["path"], "plan/animatic/cards/M02.last.png")
        self.assertEqual([k["id"] for k in receipt["cards"]["M02"]["keyframes"]], ["K01", "K02"])
        self.assertTrue((self.root / "plan/animatic/cards/M02.last.png").is_file())
        self.assertNotIn("last", receipt["cards"]["M01"])
        self.assertEqual(update(check=True), [])
        # Принятый пакет больше не считается планом опор: карточка последней опоры удаляется.
        self.queue_package(stage="accepted")
        self.assertIsNone(approved_keyframes(self.root, "M02"))
        self.assertIn("plan/animatic/cards/M02.last.png", update(check=True))
        update()
        self.assertFalse((self.root / "plan/animatic/cards/M02.last.png").exists())
        self.assertNotIn(
            "last", json.loads((self.root / "plan/animatic/cards/manifest.json").read_text())["cards"]["M02"]
        )

    def accept_package(self, sid):
        folder = self.root / "assets/shots" / sid
        folder.mkdir(parents=True)
        for name in ("original.mp4", "video.mp4", "prompt.txt"):
            (folder / name).write_bytes(("Файл " + name).encode())
        (folder / "manifest.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "shot": sid,
                    "generation": {
                        "original": {"path": "original.mp4"},
                        "prompt": {"path": "prompt.txt"},
                        "inputs": [],
                        "lipsync": False,
                    },
                    "accepted_edit": {"video": {"path": "video.mp4"}, "fps": 30, "frames": 150},
                }
            )
        )

    def test_card_of_accepted_shot_is_removed_and_reported(self):
        update()
        card = self.root / "plan/animatic/cards/M02.png"
        self.assertTrue(card.is_file())
        # Появился комплект сцены: карточка больше не нужна, проверка называет её устаревшей.
        self.accept_package("M02")
        drift = update(check=True)
        self.assertIn("plan/animatic/cards/M02.png", drift)
        self.assertTrue(card.is_file())
        update()
        self.assertFalse(card.exists())
        self.assertTrue((self.root / "plan/animatic/cards/M01.png").is_file())
        self.assertEqual(
            set(json.loads((self.root / "plan/animatic/cards/manifest.json").read_text())["cards"]), {"M01"}
        )
        self.assertEqual(update(check=True), [])
        # Снимок Git: забытая карточка в индексе обнаруживается без перерисовки.
        Image.new("RGB", (1280, 720), "blue").save(card)
        self.git("add", "-A")
        self.assertEqual(check_snapshot(Sources(":")), ["plan/animatic/cards/M02.png"])
        card.unlink()
        self.git("add", "-A")
        self.assertEqual(check_snapshot(Sources(":")), [])

    def test_snapshot_check_reads_index_and_commit_without_rerendering(self):
        self.queue_package()
        update()
        self.git("add", "-A")
        self.assertEqual(check_snapshot(Sources(":")), [])
        self.git("commit", "-q", "-m", "представления")
        self.assertEqual(check_snapshot(Sources("HEAD")), [])
        # Изменённая постановка в индексе без перегенерации: снимок устарел, коммит остаётся актуальным.
        self.registry["scenes"][1]["action"] = "Мира уходит."
        self.write_registry()
        self.git("add", "plan/scenes.json")
        drift = check_snapshot(Sources(":"))
        self.assertIn("plan/storyboard.md", drift)
        self.assertIn("plan/animatic/cards/manifest.json", drift)
        self.assertEqual(check_snapshot(Sources("HEAD")), [])
        # Подменённая карточка опор в индексе обнаруживается по хешу без чтения пакета.
        self.git("checkout", "--", "plan/scenes.json")
        self.git("reset", "-q", "plan/scenes.json")
        Image.new("RGB", (1280, 720), "white").save(self.root / "plan/animatic/cards/M02.last.png")
        self.git("add", "plan/animatic/cards/M02.last.png")
        self.assertEqual(check_snapshot(Sources(":")), ["plan/animatic/cards/M02.last.png"])


if __name__ == "__main__":
    unittest.main()
