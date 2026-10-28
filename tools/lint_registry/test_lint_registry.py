"""Схемы, хроника в постановке, ссылки на референсы и состав снимков запроса на временной фикстуре; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import tempfile
import unittest
from unittest.mock import patch

from tools.lint_registry import lint_registry as tool
from tools.testing import fake_media_request as fake

SHA = "a" * 64


def scene(sid, start, end, action="Мира стоит у лодки.", continuity="Склейка на деталь."):
    return {
        "id": sid,
        "original": sid,
        "sequence": "s",
        "title": sid,
        "start_frame": start,
        "end_frame_exclusive": end,
        "camera": "статика",
        "action": action,
        "continuity": continuity,
        "references": ["П"],
        "lipsync": False,
        "card": {"primary_reference": "П"},
        "state_from": None,
        "state_changes": {},
    }


class LintRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lint-registry-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        fake.enable(self)
        for name in ("plan/awaiting", "plan/batches", "assets/shots/M01", "source"):
            (self.root / name).mkdir(parents=True)
        self.registry = {
            "schema_version": 1,
            "fps": 30,
            "audio": {"path": "source/track.mp3", "end_seconds": "2"},
            "references": {"П": {"name": "Мира", "path": "source/heroes/mira.jpg"}},
            "visual_direction": "# Правила\n\nШлем только у Миры.",
            "sequences": [{"id": "s", "title": "Сцена", "direction": "Общий план."}],
            "scenes": [scene("M01", 0, 30), scene("M02", 30, 60)],
        }
        self.snapshot = {
            "schema_version": 1,
            "shot": "M01",
            "service": "test",
            "command": "image_to_video",
            "model": "test-video",
            "parameters": {"duration": "2"},
            "inputs": [],
            "prompt": "generation-prompt.txt",
            "generation_id": "job-1",
        }
        self.manifest = {
            "schema_version": 1,
            "shot": "M01",
            "kind": "generated_video",
            "generation": {
                "source_shot": "M01",
                "original": {"path": "original.mp4", "sha256": SHA},
                "prompt": {"path": "p.txt", "sha256": SHA},
                "request": {"path": "generation-request.json", "sha256": SHA},
                "generation_id": "job-1",
                "inputs": [{"path": "in.png", "sha256": SHA}],
                "lipsync": False,
                "audio": None,
            },
            "accepted_edit": {
                "video": {"path": "video.mp4", "sha256": SHA},
                "fps": 30,
                "frames": 30,
                "duration_seconds": 1.0,
                "source_interval_seconds": [0, 1],
                "speed": {"factor": 1.0, "ratio": "1"},
                "hold_first_seconds": 0,
                "hold_last_seconds": 0,
                "rebuild": {
                    "stages": [{"input": "original.mp4", "filter": "fps=30", "frames": 30}],
                    "source": {"path": "original.mp4", "sha256": SHA},
                },
            },
        }
        (self.root / "source/description.md").write_text("Мира едет впереди.", encoding="utf-8")
        self.write()

    def write(self):
        (self.root / "plan/scenes.json").write_text(json.dumps(self.registry, ensure_ascii=False), encoding="utf-8")
        (self.root / "assets/shots/M01/manifest.json").write_text(
            json.dumps(self.manifest, ensure_ascii=False), encoding="utf-8"
        )
        (self.root / "assets/shots/M01/generation-request.json").write_text(
            json.dumps(self.snapshot, ensure_ascii=False), encoding="utf-8"
        )

    def messages(self, report):
        return [f"{i['where']}: {i['message']}" for i in report.errors], [
            f"{i['where']}: {i['message']}" for i in report.warnings
        ]

    def test_clean_fixture_has_no_errors_and_aliases_only_warn(self):
        errors, warnings = self.messages(tool.lint(self.root))
        self.assertEqual(errors, [])
        self.assertEqual(warnings, ["service: устаревшее имя поля; каноническое — provider"])

    def test_history_and_recipes_in_staging_are_errors_but_story_words_are_not(self):
        self.registry["scenes"][0]["action"] = (
            "Мира кивает; направление принято. Участок оригинала 2–8 с ускорен на 60/53 ≈ 1,13×."
        )
        self.registry["scenes"][1]["continuity"] = "Склейки приняты в пробе v04; клип в assets/shots/M02."
        self.registry["sequences"][0]["direction"] = (
            "Посадка читается без ускорения. "
            "[Подготовка](../assets/shots/M02/manifest.json). Границы — в "
            "[списке](edit-list.md)."
        )
        self.write()
        errors, warnings = self.messages(tool.lint(self.root))
        self.assertTrue(any(e.startswith("M01.action: технический рецепт") for e in errors))
        self.assertFalse(any("M01.action: факт принятия" in e for e in errors))
        self.assertTrue(any(e.startswith("M02.continuity: факт принятия") for e in errors))
        self.assertTrue(any(e.startswith("M02.continuity: путь в assets") for e in errors))
        self.assertTrue(any("sequences[s].direction: ссылка в assets" in e for e in errors))
        self.assertTrue(any("производное представление" in w for w in warnings))

    def test_schema_violations_and_reference_outside_source(self):
        self.registry["references"]["П"]["path"] = "assets/shots/M09/frame.png"
        self.registry["scenes"][0]["extra"] = 1
        del self.registry["scenes"][1]["lipsync"]
        self.registry["visual_direction"] += " Кузов из [кадра](../../assets/shots/M09/preparation/x.png)."
        self.write()
        errors, _ = self.messages(tool.lint(self.root))
        self.assertTrue(any("references.П.path" in e for e in errors))
        self.assertTrue(any("неизвестное поле extra" in e for e in errors))
        self.assertTrue(any("нет обязательного поля lipsync" in e for e in errors))
        self.assertTrue(any("референс-изображение в assets" in e for e in errors))

    def test_derived_from_schema_and_links_to_other_shots(self):
        def errors_for(**links):
            for item in self.registry["scenes"]:
                item.pop("derived_from", None)
                if item["id"] in links:
                    item["derived_from"] = links[item["id"]]
            self.write()
            return [e for e in self.messages(tool.lint(self.root))[0] if "derived_from" in e]

        self.assertEqual(errors_for(M02={"shot": "M01"}), [])
        self.assertEqual(errors_for(M02={"shot": "M99"}), ["M02.derived_from: ссылается на неизвестный план M99"])
        self.assertEqual(errors_for(M02={"shot": "M02"}), ["M02.derived_from: не может ссылаться на сам план"])
        self.assertEqual(
            errors_for(M01={"shot": "M02"}, M02={"shot": "M01"}),
            [
                "M01.derived_from: источник M02 сам собирается из другого плана; укажите исходный план",
                "M02.derived_from: источник M01 сам собирается из другого плана; укажите исходный план",
            ],
        )
        # Неверную форму сообщает схема, ссылочные правила её не дублируют.
        self.assertEqual(
            errors_for(M02={"shot": "2", "mode": "freeze"}),
            [
                "$.scenes[1].derived_from.shot: значение '2' не соответствует шаблону",
                "$.scenes[1].derived_from: неизвестное поле mode",
            ],
        )

    def test_snapshot_rules_and_packages(self):
        self.snapshot.update(created_at="2026-10-21T00:00:00", cost={"available_credits": 1})
        del self.snapshot["generation_id"]
        self.manifest["generation"]["inputs"] = []
        self.write()
        # Модельные предупреждения о снимке даёт только адаптер его провайдера.
        warning = [("parameters", "предупреждение адаптера о модели")]
        with patch.object(fake, "snapshot_warnings", side_effect=lambda snapshot: warning, create=True) as hook:
            errors, warnings = self.messages(tool.lint(self.root))
        self.assertEqual(hook.call_args.args[0]["model"], "test-video")
        self.assertTrue(any(e.startswith("created_at:") for e in errors) and any(e.startswith("cost:") for e in errors))
        self.assertTrue(any(e.startswith("generation_id:") for e in errors))
        self.assertTrue(any("generation.inputs: нужно не менее 1" in e for e in errors))
        self.assertIn("parameters: предупреждение адаптера о модели", warnings)
        del self.snapshot["service"]
        self.write()
        errors, _ = self.messages(tool.lint(self.root))
        self.assertIn("provider: снимок должен называть провайдера генерации", errors)
        package = self.root / "plan/awaiting/M02"
        (package / "request").mkdir(parents=True)
        (package / "workflow.json").write_text(
            json.dumps({"schema_version": 1, "shot": "M02", "stage": "prompt_review"})
        )
        (package / "request/request.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "kind": "video",
                    "provider": "test",
                    "command": "image_to_video",
                    "model": "test-video",
                    "parameters": {},
                    "outputs": 1,
                    "inputs": [],
                    "prompt": {"path": "prompt.txt", "sha256": SHA},
                }
            )
        )
        errors, _ = self.messages(tool.lint(self.root))
        self.assertTrue(any("stage: пакет в очереди" in e for e in errors))
        self.assertTrue(any("plan/awaiting/M02" in i["file"] for i in tool.lint(self.root).errors))

    def test_generic_frozen_request_has_explicit_provider_without_service_constraints(self):
        # Общая схема описывает хранимый запрос. Команду, модель, входные
        # флаги и ограничения числа результатов проверяет конкретный адаптер.
        package = self.root / "plan/batches/M02-generic"
        package.mkdir()
        request = {
            "schema_version": 1,
            "shot": "M02",
            "kind": "video",
            "provider": "CustomProvider",
            "command": "render.clip",
            "model": "Сервис v1",
            "model_selection": {"preferredModel": None, "selectedModel": "Сервис v1", "reason": "Совместима с запросом."},
            "parameters": {"profile": "custom"},
            "outputs": 12,
            "inputs": [{"flag": "referenceVideo", "path": "clip.mov", "sha256": SHA, "bytes": 1}],
            "prompt": {"path": "prompt.txt", "sha256": SHA},
        }
        path = package / "request.json"
        path.write_text(json.dumps(request), encoding="utf-8")
        errors, _ = self.messages(tool.lint(self.root))
        self.assertEqual(errors, [])
        schema = tool.load_schema("request")
        self.assertEqual(tool.validate(request | {"video_without_watermark": True}, schema), [])
        for provider in (None, "", " \n\t", 1):
            with self.subTest(provider=provider):
                invalid = request | {"provider": provider}
                if provider is None:
                    del invalid["provider"]
                path.write_text(json.dumps(invalid), encoding="utf-8")
                errors, _ = self.messages(tool.lint(self.root))
                self.assertTrue(any("provider" in error for error in errors))
        self.assertTrue(tool.validate(request | {"video_without_watermark": False}, schema))
        for selection in (
            {},
            {"preferredModel": "", "selectedModel": "Сервис v1", "reason": "Причина"},
            {"preferredModel": None, "selectedModel": " ", "reason": "Причина"},
            {"preferredModel": None, "selectedModel": "Сервис v1", "reason": " \n\t"},
            request["model_selection"] | {"extra": True},
        ):
            with self.subTest(selection=selection):
                self.assertTrue(tool.validate(request | {"model_selection": selection}, schema))

    def test_awaiting_image_stages_and_history_are_valid_but_malformed_history_is_not(self):
        package = self.root / "plan/awaiting/M02"
        package.mkdir(parents=True)
        path = package / "workflow.json"
        data = {
            "schema_version": 1,
            "shot": "M02",
            "stage": "image_request_choice",
            "request_dir": None,
            "image_request_dir": "image-01",
            "image_frame_id": "K01",
            "image_requests": [
                {
                    "frame_id": "K01",
                    "request_dir": "image-01",
                    "request_sha256": SHA,
                    "provider": "test",
                    "unknown": {"keep": True},
                }
            ],
        }
        for stage in ("image_request_choice", "image_submitted", "image_downloaded"):
            data["stage"] = stage
            path.write_text(json.dumps(data), encoding="utf-8")
            errors, _ = self.messages(tool.lint(self.root))
            self.assertEqual(errors, [], (stage, errors))
        data["image_requests"][0]["request_sha256"] = "invalid"
        path.write_text(json.dumps(data), encoding="utf-8")
        errors, _ = self.messages(tool.lint(self.root))
        self.assertTrue(any("image_requests[0].request_sha256" in error for error in errors), errors)

    def test_cast_schema_images_world_and_references_map(self):
        entity = {
            "id": "mira",
            "kind": "hero",
            "name": "Мира",
            "short_name": "Мира",
            "role": "",
            "appearance": "",
            "images": ["heroes/mira.jpg"],
            "initial_state": {},
        }
        cast = {"schema_version": 1, "entities": [entity], "properties": {}}
        (self.root / "plan/cast.json").write_text(json.dumps(cast, ensure_ascii=False), encoding="utf-8")
        report = tool.lint(self.root)
        cast_errors = [f"{i['where']}: {i['message']}" for i in report.errors if i["file"] == "plan/cast.json"]
        self.assertEqual(cast_errors, ["mira.images: нет файла source/heroes/mira.jpg"])
        errors, warnings = self.messages(report)
        self.assertTrue(any(e.startswith("references: карта references расходится с кастингом") for e in errors))
        self.assertTrue(any(w.startswith("entities: нет сущности world") for w in warnings))
        # Согласованный кастинг: файл есть, карта выведена из кастинга, мир задан.
        (self.root / "source/heroes").mkdir()
        (self.root / "source/heroes/mira.jpg").write_bytes(b"jpg")
        world = dict(entity, id="world", kind="world", name="Мир", short_name="Мир", images=[])
        cast["entities"].append(world)
        (self.root / "plan/cast.json").write_text(json.dumps(cast, ensure_ascii=False), encoding="utf-8")
        self.registry["references"] = {"mira": {"name": "Мира", "path": "source/heroes/mira.jpg"}}
        for item in self.registry["scenes"]:
            item.update(references=["mira"], card={"primary_reference": "mira"})
        self.write()
        report = tool.lint(self.root)
        self.assertEqual(self.messages(report)[0], [])
        self.assertFalse(any(i["file"] == "plan/cast.json" for i in report.warnings))
        cast["entities"][0]["id"] = "Мира"
        (self.root / "plan/cast.json").write_text(json.dumps(cast, ensure_ascii=False), encoding="utf-8")
        self.assertTrue(any(i["file"] == "plan/cast.json" for i in tool.lint(self.root).errors))

    def test_description_missing_hero_is_warning(self):
        (self.root / "source/description.md").write_text("Компания едет на отдых.", encoding="utf-8")
        _, warnings = self.messages(tool.lint(self.root))
        self.assertTrue(any("«Мира»" in w for w in warnings))


if __name__ == "__main__":
    unittest.main()
