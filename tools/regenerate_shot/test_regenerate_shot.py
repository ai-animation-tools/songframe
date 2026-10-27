"""Тесты повтора генерации: источник запроса, отказ без данных, подготовка и отправка на подставном CLI."""

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.kling_request import kling_request
from tools.regenerate_shot import regenerate_shot as tool
from tools.scene_registry import scene_registry
from tools.shot_workflow import shot_workflow

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
PROJECT = {
    "schema_version": 1,
    "name": "Тест",
    "animatic_video": "test.mp4",
    "generation": {
        "provider": "kling",
        "resolution": "1080p",
        "aspect_ratio": "16:9",
        "watermark": False,
        "duration_rule": "min_supported_strictly_greater_than_window",
    },
}
FAKE_CLI = """import json,sys,time
from pathlib import Path
base=Path(__file__).parent
with (base/'calls.jsonl').open('a') as stream:stream.write(json.dumps(sys.argv[1:])+'\\n')
config=json.loads((base/'fake.json').read_text())
if '--help' in sys.argv:print(config.get('help',''));raise SystemExit(0)
if sys.argv[1]=='account':
 print(json.dumps(config.get('account',{'ok':True,'body':{'balance':500}})));raise SystemExit(0)
if sys.argv[1]=='query_tasks':value=config['query']
else:value=config['submit']
print(json.dumps(value));raise SystemExit(config.get('exit',0))
"""


class RegenerateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for folder in ("plan/batches", "plan/awaiting", "assets/shots", "source/heroes"):
            (self.root / folder).mkdir(parents=True)
        (self.root / "plan/scenes.json").write_text(json.dumps(SCENES, ensure_ascii=False))
        (self.root / "plan/project.json").write_text(json.dumps(PROJECT, ensure_ascii=False))
        (self.root / "source/heroes/mira.png").write_bytes(b"\x89PNG mira")
        self.cli = self.root / "fake-kling"
        self.cli.write_text("#!" + sys.executable + "\n" + FAKE_CLI)
        self.cli.chmod(0o755)
        (self.root / "fake.json").write_text(
            json.dumps(
                {
                    "submit": {"ok": True, "body": {"generationId": "job-9", "creditsConsumed": 43}},
                    "query": {
                        "ok": True,
                        "body": {
                            "generationId": "job-9",
                            "status": "COMPLETED",
                            "works": [{"contentType": "video", "urlWithoutWatermark": "https://example.test/v.mp4"}],
                        },
                    },
                }
            )
        )
        scene_registry._INITIAL_CACHE.clear()
        self.patches = [
            patch.object(scene_registry, "ROOT", self.root),
            patch.object(shot_workflow, "ROOT", self.root),
            patch.object(tool, "ROOT", self.root),
            patch.object(kling_request, "ROOT", self.root),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def make_package(self):
        """Пакет плана с подготовленной попыткой, как после этапа 4 скилла."""
        package = self.root / "plan/batches/M01-attempt-01"
        shot_workflow.init("M01", package, root=self.root)
        (package / "first.png").write_bytes(b"\x89PNG first")
        (package / "video-prompt.txt").write_text("Промпт повтора", encoding="utf-8")
        spec = {
            "schema_version": 1,
            "shot": "M01",
            "kind": "video",
            "command": "image_to_video",
            "model": "kling-video-v3_0",
            "parameters": {"duration": 3, "resolution": "1080p", "aspect_ratio": "16:9", "prefer_multi_shots": False},
            "inputs": [{"flag": "input", "slot": "image_1", "path": "first.png", "role": "first"}],
            "prompt_file": "video-prompt.txt",
            "outputs": 1,
        }
        (package / "spec.json").write_text(json.dumps(spec))
        kling_request.prepare(package / "spec.json", package / "request")
        for stage in ("keyframes_review", "prompt_review"):
            shot_workflow.set_stage(package, stage, root=self.root)
        shot_workflow.set_stage(package, "request_choice", request_dir="request", root=self.root)
        return package

    def test_no_request_data_stops_with_code_3(self):
        with self.assertRaisesRegex(LookupError, "нет снимка запроса"):
            tool.regenerate(self.root, "M01", cli=str(self.cli), use_account=False)
        asset = self.root / "assets/shots/M01"
        asset.mkdir()
        (asset / "generation-request.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "shot": "M01",
                    "command": "image_to_video",
                    "model": "x",
                    "inputs": {"first": {"path": "a.png"}},
                    "prompt": {"text": "старый"},
                }
            )
        )
        with self.assertRaisesRegex(LookupError, "старом формате"):
            tool.regenerate(self.root, "M01", cli=str(self.cli), use_account=False)
        (asset / "generation-request.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "shot": "M01",
                    "provider": "Runway",
                    "command": "x",
                    "model": "y",
                    "inputs": [],
                    "prompt": "p.txt",
                }
            )
        )
        with self.assertRaisesRegex(LookupError, "Runway"):
            tool.regenerate(self.root, "M01", cli=str(self.cli), use_account=False)

    def test_repeats_package_request_and_submits_on_fake_cli(self):
        package = self.make_package()
        info = tool.regenerate(self.root, "M01", cli=str(self.cli), use_account=True)
        self.assertEqual(info["source"], "package")
        self.assertEqual(Path(info["package"]).name, "M01-attempt-02")
        self.assertEqual(info["retry_of"], "plan/batches/M01-attempt-01")
        self.assertEqual(info["cost"]["verdict"], "ok")
        self.assertEqual(info["cost"]["balance_credits"], 500)
        original = json.loads((package / "request/request.json").read_text())
        repeated = json.loads((Path(info["work_dir"]) / "request.json").read_text())
        self.assertEqual(original["inputs"][0]["sha256"], repeated["inputs"][0]["sha256"])
        self.assertEqual(original["prompt"]["sha256"], repeated["prompt"]["sha256"])
        self.assertEqual(json.loads((Path(info["package"]) / "workflow.json").read_text())["stage"], "request_choice")
        with patch.object(
            kling_request, "download", side_effect=lambda url, destination: Path(destination).write_bytes(b"video")
        ):
            pricing = self.root / "pricing.json"
            pricing.write_text(json.dumps({"schema_version": 1, "models": {}, "observed": []}))
            state = tool.submit_and_watch(
                self.root,
                info,
                cli=str(self.cli),
                max_minutes=1,
                interval=5,
                report=lambda *_: None,
                pricing_path=pricing,
            )
        self.assertEqual(state["status"], "downloaded")
        self.assertEqual(json.loads((Path(info["package"]) / "workflow.json").read_text())["stage"], "downloaded")
        calls = [json.loads(line) for line in (self.root / "calls.jsonl").read_text().splitlines()]
        self.assertEqual(sum(1 for c in calls if c and c[0] not in ("query_tasks", "account")), 1)
        self.assertEqual(json.loads(pricing.read_text())["observed"][0]["credits"], 43)

    def test_asset_snapshot_in_frozen_format_is_repeatable_and_settings_mismatch_stops(self):
        asset = self.root / "assets/shots/M01"
        asset.mkdir()
        (asset / "generation-input-1.png").write_bytes(b"\x89PNG frame")
        (asset / "generation-prompt.txt").write_text("Промпт из комплекта", encoding="utf-8")
        snapshot = {
            "schema_version": 1,
            "shot": "M01",
            "provider": "Kling",
            "command": "image_to_video",
            "model": "kling-video-v3_0",
            "parameters": {"duration": 3, "resolution": "1080p", "prefer_multi_shots": False},
            "outputs": 1,
            "inputs": [{"slot": "image_1", "role": "first", "path": "generation-input-1.png"}],
            "prompt": "generation-prompt.txt",
            "path_base": "asset_directory",
        }
        (asset / "generation-request.json").write_text(json.dumps(snapshot, ensure_ascii=False))
        info = tool.regenerate(self.root, "M01", cli=str(self.cli), use_account=False)
        self.assertEqual(info["source"], "asset")
        self.assertIsNone(info["retry_of"])
        self.assertEqual(info["cost"]["verdict"], "cost_or_balance_unknown")
        with self.assertRaisesRegex(LookupError, "остановлена"):
            tool.submit_and_watch(self.root, info, cli=str(self.cli))
        snapshot["parameters"]["resolution"] = "720p"
        (asset / "generation-request.json").write_text(json.dumps(snapshot, ensure_ascii=False))
        shutil.rmtree(info["package"])
        with self.assertRaisesRegex(LookupError, "разрешение запроса 720p"):
            tool.regenerate(self.root, "M01", source="asset", cli=str(self.cli), use_account=False)


if __name__ == "__main__":
    unittest.main()
