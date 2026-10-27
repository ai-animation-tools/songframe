"""Статусы, этапы, кандидат next и независимость партии на временной фикстуре; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import tempfile
import unittest

from tools.scene_registry.scene_registry import load
from tools.shot_status import shot_status as tool


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
        "lipsync": sid == "M05",
        "card": {"primary_reference": "П"},
        "state_from": source,
        "state_changes": changes,
    }


class ShotStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="shot-status-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("plan/awaiting", "plan/batches", "assets/shots"):
            (self.root / name).mkdir(parents=True)
        registry = {
            "schema_version": 1,
            "fps": 30,
            "audio": {"path": "source/track.mp3", "end_seconds": "18"},
            "references": {"П": {"name": "Мира", "path": "source/heroes/mira.jpg"}},
            "visual_direction": "# Правила",
            "sequences": [{"id": "s", "title": "Сцена", "direction": "направление"}],
            "scenes": [
                scene("M01", 0, 90, None, {"before": {"mira": {"position": "у лодки"}}}),
                scene("M02", 90, 180, "M01", {}),
                scene("M03", 180, 270, "M02", {"after": {"boat": {"mobility": "увяз"}}}),
                scene("M04", 270, 360, "M03", {}),
                scene("M05", 360, 450, "M04", {}),
                scene("M06", 450, 540, "M05", {}),
            ],
        }
        self.write("plan/scenes.json", registry)
        self.write("plan/project.json", {"schema_version": 1, "name": "Тест", "animatic_video": "test.mp4"})
        self.write(
            "plan/production-status.json",
            {
                "schema_version": 1,
                "shots": {"M05": {"status": "frames_approved"}},
                "active_work": {"status": "idle", "shots": []},
            },
        )
        self.write("assets/shots/M01/manifest.json", {"schema_version": 1, "shot": "M01"})
        self.write(
            "plan/awaiting/M02/workflow.json",
            {
                "schema_version": 1,
                "shot": "M02",
                "stage": "ready",
                "wait_reason": "insufficient_balance",
                "request_dir": "request",
            },
        )
        self.write("plan/awaiting/M02/request/attempt.json", {"status": "prepared", "request_sha256": "x"})
        self.write("plan/batches/M03-attempt-01/request.json", {"shot": "M03"})
        self.write("plan/batches/M03-attempt-01/attempt.json", {"status": "submitted", "generation_id": "job"})
        self.write(
            "plan/batches/M03-review/review.json", {"status": "review_pending", "shots": [{"id": "M03"}, {"id": "M04"}]}
        )
        (self.root / "plan/awaiting/M06").mkdir()
        (self.root / "plan/awaiting/M06/workflow.json").write_text("{повреждено", encoding="utf-8")

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def rows(self):
        result = tool.collect(self.root)
        return result, {r["id"]: r for r in result["shots"]}

    def test_statuses_follow_primary_sources_not_derived_views(self):
        result, rows = self.rows()
        self.assertEqual(rows["M01"]["status"], "completed")
        self.assertEqual(rows["M02"]["status"], "progress")
        self.assertEqual(rows["M02"]["stage"], "отложено в plan/awaiting; нехватка средств")
        self.assertEqual(rows["M03"]["stage"], "генерируется")
        self.assertEqual(rows["M04"]["status"], "planned")
        self.assertEqual(rows["M04"]["notes"], ["проба: plan/batches/M03-review/review.json"])
        self.assertEqual(rows["M05"]["stage"], "по реестру работ: frames_approved")
        self.assertEqual(rows["M06"]["status"], "unknown")
        self.assertEqual(result["queue"], ["M02", "M06"])
        self.assertEqual(result["next"], "M02")
        self.assertEqual(result["unassigned_packages"], {})

    def test_completed_shot_keeps_status_and_shows_alternative_package_as_note(self):
        self.write("plan/batches/M01-attempt-02/request.json", {"shot": "M01"})
        self.write("plan/batches/M01-attempt-02/attempt.json", {"status": "downloaded", "request_sha256": "y"})
        _, rows = self.rows()
        self.assertEqual(rows["M01"]["status"], "completed")
        self.assertIn("batch: plan/batches/M01-attempt-02 (результат получен, ожидает просмотра)", rows["M01"]["notes"])

    def test_fresh_package_without_request_dir_is_in_progress_not_a_crash(self):
        # shot_workflow init пишет request_dir: null до заморозки запроса; статус берётся из stage.
        self.write(
            "plan/batches/M04-attempt-01/workflow.json",
            {"schema_version": 1, "shot": "M04", "stage": "keyframes_review", "request_dir": None, "keyframes": []},
        )
        _, rows = self.rows()
        self.assertEqual(
            (rows["M04"]["status"], rows["M04"]["stage"]), ("progress", tool.STAGE_LABELS["keyframes_review"])
        )

    def test_image_workflow_stages_have_labels_without_video_request(self):
        for stage in ("image_request_choice", "image_submitted", "image_downloaded"):
            self.write(
                "plan/batches/M04-attempt-01/workflow.json",
                {
                    "schema_version": 1,
                    "shot": "M04",
                    "stage": stage,
                    "request_dir": None,
                    "image_request_dir": "image-01",
                    "image_frame_id": "K01",
                },
            )
            _, rows = self.rows()
            self.assertEqual((rows["M04"]["status"], rows["M04"]["stage"]), ("progress", tool.STAGE_LABELS[stage]))

    def test_package_for_unknown_shot_is_reported_not_silently_dropped(self):
        self.write("plan/batches/m99-kling-v01/attempt.json", {"status": "prepared"})
        result, _ = self.rows()
        self.assertEqual(result["unassigned_packages"], {"M99": ["plan/batches/m99-kling-v01"]})
        text = tool.table(result)
        self.assertIn("Пакет без плана в реестре: M99", text)
        self.assertIn("| M01 | 00:00.0–00:03.0 · 3 с | готова |", text)
        self.assertIn("Кандидат next: M02.", text)

    def test_independence_requires_changes_on_the_inherited_path(self):
        data = load(self.root)
        self.assertEqual(tool.independence(data, ["M04", "M05"]), [])
        self.assertEqual(tool.independence(data, ["M02", "M03"]), [])
        conflicts = tool.independence(data, ["M03", "M05"])
        self.assertEqual([(c["shot"], c["depends_on"]) for c in conflicts], [("M05", "M03")])
        with self.assertRaises(ValueError):
            tool.independence(data, ["M03", "M77"])
        with self.assertRaises(ValueError):
            tool.independence(data, ["M04", "M04"])
        self.assertEqual(
            [(p["first"], p["second"]) for p in tool.adjacent_pairs(data, ["M05", "M02", "M04"])], [("M04", "M05")]
        )
        self.assertEqual(tool.adjacent_pairs(data, ["M02", "M04", "M06"]), [])

    def test_all_statuses_have_labels_and_filter_keeps_only_requested(self):
        result, _ = self.rows()
        self.assertEqual({r["status"] for r in result["shots"]}, set(tool.STATUS_LABELS))
        text = tool.table(result, "progress")
        self.assertIn("| M02 |", text)
        self.assertNotIn("| M01 |", text)


if __name__ == "__main__":
    unittest.main()
