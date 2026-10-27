"""Несоответствия после приёмки на временном проекте и чистое дерево без замечаний; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import subprocess
import tempfile
import unittest

from tools.check_workspace.check_workspace import collect, package_owners
from tools.export_edit_bundle import export_edit_bundle
from tools.export_edit_bundle import test_export_edit_bundle as bundle_fixture


class CheckWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="workspace-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ("plan/batches", "plan/awaiting", "plan/animatic/cards", "assets/shots/M01"):
            (self.root / name).mkdir(parents=True)
        (self.root / "plan/scenes.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "fps": 30,
                    "audio": {"end_seconds": "3"},
                    "references": {},
                    "sequences": [{"id": "intro"}],
                    "scenes": [
                        {
                            "id": sid,
                            "sequence": "intro",
                            "start_frame": i * 30,
                            "end_frame_exclusive": i * 30 + 30,
                            "references": [],
                        }
                        for i, sid in enumerate(["M01", "M02", "M03"])
                    ],
                }
            )
        )
        (self.root / "assets/shots/M01/manifest.json").write_text('{"shot": "M01"}')
        for sid in ("M02", "M03"):
            (self.root / f"plan/animatic/cards/{sid}.png").write_bytes(b"png")
        (self.root / "plan/animatic/cards/manifest.json").write_text(json.dumps({"cards": {"M02": {}, "M03": {}}}))

    def test_clean_tree_has_no_problems(self):
        result = collect(self.root)
        self.assertEqual((result["accepted"], result["problems"]), (["M01"], []))

    def exported_project(self, copy=False):
        """Настоящий export на временной фикстуре; готовый снимок переживает дальнейшую приёмку."""
        fixture = bundle_fixture.ExportEditBundleTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        root = fixture.root
        folder = root / "plan/batches/arbitrary-export-name"
        export_edit_bundle.export(folder, root, copy=copy)
        (root / "assets/shots/M02").mkdir()
        (root / "assets/shots/M02/manifest.json").write_text('{"shot": "M02"}')
        (root / "plan/animatic/cards/M02.png").unlink()
        (root / "plan/animatic/cards/manifest.json").write_text('{"cards": {}}')
        return root, folder

    def test_completed_edit_bundles_do_not_need_a_shot_owner(self):
        for copy in (False, True):
            with self.subTest(copy=copy):
                root, folder = self.exported_project(copy=copy)
                self.assertEqual(package_owners(folder), set())
                self.assertEqual(collect(root)["problems"], [])

    def test_export_name_and_incomplete_or_invalid_bundle_do_not_hide_folders(self):
        for damage in ("name_only", "missing_output", "invalid_rows"):
            with self.subTest(damage=damage):
                root, folder = self.exported_project()
                if damage == "name_only":
                    for file in folder.iterdir():
                        file.unlink()
                    (folder / "README.md").write_text("Папка с похожим названием")
                elif damage == "missing_output":
                    (folder / "timeline.fcpxml").unlink()
                else:
                    bundle = json.loads((folder / "bundle.json").read_text())
                    bundle["shots"] = [{}]
                    (folder / "bundle.json").write_text(json.dumps(bundle))
                folder.rename(folder.with_name("edit-bundle-20261027-0012"))
                self.assertEqual([p["kind"] for p in collect(root)["problems"]], ["package_unowned"])

    def test_bundle_does_not_hide_working_or_unowned_workflows(self):
        for name, document, expected in (
            ("workflow.json", {"shot": "M01"}, "package_of_accepted"),
            ("workflow.json", {"stage": "preparing"}, "package_unowned"),
            ("request/request.json", {"shot": "M01"}, "package_of_accepted"),
        ):
            with self.subTest(name=name, document=document):
                root, folder = self.exported_project()
                marker = folder / name
                marker.parent.mkdir(exist_ok=True)
                marker.write_text(json.dumps(document))
                self.assertEqual([p["kind"] for p in collect(root)["problems"]], [expected])

    def test_completed_review_is_kept_but_incomplete_review_remains_a_package(self):
        folder = self.root / "plan/batches/arbitrary-review-name"
        folder.mkdir()
        video = folder / "preview.mp4"
        video.write_bytes("готовая проба".encode())
        recipe = {
            "schema_version": 1,
            "fps": 30,
            "status": "review_pending",
            "total_frames": 30,
            "output": "C:\\old-project\\preview.mp4",
            "video_sha256": "a" * 64,
            "audio": {"path": "source/track.mp3"},
            "shots": [
                {"id": "M01", "kind": "video", "path": "assets/shots/M01/video.mp4", "sha256": "b" * 64, "frames": 30}
            ],
        }
        (folder / "preview.json").write_text(json.dumps(recipe))
        self.assertEqual(collect(self.root)["problems"], [])
        video.unlink()
        self.assertEqual([p["kind"] for p in collect(self.root)["problems"]], ["package_of_accepted"])
        video.write_bytes("готовая проба".encode())
        (folder / "workflow.json").write_text('{"shot": "M01"}')
        self.assertEqual([p["kind"] for p in collect(self.root)["problems"]], ["package_of_accepted"])

    def test_saved_manual_montage_retains_accepted_source_and_export(self):
        folder = self.root / "plan/batches/M01-attempt-01"
        folder.mkdir()
        (folder / "workflow.json").write_text('{"shot": "M01"}')
        drafts = self.root / "plan/montage"
        drafts.mkdir()
        (drafts / "draft.json").write_text(
            json.dumps({"clips": [{"path": "plan/batches/M01-attempt-01/original.mp4"}]})
        )
        export = self.root / "plan/batches/review-manual-test"
        export.mkdir()
        (export / "montage.json").write_text('{"clips": []}')
        self.assertEqual(collect(self.root)["problems"], [])

    def run_cli(self, *args, project=None):
        return subprocess.run(
            [
                sys.executable,
                "-B",
                str(Path(__file__).with_name("check_workspace.py")),
                "--project",
                str(project or self.root),
                *args,
            ],
            capture_output=True,
            text=True,
        )

    def test_new_project_requires_scenario_without_creating_registry(self):
        project = self.root / "new-project"
        (project / "plan").mkdir(parents=True)
        (project / "plan/project.json").write_text(
            '{"schema_version": 1, "name": "Новый клип", "animatic_video": "clip.mp4"}'
        )
        message = "Сначала необходимо создать сценарий: отсутствует plan/scenes.json."
        with self.assertRaisesRegex(ValueError, "Сначала необходимо создать сценарий"):
            collect(project)
        for args in ([], ["--json"]):
            with self.subTest(args=args):
                result = self.run_cli(*args, project=project)
                self.assertEqual(result.returncode, 1)
                if args:
                    self.assertEqual(json.loads(result.stdout), {"error": message})
                    self.assertEqual(result.stderr, "")
                else:
                    self.assertEqual(result.stdout, "")
                    self.assertEqual(result.stderr, message + "\n")
                self.assertFalse((project / "plan/scenes.json").exists())

    def test_json_cli_preserves_clean_tree_result(self):
        result = self.run_cli("--json")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {"accepted": ["M01"], "problems": []})
        self.assertEqual(result.stderr, "")

    def test_json_cli_preserves_workspace_problems_and_failure_exit(self):
        (self.root / "plan/animatic/cards/M01.png").write_bytes(b"png")
        result = self.run_cli("--json")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), collect(self.root))
        self.assertEqual([item["kind"] for item in json.loads(result.stdout)["problems"]], ["card_of_accepted"])
        self.assertEqual(result.stderr, "")

    def test_leftovers_after_acceptance_are_listed_by_kind(self):
        (self.root / "plan/animatic/cards/M01.png").write_bytes(b"png")
        (self.root / "plan/animatic/cards/M03.png").unlink()
        (self.root / "plan/batches/M01-attempt-01").mkdir()
        (self.root / "plan/batches/M01-attempt-01/workflow.json").write_text('{"shot": "M01", "stage": "accepted"}')
        (self.root / "plan/batches/old-review").mkdir()
        (self.root / "plan/batches/notes").mkdir()
        (self.root / "plan/batches/notes/readme.txt").write_text("заметка")
        (self.root / "plan/batches/M02-attempt-01").mkdir()
        (self.root / "plan/batches/M02-attempt-01/workflow.json").write_text(
            '{"shot": "M02", "stage": "keyframes_review"}'
        )
        (self.root / "plan/awaiting/M01").mkdir()
        (self.root / "plan/awaiting/M01/workflow.json").write_text('{"shot": "M01", "stage": "ready"}')
        (self.root / "plan/animatic/cards/manifest.json").write_text(
            json.dumps({"cards": {"M01": {}, "M02": {}, "M03": {}}})
        )
        kinds = {(p["kind"], p["path"]) for p in collect(self.root)["problems"]}
        self.assertEqual(
            kinds,
            {
                ("card_of_accepted", "plan/animatic/cards/M01.png"),
                ("card_missing", "plan/animatic/cards/M03.png"),
                ("receipt_stale", "plan/animatic/cards/manifest.json"),
                ("empty_folder", "plan/batches/old-review"),
                ("package_of_accepted", "plan/batches/M01-attempt-01"),
                ("package_unowned", "plan/batches/notes"),
                ("queue_of_accepted", "plan/awaiting/M01"),
            },
        )

    def test_owners_come_from_json_before_folder_name(self):
        folder = self.root / "plan/batches/M03-review-v01"
        folder.mkdir()
        self.assertEqual(package_owners(folder), {"M03"})
        (folder / "review-01.json").write_text(
            json.dumps({"status": "review_pending", "shots": [{"id": "M01"}, {"id": "M02"}]})
        )
        self.assertEqual(package_owners(folder), {"M01", "M02"})
        (folder / "request.json").write_text('{"shot": "M02"}')
        self.assertEqual(package_owners(folder), {"M02"})
        (self.root / "plan/batches/notes").mkdir()
        self.assertEqual(package_owners(self.root / "plan/batches/notes"), set())

    def test_review_spanning_an_unfinished_shot_is_not_a_leftover(self):
        folder = self.root / "plan/batches/M01-M02-review"
        folder.mkdir()
        (folder / "review-01.json").write_text(json.dumps({"shots": [{"id": "M01"}, {"id": "M02"}]}))
        self.assertEqual(collect(self.root)["problems"], [])
        (self.root / "assets/shots/M02").mkdir()
        (self.root / "assets/shots/M02/manifest.json").write_text('{"shot": "M02"}')
        (self.root / "plan/animatic/cards/M02.png").unlink()
        (self.root / "plan/animatic/cards/manifest.json").write_text(json.dumps({"cards": {"M03": {}}}))
        self.assertEqual([p["kind"] for p in collect(self.root)["problems"]], ["package_of_accepted"])


if __name__ == "__main__":
    unittest.main()
