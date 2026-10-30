"""Статусы, этапы, кандидат next и независимость партии на временной фикстуре; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import hashlib
import json
import tempfile
import unittest

from tools.scene_registry.scene_registry import load, scene_fingerprints
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
        self.registry = registry
        self.write("plan/scenes.json", registry)
        self.write("plan/project.json", {"schema_version": 1, "name": "Тест", "animatic_video": "test.mp4"})
        # Кастинга нет: начальное состояние пустое. M01 принят по текущей постановке, у M05 отпечатка нет.
        self.accept_current("M01")
        self.write("assets/shots/M01/manifest.json", {"schema_version": 1, "shot": "M01"})
        self.write("assets/shots/M05/manifest.json", {"schema_version": 1, "shot": "M05"})
        self.write(
            "plan/awaiting/M02/workflow.json",
            {
                "schema_version": 1,
                "shot": "M02",
                "stage": "ready",
                "wait_reason": "insufficient_balance",
                "request_dir": "request",
                "keyframe_notes": [],
            },
        )
        self.write("plan/awaiting/M02/request/attempt.json", {"status": "prepared", "request_sha256": "x"})
        self.write("plan/batches/M03-attempt-01/request.json", {"shot": "M03", "provider": "test"})
        self.write("plan/batches/M03-attempt-01/attempt.json", {"status": "submitted", "generation_id": "job"})
        self.write(
            "plan/batches/M03-review/review.json", {"status": "review_pending", "shots": [{"id": "M03"}, {"id": "M04"}]}
        )
        (self.root / "plan/awaiting/M06").mkdir()
        (self.root / "plan/awaiting/M06/workflow.json").write_text("{повреждено", encoding="utf-8")

    def accept_current(self, *ids):
        fingerprints = scene_fingerprints(self.registry, {})
        self.write(
            "plan/production-status.json",
            {
                "schema_version": 1,
                "current_animatic": None,
                "current_animatic_status": "none",
                "shots": {sid: {"scene_sha256": fingerprints[sid]} for sid in ids},
            },
        )

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
        self.assertEqual(rows["M05"]["status"], "stale")
        self.assertEqual(rows["M05"]["stage"], "постановка изменена после приёмки: нужно новое производство")
        self.assertEqual(rows["M06"]["status"], "unknown")
        self.assertEqual(result["queue"], ["M02", "M06"])
        self.assertEqual(result["next"], "M02")
        self.assertEqual(result["unassigned_packages"], {})

    def test_completed_shot_keeps_status_and_shows_alternative_package_as_note(self):
        self.write("plan/batches/M01-attempt-02/request.json", {"shot": "M01", "provider": "test"})
        self.write("plan/batches/M01-attempt-02/attempt.json", {"status": "downloaded", "request_sha256": "y"})
        _, rows = self.rows()
        self.assertEqual(rows["M01"]["status"], "completed")
        self.assertIn("batch: plan/batches/M01-attempt-02 (результат получен, ожидает просмотра)", rows["M01"]["notes"])

    def test_action_edit_makes_accepted_shot_stale_and_next_candidate(self):
        self.accept_current("M01", "M05")
        result, rows = self.rows()
        self.assertEqual((rows["M01"]["status"], rows["M05"]["status"]), ("completed", "completed"))
        self.registry["scenes"][0]["action"] = "другое действие"
        self.write("plan/scenes.json", self.registry)
        result, rows = self.rows()
        self.assertEqual((rows["M01"]["status"], rows["M01"]["label"]), ("stale", "постановка изменена"))
        self.assertEqual(result["next"], "M01")
        # Действие не входит в унаследованное состояние: отпечаток M05 и его принятие не меняются.
        self.assertEqual(rows["M05"]["status"], "completed")
        text = tool.table(result, "stale")
        self.assertIn("| M01 |", text)
        self.assertNotIn("| M05 |", text)
        self.assertIn("постановка изменена: 1", text)

    def test_derived_shot_is_stale_while_its_source_is_stale(self):
        self.registry["scenes"][3]["derived_from"] = {"shot": "M01"}
        self.write("plan/scenes.json", self.registry)
        digest = hashlib.sha256(b"accepted source").hexdigest()
        self.write(
            "assets/shots/M01/manifest.json",
            {
                "schema_version": 1,
                "shot": "M01",
                "kind": "generated_video",
                "accepted_edit": {"video": {"path": "video.mp4", "sha256": digest}},
            },
        )
        (self.root / "assets/shots/M01/video.mp4").write_bytes(b"accepted source")
        self.write(
            "assets/shots/M04/manifest.json",
            {
                "schema_version": 1,
                "shot": "M04",
                "kind": "derived_video",
                "generation": {
                    "source_shot": "M01",
                    "source_scene_sha256": scene_fingerprints(self.registry, {})["M01"],
                    "source_accepted_video_sha256": digest,
                },
            },
        )
        self.accept_current("M01", "M04")
        _, rows = self.rows()
        self.assertEqual((rows["M01"]["status"], rows["M04"]["status"]), ("completed", "completed"))
        # Правка камеры M01 не входит в состояние M04, но материал M04 взят из устаревшего M01.
        self.registry["scenes"][0]["camera"] = "наезд"
        self.write("plan/scenes.json", self.registry)
        _, rows = self.rows()
        self.assertEqual((rows["M01"]["status"], rows["M04"]["status"]), ("stale", "stale"))
        self.assertIn("источник M01 не готов", rows["M04"]["stage"])
        self.accept_current("M01", "M04")
        _, rows = self.rows()
        self.assertEqual(rows["M04"]["status"], "stale")
        self.assertIn("материал источника M01 изменён", rows["M04"]["stage"])

    def test_fresh_package_without_request_dir_is_in_progress_not_a_crash(self):
        # shot_workflow init пишет request_dir: null до заморозки запроса; статус берётся из stage.
        self.write(
            "plan/batches/M04-attempt-01/workflow.json",
            {
                "schema_version": 1,
                "shot": "M04",
                "stage": "keyframes_review",
                "request_dir": None,
                "keyframes": [],
                "keyframe_notes": [],
            },
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
                    "keyframe_notes": [],
                },
            )
            _, rows = self.rows()
            self.assertEqual((rows["M04"]["status"], rows["M04"]["stage"]), ("progress", tool.STAGE_LABELS[stage]))

    def test_package_for_unknown_shot_is_reported_not_silently_dropped(self):
        self.write("plan/batches/m99-test-v01/attempt.json", {"status": "prepared"})
        result, _ = self.rows()
        self.assertEqual(result["unassigned_packages"], {"M99": ["plan/batches/m99-test-v01"]})
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
