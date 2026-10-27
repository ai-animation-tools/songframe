"""Проверка таблицы монтажного списка, ROADMAP и долей готовности; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import hashlib
import re
import unittest
from unittest.mock import patch

import tools.testing  # noqa: E402,F401  Проект-образец должен быть выбран до импорта инструментов.
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

    def test_selected_asset_does_not_depend_on_approval_or_old_work_status(self):
        # Наличие выбранной сцены в assets важнее устаревшей рабочей отметки.
        # Манифест и видео остаются входами таблицы, подтверждения — нет.
        sources = Sources()
        read_json = sources.json
        state = read_json("plan/production-status.json")
        state["shots"]["M02"] = {"status": "in_progress"}

        def json_without_old_state(path):
            return state if path == "plan/production-status.json" else read_json(path)

        with patch.object(sources, "json", side_effect=json_without_old_state):
            roadmap = render(sources)
        row = next(line for line in roadmap.splitlines() if "**M02**" in line)
        self.assertIn("**Готово**", row)
        self.assertIn("assets/shots/M02/manifest.json", row)
        self.assertNotIn("[Решение](", roadmap)
        self.assertFalse(any(path.startswith("assets/") and "approval" in path for path in sources.inputs))

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
            ("0" * 64, "Сборка устарела относительно реестра сцен; требуется пересборка."),
        ]:
            manifest = dict(
                latest,
                scene_registry_sha256=digest,
                source_hashes=dict(
                    latest["source_hashes"],
                    **{"plan/project.json": hashlib.sha256(sources.text("plan/project.json").encode()).hexdigest()},
                ),
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


if __name__ == "__main__":
    unittest.main()
