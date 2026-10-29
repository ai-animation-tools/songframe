"""Проверка таблицы монтажного списка, ROADMAP и долей готовности; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import hashlib
import json
import re
import unittest
from unittest.mock import patch

import tools.testing.sample_project  # noqa: E402,F401  Проект-образец должен быть выбран до импорта инструментов.
from tools.project_views.project_views import Sources, documents, progress, render


class RoadmapTests(unittest.TestCase):
    def test_edit_list_has_matching_markdown_table_columns(self):
        # При несовпадении числа ячеек заголовка и разделителя предпросмотр
        # показывает монтажный список обычным текстом вместо таблицы.
        text = documents(Sources())["plan/edit-list.md"]
        lines = [line for line in text.splitlines() if line.startswith("|")]
        header, separator, *rows = lines
        columns = re.split(r"(?<!\\)\|", header[1:-1])
        self.assertEqual(len(columns), 8)
        for line in [separator, *rows]:
            with self.subTest(row=line[:80]):
                self.assertEqual(len(re.split(r"(?<!\\)\|", line[1:-1])), len(columns))
        self.assertEqual(len(rows), len(Sources().json("plan/scenes.json")["scenes"]))

    def test_derived_shot_is_marked_with_source_and_ordinary_shots_are_unchanged(self):
        def views(derived):
            sources = Sources()
            read_json = sources.json
            scenes = read_json("plan/scenes.json")
            for scene in scenes["scenes"]:
                scene.pop("derived_from", None)
                if scene["id"] in derived:
                    scene["derived_from"] = {"shot": derived[scene["id"]]}
            sources.json = lambda name: scenes if name == "plan/scenes.json" else read_json(name)
            return documents(sources)

        plain, result = views({}), views({"M04": "M02"})
        self.assertIn("| **M04** · из M02 | ", result["ROADMAP.md"])
        self.assertIn("\n| M04 · из M02 | ", result["plan/edit-list.md"])
        self.assertIn("**Материал:** из [M02](#m02), без собственной генерации.", result["plan/storyboard.md"])
        # Остальные планы выглядят так же, как без поля.
        for name in ("ROADMAP.md", "plan/edit-list.md"):
            marked = [line for line in result[name].splitlines() if "из M02" in line]
            self.assertEqual(len(marked), 1, name)
        for line in plain["plan/edit-list.md"].splitlines():
            if line.startswith("| M0") and not line.startswith("| M04"):
                self.assertIn(line, result["plan/edit-list.md"])

    def test_progress_distinguishes_plan_count_from_frame_duration(self):
        # Равное число планов не означает равную долю готового хронометража.
        scenes = [{"id": "a", "frames": 30}, {"id": "b", "frames": 90}, {"id": "c", "frames": 60}]
        states = {"a": "Готово", "b": "В процессе", "c": "Запланировано"}
        result = "\n".join(progress(scenes, states, 30))
        for state in states.values():
            self.assertIn("| " + state + " | 1 | 33,3% |", result)
        self.assertIn("По хронометражу готово 16,7%", result)
        self.assertIn("00:01.0 из 00:06.0", result)

    def test_progress_omits_zero_pie_slices_and_handles_complete_or_empty_plan(self):
        for scenes, states in [([], {}), ([{"id": "a", "frames": 30}], {"a": "Готово"})]:
            with self.subTest(empty=not scenes):
                result = "\n".join(progress(scenes, states, 30))
                self.assertIn("| В процессе | 0 | 0,0% |", result)
                self.assertNotIn('" : 0', result)
                if scenes:
                    self.assertIn("По хронометражу готово 100,0%", result)
                else:
                    self.assertNotIn("```mermaid", result)

    def test_selected_asset_does_not_depend_on_approval_or_open_work_package(self):
        # Наличие выбранной сцены в assets важнее незавершённого пакета новой попытки.
        # Манифест и видео остаются входами таблицы, подтверждения — нет.
        sources = Sources()
        read_json = sources.json
        package = "plan/awaiting/M02/workflow.json"
        sources.files.add(package)

        def json_with_package(path):
            return {"shot": "M02", "stage": "ready"} if path == package else read_json(path)

        with patch.object(sources, "json", side_effect=json_with_package):
            roadmap = render(sources)
        row = next(line for line in roadmap.splitlines() if "**M02**" in line)
        self.assertIn("**Готово**", row)
        self.assertIn("assets/shots/M02/manifest.json", row)
        self.assertNotIn("[Решение](", roadmap)
        self.assertFalse(any(path.startswith("assets/") and "approval" in path for path in sources.inputs))

    def test_edited_direction_marks_accepted_shot_as_changed_not_ready(self):
        # Комплект остаётся материалом сборки, но после правки постановки план не считается готовым.
        sources = Sources()
        read_json = sources.json
        scenes = read_json("plan/scenes.json")
        next(s for s in scenes["scenes"] if s["id"] == "M02")["action"] = "Новое действие после приёмки"
        sources.json = lambda name: scenes if name == "plan/scenes.json" else read_json(name)
        roadmap = render(sources)
        row = next(line for line in roadmap.splitlines() if line.startswith("| **M02**"))
        self.assertIn("**Постановка изменена**", row)
        self.assertIn("assets/shots/M02/manifest.json", row)
        self.assertIn("| Постановка изменена | 1 | 20,0% |", roadmap)
        self.assertIn("готовы 1.", roadmap)
        self.assertNotIn("Постановка изменена", render(Sources()))

    def test_current_edit_includes_fractional_shot_and_new_intro_links(self):
        # Реальная таблица должна целиком попадать в сводку; собственные
        # разделы вступления важнее чисел из ссылок на использованный материал.
        sources = Sources()
        roadmap = render(sources)
        self.assertIn("[Текущий полный монтаж](plan/animatic/latest/README.md)", roadmap)
        self.assertNotIn("index.html", roadmap)
        current = sources.json(sources.json("plan/production-status.json")["current_animatic"])
        self.assertEqual(roadmap.count("| **M"), len(current["shots"]))
        for shot in current["shots"]:
            self.assertIn("**" + shot["id"] + "**", roadmap)
        for shot_id in ("M01", "M03", "M04"):
            row = next(line for line in roadmap.splitlines() if "**" + shot_id + "**" in line)
            self.assertIn("plan/storyboard.md#" + shot_id.lower(), row)
        row = next(line for line in roadmap.splitlines() if "**M02**" in line)
        self.assertIn("plan/storyboard.md#m02", row)

    def test_build_status_distinguishes_current_and_changed_registry(self):
        # Локальная правка постановки не требует пересборки настоящего видео
        # ради теста. Обе стадии проверяются с подставным манифестом в памяти.
        sources = Sources()
        read_json = sources.json
        latest_path = read_json("plan/production-status.json")["current_animatic"]
        latest = read_json(latest_path)
        current_hash = hashlib.sha256(sources.text("plan/scenes.json").encode()).hexdigest()
        for digest, expected in [
            (current_hash, "Полная сборка ожидает просмотра."),
            ("0" * 64, "Сборка устарела относительно исходников; требуется пересборка."),
        ]:
            manifest = dict(
                latest,
                scene_registry_sha256=digest,
                project_inputs={key: read_json("plan/project.json")[key] for key in ("name", "animatic_video")},
            )
            with (
                self.subTest(current=digest == current_hash),
                patch.object(
                    sources, "json", side_effect=lambda path: manifest if path == latest_path else read_json(path)
                ),
            ):
                roadmap = render(sources)
            self.assertIn(expected, roadmap)
            self.assertNotIn("Последний утверждённый полный просмотр:", roadmap)

    def test_build_project_inputs_ignore_generation_but_validate_exact_snapshot(self):
        sources = Sources()
        read_json = sources.json
        read_text = sources.text
        project = read_json("plan/project.json")
        latest_path = read_json("plan/production-status.json")["current_animatic"]
        manifest = dict(read_json(latest_path))
        manifest["scene_registry_sha256"] = hashlib.sha256(read_text("plan/scenes.json").encode()).hexdigest()
        manifest["project_inputs"] = {key: project[key] for key in ("name", "animatic_video")}

        def current_json(path):
            return project if path == "plan/project.json" else manifest if path == latest_path else read_json(path)

        with (
            patch.object(sources, "json", side_effect=current_json),
            patch.object(
                sources,
                "text",
                side_effect=lambda path: (
                    json.dumps(project, ensure_ascii=False, indent=4)
                    if path == "plan/project.json"
                    else read_text(path)
                ),
            ),
        ):
            for generation in (
                {
                    "video": {
                        "provider": "test",
                        "provider_selected": True,
                        "model": "другая",
                        "options": {"duration": 5},
                    }
                },
                None,
            ):
                with self.subTest(generation=generation):
                    project["generation"] = generation
                    self.assertIn("Полная сборка ожидает просмотра.", render(sources))
            for field in ("name", "animatic_video"):
                value = project[field]
                project[field] = "Другое имя" if field == "name" else "другое.mp4"
                self.assertIn("Сборка устарела", render(sources))
                project[field] = value
            for malformed in (
                None,
                [],
                {"name": project["name"]},
                {"name": project["name"], "animatic_video": 1},
                dict(manifest["project_inputs"], extra="лишнее"),
            ):
                with self.subTest(project_inputs=malformed):
                    manifest["project_inputs"] = malformed
                    self.assertIn("Сборка устарела", render(sources))
            manifest.pop("project_inputs")
            self.assertIn("Сборка устарела", render(sources))

    def test_missing_or_changed_media_hashes_make_build_stale(self):
        sources = Sources()
        read_json = sources.json
        read_digest = sources.digest
        latest_path = read_json("plan/production-status.json")["current_animatic"]
        project = read_json("plan/project.json")
        manifest = dict(read_json(latest_path))
        manifest["scene_registry_sha256"] = hashlib.sha256(sources.text("plan/scenes.json").encode()).hexdigest()
        manifest["project_inputs"] = {key: project[key] for key in ("name", "animatic_video")}
        with patch.object(
            sources, "json", side_effect=lambda path: manifest if path == latest_path else read_json(path)
        ):
            self.assertIn("Полная сборка ожидает просмотра.", render(sources))
            video = next(shot["path"] for shot in manifest["shots"] if shot["media"] == "video")
            for changed in (manifest["source_audio"], video):
                with (
                    self.subTest(path=changed),
                    patch.object(
                        sources, "digest", side_effect=lambda path: "0" * 64 if path == changed else read_digest(path)
                    ),
                ):
                    self.assertIn("Сборка устарела", render(sources))
            for missing in (None, {}, {"source/missing.mp4": "0" * 64}):
                manifest["source_hashes"] = missing
                self.assertIn("Сборка устарела", render(sources))
            manifest.pop("source_hashes")
            self.assertIn("Сборка устарела", render(sources))


if __name__ == "__main__":
    unittest.main()
