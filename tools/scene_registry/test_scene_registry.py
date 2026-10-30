"""Проверяет единый источник времени и независимость от копий; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import json
import tempfile
import unittest
from copy import deepcopy

import tools.testing.sample_project  # noqa: E402,F401  Проект-образец должен быть выбран до импорта инструментов.
from tools.project_views.project_views import Sources, documents
from tools.scene_registry.scene_registry import (
    ROOT,
    accepted_fingerprints,
    load,
    project_shot_acceptance,
    scene_fingerprint,
    scene_fingerprints,
    shot_acceptance,
    with_accepted_fingerprints,
    scene_state,
    shots,
    validate,
    validate_project,
)


class SceneRegistryTests(unittest.TestCase):
    def test_project_name_propagates_to_documents_from_primary_data(self):
        sources = Sources()
        read_json = sources.json
        project = dict(read_json("plan/project.json"), name="Другой клип")
        sources.json = lambda name: project if name == "plan/project.json" else read_json(name)
        result = documents(sources)
        for path in ["ROADMAP.md", "plan/edit-list.md", "plan/storyboard.md"]:
            self.assertIn("«" + project["name"] + "»", result[path].splitlines()[0])

    def test_card_renderer_uses_supplied_project_and_references(self):
        from PIL import Image, ImageChops

        from tools.render_animatic_cards.render_animatic_cards import render_card

        # Контекст передаётся явно: референс из временного проекта не должен
        # заменяться данными текущего рабочего дерева при импорте рендерера.
        with tempfile.TemporaryDirectory(prefix="card-context-test-") as folder:
            root = Path(folder)
            Image.new("RGB", (32, 32), "red").save(root / "reference.png")
            references = {"ref": {"name": "Объект", "path": "reference.png"}}
            scene = {
                "id": "M01",
                "interval": "00:00–00:01",
                "duration": "1",
                "title": "Тест",
                "camera": "Статика",
                "action": "Наблюдение",
                "state": "Без изменений",
                "refs": ["ref"],
                "card": {"primary_reference": "ref"},
            }
            render_card(scene, root / "first.png", {"name": "Первый клип"}, references, root)
            render_card(scene, root / "second.png", {"name": "Другой клип"}, references, root)
            with Image.open(root / "first.png") as first, Image.open(root / "second.png") as second:
                self.assertIsNotNone(ImageChops.difference(first, second).getbbox())
                self.assertIsNone(
                    ImageChops.difference(first.crop((0, 63, 1280, 720)), second.crop((0, 63, 1280, 720))).getbbox()
                )

    def test_placeholder_reference_is_not_passed_to_cards(self):
        from tools.render_animatic_cards.render_animatic_cards import render_card

        # «—» — штатная пометка плана без референсов; карточка рисуется по главному референсу.
        data = deepcopy(load())
        data["scenes"][0]["references"] = ["—"]
        shot = shots(data)[0]
        self.assertEqual(shot["refs"], [])
        with tempfile.TemporaryDirectory(prefix="card-placeholder-test-") as folder:
            target = Path(folder) / "card.png"
            render_card(shot, target, {"name": "Клип"}, data["references"], ROOT)
            self.assertTrue(target.is_file())

    def test_generation_settings_are_required_and_validated(self):
        from tools.scene_registry.scene_registry import generation_settings

        video = {
            "provider": "test",
            "resolution": "1080p",
            "aspect_ratio": "16:9",
            "watermark": False,
            "duration_rule": "min_supported_strictly_greater_than_window",
        }
        good = {"generation": {"video": video, "image": None}}
        self.assertEqual(generation_settings(good)["aspect_ratio"], "16:9")
        with self.assertRaisesRegex(ValueError, "нет блока generation"):
            generation_settings({"name": "x"})
        with self.assertRaisesRegex(ValueError, "watermark"):
            generation_settings({"generation": {"video": dict(video, watermark="no"), "image": None}})
        with self.assertRaisesRegex(ValueError, "duration_rule"):
            generation_settings({"generation": {"video": dict(video, duration_rule="whatever"), "image": None}})
        with self.assertRaisesRegex(ValueError, "16:9"):
            generation_settings({"generation": {"video": dict(video, aspect_ratio="wide"), "image": None}})

    def test_project_agent_instructions_are_optional_and_preserved_verbatim(self):
        project = {"schema_version": 1, "name": "Тест", "animatic_video": "clip.mp4"}
        self.assertNotIn("agent_instructions", validate_project(project))
        for text in ("", "  Правило\r\n\nСтрока 2  "):
            data = dict(project, agent_instructions=text)
            self.assertEqual(validate_project(data)["agent_instructions"], text)
        for invalid in (None, 42, False, [], {}):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "agent_instructions должен быть строкой"):
                validate_project(dict(project, agent_instructions=invalid))

    def test_generation_auto_ratio_is_valid_for_both_media_but_other_invalid_values_are_rejected(self):
        from tools.scene_registry.scene_registry import generation_settings

        video = {
            "provider": "test",
            "resolution": "1080p",
            "aspect_ratio": "auto",
            "watermark": False,
            "duration_rule": "exact_window",
        }
        image = {"provider": "test", "aspect_ratio": "auto"}
        project = {
            "schema_version": 1,
            "name": "Тест",
            "animatic_video": "clip.mp4",
            "generation": {"video": video, "image": image},
        }
        self.assertEqual(validate_project(project), project)
        for kind in ("video", "image"):
            self.assertEqual(generation_settings(project, kind)["aspect_ratio"], "auto")
            for value in ("wide", "", " ", None, 3, True, [], {}):
                broken = deepcopy(project)
                broken["generation"][kind]["aspect_ratio"] = value
                with self.subTest(kind=kind, value=value), self.assertRaises(ValueError):
                    generation_settings(broken, kind)

    def test_generation_media_are_independent_and_flat_settings_are_rejected(self):
        from tools.scene_registry.scene_registry import generation_settings

        video = {
            "provider": "future-video",
            "resolution": "1080p",
            "aspect_ratio": "21:9",
            "watermark": False,
            "duration_rule": "exact_window",
            "model": "future-model",
            "options": {"backend": {"custom": True}},
            "custom": 7,
        }
        flat = {"generation": deepcopy(video)}
        for kind in ("video", "image"):
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, f"generation.{kind}"):
                generation_settings(flat, kind)
        with self.assertRaisesRegex(ValueError, "video и image"):
            validate_project({"schema_version": 1, "name": "Тест", "animatic_video": "clip.mp4", **flat})
        image = {"provider": "future-image", "outputs": 2, "options": {"backend": {"custom": True}}, "custom": ["keep"]}
        new = {"generation": {"video": video, "image": image, "custom": {"keep": True}}}
        self.assertEqual(generation_settings(new), video)
        result = generation_settings(new, "image")
        self.assertEqual(result, image)
        result["options"]["backend"]["custom"] = False
        self.assertTrue(image["options"]["backend"]["custom"])
        # Повреждённые настройки одного медиа не подменяются настройками другого.
        for invalid in (None, False, [], {}, "invalid"):
            mixed = {"generation": {"video": invalid, "image": image}}
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "generation.video"):
                generation_settings(mixed)
            self.assertEqual(generation_settings(mixed, "image"), image)
        with self.assertRaisesRegex(ValueError, "generation.image"):
            generation_settings({"generation": {"video": video}}, "image")
        with self.assertRaisesRegex(ValueError, "video или image"):
            generation_settings(new, "audio")

    def test_provider_selection_marker_is_optional_boolean_without_implicit_confirmation(self):
        from tools.scene_registry.scene_registry import generation_settings

        for marker in (None, False, True):
            image = {"provider": "codex", "model": "saved-model", "custom": {"keep": True}}
            if marker is not None:
                image["provider_selected"] = marker
            project = {"generation": {"video": None, "image": image}}
            self.assertEqual(generation_settings(project, "image"), image)
            self.assertEqual(project["generation"]["image"], image)
        for marker in (None, 0, 1, "true", [], {}):
            project = {"generation": {"image": {"provider": "codex", "provider_selected": marker}}}
            with self.subTest(marker=marker), self.assertRaisesRegex(ValueError, "provider_selected"):
                generation_settings(project, "image")

    def test_project_validation_checks_each_present_media_and_allows_missing_generation(self):
        from tools.scene_registry.scene_registry import generation_settings, load_project

        project = {"schema_version": 1, "name": "Тест", "animatic_video": "clip.mp4"}
        self.assertEqual(validate_project(project), project)
        for generation in (None, {"video": None, "image": None}, {"image": {"provider": "codex"}}):
            self.assertEqual(validate_project(dict(project, generation=generation))["generation"], generation)
        video = {
            "provider": "test",
            "resolution": "1080p",
            "aspect_ratio": "16:9",
            "watermark": False,
            "duration_rule": "exact_window",
        }
        for field, value in [
            ("outputs", 0),
            ("outputs", True),
            ("options", []),
            ("model", 3),
            ("aspect_ratio", "wide"),
            ("watermark", "no"),
        ]:
            broken = dict(project, generation={"video": video, "image": {"provider": "codex", field: value}})
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_project(broken)
            self.assertEqual(generation_settings(broken), video)
        with tempfile.TemporaryDirectory(prefix="generation-read-test-") as folder:
            root = Path(folder)
            (root / "plan").mkdir()
            path = root / "plan/project.json"
            path.write_text(json.dumps(broken))
            original = path.read_bytes()
            self.assertEqual(generation_settings(load_project(root)), video)
            with self.assertRaises(ValueError):
                load_project(root, validate_generation=True)
            self.assertEqual(path.read_bytes(), original)

    def test_project_documents_ignore_invalid_settings_of_generation(self):
        sources = Sources()
        read_json = sources.json
        project = dict(read_json("plan/project.json"), generation={"image": {"provider": "codex", "outputs": 0}})
        sources.json = lambda name: project if name == "plan/project.json" else read_json(name)
        self.assertIn("ROADMAP.md", documents(sources))

    def test_project_output_is_a_filename_and_never_a_directory_escape(self):
        for filename in ["../outside.mp4", "folder/video.mp4", ".hidden.mp4", "video.webm"]:
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                validate_project({"schema_version": 1, "name": "Тест", "animatic_video": filename})

    def test_state_inherits_along_chain_starts_from_cast_and_same_replays_source(self):
        # Образец: M01 без источника берёт начальное состояние кастинга, дальше цепочка M01 → M02 → M03 → M04,
        # M05 повторяет состояние M02 (phase same). @link ../testdata/README.md
        data = load()
        first = scene_state(data, "M01")
        self.assertEqual(first["before"]["mira"]["clothes_condition"], "светлая куртка")
        self.assertEqual(first["before"]["boat"]["dirt"], "чистая")
        self.assertEqual(first["after"]["boat"]["dirt"], "с каплями воды")
        self.assertEqual(scene_state(data, "M02")["before"]["boat"]["dirt"], "с каплями воды")
        fourth = scene_state(data, "M04")
        self.assertEqual(fourth["before"]["boat"]["sink"], "у края причала")
        self.assertEqual(fourth["before"]["mira"]["position"], "стоит у края причала")
        self.assertEqual(fourth["before"]["mira"]["clothes_condition"], "светлая куртка")
        self.assertEqual(fourth["after"]["mira"]["clothes_condition"], "яркая куртка")
        self.assertEqual(scene_state(data, "M05"), scene_state(data, "M02"))

    def test_later_changes_do_not_alter_earlier_state_or_fingerprint(self):
        data = load()
        baseline_state = scene_state(data, "M02")
        baseline = scene_fingerprint(data, "M02")
        next(s for s in data["scenes"] if s["id"] == "M04")["state_changes"]["after"]["mira"]["clothes_condition"] = (
            "другая куртка"
        )
        self.assertEqual(scene_state(data, "M02"), baseline_state)
        self.assertEqual(scene_fingerprint(data, "M02"), baseline)
        self.assertNotEqual(scene_fingerprint(data, "M05"), scene_fingerprint(data, "M04"))

    def test_state_graph_rejects_missing_sources_cycles_and_incomplete_records(self):
        # Нет такой сцены, ссылка на себя и цикл M02 → M04 → M03 → M02.
        for scene, source in [("M04", "M99"), ("M04", "M04"), ("M02", "M04")]:
            data = load()
            next(s for s in data["scenes"] if s["id"] == scene)["state_from"] = source
            with self.subTest(scene=scene, source=source), self.assertRaises(ValueError):
                validate(data)
        data = load()
        del data["scenes"][0]["state_changes"]
        with self.assertRaisesRegex(ValueError, "нужны state_from"):
            validate(data)

    def test_derived_from_accepts_existing_source_and_rejects_bad_links(self):
        data = load()
        by_id = {s["id"]: s for s in data["scenes"]}
        # Без поля и с корректной ссылкой на план с собственной генерацией реестр валиден.
        for scene in data["scenes"]:
            scene.pop("derived_from", None)
        validate(data)
        by_id["M04"]["derived_from"] = {"shot": "M02"}
        validate(data)
        cases = [
            ("M04", {"shot": "M99"}, "M04: derived_from ссылается на неизвестный план M99."),
            ("M04", {"shot": "M04"}, "M04: derived_from не может ссылаться на сам план."),
            ("M03", {"shot": "M04"}, "M03: источник M04 сам собирается из другого плана; укажите исходный план."),
            ("M03", "M02", 'M03: derived_from должен быть объектом {"shot": "Mxx"}.'),
            ("M03", {"shot": "M02", "mode": "freeze"}, 'M03: derived_from должен быть объектом {"shot": "Mxx"}.'),
            ("M03", {"shot": "2"}, 'M03: derived_from должен быть объектом {"shot": "Mxx"}.'),
        ]
        for sid, value, message in cases:
            with self.subTest(sid=sid, value=value):
                broken = deepcopy(data)
                next(s for s in broken["scenes"] if s["id"] == sid)["derived_from"] = value
                with self.assertRaises(ValueError) as error:
                    validate(broken)
                self.assertEqual(str(error.exception), message)

    def test_explicit_before_reference_and_null_remove_only_named_fact(self):
        data = load()
        by_id = {s["id"]: s for s in data["scenes"]}
        by_id["M04"]["state_from"] = {"scene": "M02", "phase": "before"}
        by_id["M04"]["state_changes"] = {
            "before": {"boat": {"sink": None}},
            "after": {"mira": {"clothes_condition": "вымытая куртка"}},
        }
        result = scene_state(data, "M04")
        self.assertNotIn("sink", result["before"]["boat"])
        self.assertEqual(result["before"]["boat"]["dirt"], scene_state(data, "M02")["before"]["boat"]["dirt"])
        self.assertEqual(result["after"]["mira"]["clothes_condition"], "вымытая куртка")
        self.assertEqual(scene_state(data, "M02")["before"]["boat"]["sink"], "у причала")

    def test_invalid_delta_or_replay_override_cannot_silently_reset_state(self):
        for changes in [{"after": {"mira": {"helmet": []}}}, {"during": {}}, []]:
            data = load()
            data["scenes"][3]["state_changes"] = changes
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate(data)
        data = load()
        data["scenes"][4]["state_changes"] = {"after": {"mira": {"helmet": "снят"}}}
        with self.assertRaisesRegex(ValueError, "повтор same"):
            validate(data)
        with self.assertRaisesRegex(ValueError, "отсутствует"):
            scene_state(load(), "M99")

    def test_returned_state_is_independent_and_reflects_upstream_edit(self):
        data = load()
        value = scene_state(data, "M04")
        value["before"]["boat"]["dirt"] = "случайное изменение результата"
        self.assertNotEqual(scene_state(data, "M04")["before"]["boat"]["dirt"], value["before"]["boat"]["dirt"])
        next(s for s in data["scenes"] if s["id"] == "M03")["state_changes"]["after"]["boat"]["dirt"] = (
            "другая согласованная степень загрязнения"
        )
        self.assertEqual(scene_state(data, "M04")["before"]["boat"]["dirt"], "другая согласованная степень загрязнения")

    def test_pending_request_fingerprint_includes_inherited_state(self):
        data = load()
        original = scene_fingerprint(data, "M04")
        next(s for s in data["scenes"] if s["id"] == "M03")["state_changes"]["after"]["boat"]["dirt"] = "меньше капель"
        self.assertNotEqual(original, scene_fingerprint(data, "M04"))
        # Начало истории не зависит от изменения позднего события.
        self.assertEqual(scene_fingerprint(load(), "M01"), scene_fingerprint(data, "M01"))

    def test_fingerprints_match_shared_reference_of_sample_project(self):
        # Тот же эталон проверяет тест главного процесса: Python и TypeScript считают отпечатки побайтно одинаково.
        expected = json.loads((Path(__file__).resolve().parents[1] / "testdata/scene-fingerprints.json").read_text())
        data = load()
        self.assertEqual({sid: scene_fingerprint(data, sid) for sid in expected}, expected)
        self.assertEqual(scene_fingerprints(data), expected)

    def test_acceptance_follows_scene_fingerprint_and_derived_source(self):
        data = load()
        # Образец: M01 и M02 приняты по текущей постановке, M05 собирается из материала M02.
        self.assertEqual(project_shot_acceptance(ROOT), {"M01": "completed", "M02": "completed"})
        current = scene_fingerprints(data)
        accepted = {sid: current[sid] for sid in ("M01", "M02", "M05")}
        kits = {"M01", "M02", "M05"}
        self.assertEqual(set(shot_acceptance(data, kits, accepted).values()), {"completed"})
        next(s for s in data["scenes"] if s["id"] == "M02")["action"] = "Другое действие"
        self.assertEqual(
            shot_acceptance(data, kits, accepted), {"M01": "completed", "M02": "stale", "M05": "stale"}
        )
        # Без записи отпечатка комплект считается принятым по неизвестной постановке.
        self.assertEqual(shot_acceptance(load(), {"M01"}, {}), {"M01": "stale"})

    def test_production_status_shots_are_validated_and_merged(self):
        self.assertEqual(accepted_fingerprints({"schema_version": 1}), {})
        for broken in ({"shots": []}, {"shots": {"M01": {}}}, {"shots": {"x": {"scene_sha256": "a" * 64}}}):
            with self.assertRaises(ValueError):
                accepted_fingerprints(broken)
        status = {"schema_version": 1, "current_animatic": None, "shots": {"M10": {"scene_sha256": "b" * 64}}}
        merged = with_accepted_fingerprints(status, {"M02": "a" * 64})
        self.assertEqual(list(merged["shots"]), ["M02", "M10"])
        self.assertIsNone(merged["current_animatic"])
        self.assertNotIn("M02", status["shots"])

    def test_gap_duplicate_and_wrong_song_end_are_rejected(self):
        data = load()
        for field, value in [("start_frame", 1), ("end_frame_exclusive", 0), ("id", "M02")]:
            changed = deepcopy(data)
            changed["scenes"][0][field] = value
            with self.assertRaises(ValueError):
                validate(changed)
        data["audio"]["end_seconds"] = "29"
        with self.assertRaises(ValueError):
            validate(data)

    def test_current_boundaries_and_asset_duration_have_single_owner(self):
        data = load()
        by_id = {s["id"]: s for s in shots(data)}
        self.assertEqual(by_id["M05"]["start_frame"], 600)
        self.assertEqual(by_id["M05"]["frames"], 300)
        for p in (ROOT / "assets/shots").glob("M*/manifest.json"):
            package = json.loads(p.read_text())
            self.assertNotIn("timeline", package["accepted_edit"])
            self.assertNotIn("assembly", package)
            self.assertEqual(package["accepted_edit"]["frames"], by_id[package["shot"]]["frames"])

    def test_derived_descriptions_are_not_read_as_sources(self):
        sources = Sources()
        original = sources.text

        def primary_only(name):
            self.assertNotIn(
                name,
                ["plan/storyboard.md", "plan/edit-list.md", "plan/context/characters.md", "assets/shots/manifest.json"],
            )
            return original(name)

        sources.text = primary_only
        result = documents(sources)
        self.assertIn("M03", result["plan/storyboard.md"])
        self.assertIn("Готово", result["ROADMAP.md"])

    def test_general_rules_and_speech_list_follow_their_primary_sources(self):
        # Изменение общего правила и состава речевых планов должно попасть в один справочник.
        sources = Sources()
        original = sources.json
        data = load()
        data["visual_direction"] = "Контрольное общее визуальное правило"
        for scene in data["scenes"]:
            scene["lipsync"] = scene["id"] == "M01"
        sources.json = lambda name: data if name == "plan/scenes.json" else original(name)
        result = documents(sources)
        self.assertEqual([p for p in result if p.startswith("plan/context/")], ["plan/context/characters.md"])
        view = result["plan/context/characters.md"]
        self.assertIn("Контрольное общее визуальное правило", view)
        self.assertIn("Всего 1. [M01](../storyboard.md#m01)", view)
        self.assertNotIn("[M04]", view)

    def test_changes_propagate_to_both_views(self):
        sources = Sources()
        original = sources.json
        data = load()
        data["scenes"][0]["action"] = "Контрольное новое действие"
        sources.json = lambda name: data if name == "plan/scenes.json" else original(name)
        result = documents(sources)
        self.assertIn("Контрольное новое действие", result["plan/edit-list.md"])
        self.assertIn("Контрольное новое действие", result["plan/storyboard.md"])
        self.assertIn("Контрольное новое действие", result["ROADMAP.md"])


if __name__ == "__main__":
    unittest.main()
