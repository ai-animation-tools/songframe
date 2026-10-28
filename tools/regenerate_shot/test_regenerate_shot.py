"""Тесты повтора генерации: источник запроса, отказ без данных, подготовка и отправка на подставном CLI."""

import hashlib
import io
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
        "video": {
            "provider": "kling",
            "resolution": "1080p",
            "aspect_ratio": "16:9",
            "watermark": False,
            "duration_rule": "min_supported_strictly_greater_than_window",
        },
        "image": {"provider": "kling"},
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
            "provider": "kling",
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

    def make_asset(self):
        """Канонический снимок с двумя точными входами; данные создаются только во временном проекте."""
        asset = self.root / "assets/shots/M01"
        asset.mkdir(exist_ok=True)
        inputs = []
        for number in (1, 2):
            path = asset / f"generation-input-{number}.png"
            path.write_bytes(b"\x89PNG\r\n" + bytes([number]))
            inputs.append(
                {
                    "slot": f"image_{number}",
                    "role": f"Кадр {number}",
                    "path": path.name,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                }
            )
        prompt = asset / "generation-prompt.txt"
        prompt.write_bytes("Сохранённый промпт\r\nТочные байты.\n".encode("utf-8"))
        snapshot = {
            "schema_version": 1,
            "shot": "M01",
            "provider": "Kling",
            "command": "image_to_video",
            "model": "kling-video-v3_0_omni",
            "parameters": {
                "duration": "6",
                "resolution": "1080p",
                "aspect_ratio": "16:9",
                "imageCount": "1",
                "prefer_multi_shots": "false",
                "enable_audio": "false",
            },
            "inputs": inputs,
            "prompt": prompt.name,
            "prompt_sha256": hashlib.sha256(prompt.read_bytes()).hexdigest(),
            "outputs": 1,
            "output": {"original": "original.mp4"},
            "elements": [],
            "audio_inputs": [],
            "path_base": "asset_directory",
            "cli_argv_before_prompt": ["obsolete-cli", "must-not-run"],
        }
        self.write_snapshot(snapshot)
        return asset, snapshot

    def write_snapshot(self, snapshot):
        path = self.root / "assets/shots/M01/generation-request.json"
        path.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")

    def assert_cli_data_error(self, message):
        """Ошибки снимка дают штатный код 3 без создания пакета и без вызова CLI."""
        with patch.object(sys, "argv", ["regenerate_shot", "M01", "--source", "asset", "--json"]):
            with patch("sys.stderr", new_callable=io.StringIO) as stderr:
                with self.assertRaises(SystemExit) as stopped:
                    tool.main()
        self.assertEqual(stopped.exception.code, 3)
        self.assertIn(message, stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())
        self.assertEqual(list((self.root / "plan/batches").iterdir()), [])
        self.assertFalse((self.root / "calls.jsonl").exists())

    def test_asset_snapshot_prepares_exact_request_without_submit(self):
        asset, snapshot = self.make_asset()
        before = {path.name: path.read_bytes() for path in asset.iterdir()}
        info = tool.regenerate(self.root, "M01", source="asset", cli=str(self.cli))
        request_dir = Path(info["work_dir"])
        request = json.loads((request_dir / "request.json").read_text())
        self.assertEqual(request["command"], snapshot["command"])
        self.assertEqual(request["model"], snapshot["model"])
        self.assertEqual(request["parameters"], snapshot["parameters"])
        self.assertEqual(request["outputs"], 1)
        self.assertEqual((request_dir / request["prompt"]["path"]).read_bytes(), before["generation-prompt.txt"])
        self.assertEqual(request["prompt"]["sha256"], snapshot["prompt_sha256"])
        for original, repeated in zip(snapshot["inputs"], request["inputs"], strict=True):
            self.assertEqual((request_dir / repeated["path"]).read_bytes(), before[original["path"]])
            self.assertEqual(repeated["sha256"], original["sha256"])
            self.assertEqual(repeated["slot"], original["slot"])
            self.assertEqual(repeated["role"], original["role"])
            self.assertEqual(repeated["flag"], "input")
        self.assertEqual({path.name: path.read_bytes() for path in asset.iterdir()}, before)
        calls = [json.loads(line) for line in (self.root / "calls.jsonl").read_text().splitlines()]
        self.assertEqual(calls, [["account", "--quiet"]])
        self.assertEqual(info["cost"]["balance_credits"], 500)
        self.assertEqual(json.loads((Path(info["package"]) / "workflow.json").read_text())["stage"], "request_choice")

    def test_provider_accepts_case_insensitive_kling_name(self):
        _, snapshot = self.make_asset()
        for provider in ("Kling", "kLiNg", " Kling "):
            with self.subTest(provider=provider):
                snapshot["provider"] = provider
                self.write_snapshot(snapshot)
                self.assertEqual(tool.spec_from_asset(self.root, "M01")["model"], snapshot["model"])

    def test_noncanonical_snapshot_is_code_3(self):
        _, snapshot = self.make_asset()
        mutations = [
            {"provider": "Kling AI"},
            {"provider": "klingAI"},
            {"prompt": {"path": snapshot["prompt"], "sha256": snapshot["prompt_sha256"]}},
            {"prompt": ""},
            {"prompt": None},
            {"prompt": "missing.txt"},
            {"prompt_sha256": "wrong"},
            {"path_base": "project_directory"},
        ]
        for fields in mutations:
            with self.subTest(fields=fields):
                self.write_snapshot(snapshot | fields)
                self.assert_cli_data_error("M01")
        for field in ("provider", "outputs", "parameters", "command", "model", "prompt_sha256", "path_base"):
            with self.subTest(missing=field):
                self.write_snapshot({key: value for key, value in snapshot.items() if key != field})
                self.assert_cli_data_error("M01")

    def test_changed_prompt_and_input_hashes_are_code_3(self):
        asset, snapshot = self.make_asset()
        for name in ("generation-prompt.txt", "generation-input-2.png"):
            with self.subTest(name=name):
                path = asset / name
                original = path.read_bytes()
                path.write_bytes(original + b"changed")
                self.assert_cli_data_error("хеш" if "prompt" in name else "Хеш")
                path.write_bytes(original)
        _, snapshot = self.make_asset()
        snapshot["prompt_sha256"] = "wrong"
        self.write_snapshot(snapshot)
        self.assert_cli_data_error("SHA-256")

    def test_foreign_provider_is_code_3(self):
        _, snapshot = self.make_asset()
        snapshot["provider"] = "Runway"
        self.write_snapshot(snapshot)
        self.assert_cli_data_error("Runway")

    def test_incomplete_and_invalid_data_is_code_3_before_package(self):
        _, snapshot = self.make_asset()
        mutations = [
            {"parameters": []},
            {"model": None},
            {"command": []},
            {"inputs": [None]},
            {"inputs": [{"slot": "image_1"}]},
            {"inputs": []},
            {"inputs": [{"path": "generation-input-1.png"}]},
            {"parameters": {"duration": "6"}},
            {"elements": [{"id": "lost"}]},
        ]
        for fields in mutations:
            with self.subTest(fields=fields):
                self.write_snapshot(snapshot | fields)
                self.assert_cli_data_error("M01")

    def test_snapshot_preserves_image_flag_and_output_count(self):
        _, snapshot = self.make_asset()
        snapshot["inputs"] = [{"flag": "image", **{k: v for k, v in snapshot["inputs"][0].items() if k != "slot"}}]
        snapshot["outputs"] = 2
        snapshot["parameters"]["imageCount"] = "2"
        self.write_snapshot(snapshot)
        info = tool.regenerate(self.root, "M01", source="asset", cli=str(self.cli), use_account=False)
        request = json.loads((Path(info["work_dir"]) / "request.json").read_text())
        self.assertEqual(request["inputs"][0]["flag"], "image")
        self.assertNotIn("slot", request["inputs"][0])
        self.assertEqual(request["outputs"], 2)
        self.assertEqual(request["parameters"], snapshot["parameters"])

    def test_shared_source_descriptor_keeps_exact_input(self):
        _, snapshot = self.make_asset()
        source = self.root / "source/heroes/mira.png"
        snapshot["inputs"][0].update(
            {
                "root": "source",
                "path": "heroes/mira.png",
                "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            }
        )
        self.write_snapshot(snapshot)
        info = tool.regenerate(self.root, "M01", source="asset", cli=str(self.cli), use_account=False)
        request_dir = Path(info["work_dir"])
        request = json.loads((request_dir / "request.json").read_text())
        self.assertEqual((request_dir / request["inputs"][0]["path"]).read_bytes(), source.read_bytes())

    def test_frozen_snapshot_preserves_model_selection_and_checks_prompt_hash(self):
        package = self.make_package()
        path = package / "request/request.json"
        original = json.loads(path.read_text())
        selection = {"preferredModel": None, "selectedModel": original["model"], "reason": "Выбрана по возможностям"}
        original["model_selection"] = selection
        path.write_text(json.dumps(original, ensure_ascii=False))
        info = tool.regenerate(self.root, "M01", source="package", cli=str(self.cli), use_account=False)
        request = json.loads((Path(info["work_dir"]) / "request.json").read_text())
        self.assertEqual(request["model_selection"], selection)
        shutil.rmtree(info["package"])
        (package / "request/prompt.txt").write_text("Изменённый промпт", encoding="utf-8")
        with self.assertRaisesRegex(LookupError, "хеш промпта"):
            tool.regenerate(self.root, "M01", source="package", cli=str(self.cli), use_account=False)

    def test_frozen_request_requires_native_prompt_and_explicit_input_flag(self):
        package = self.make_package()
        path = package / "request/request.json"
        original = json.loads(path.read_text())
        mutations = [
            original | {"prompt": "prompt.txt"},
            original | {"inputs": [{key: value for key, value in original["inputs"][0].items() if key != "flag"}]},
            {key: value for key, value in original.items() if key != "outputs"},
            {key: value for key, value in original.items() if key != "provider"},
        ]
        for request in mutations:
            with self.subTest(request=request):
                path.write_text(json.dumps(request))
                with self.assertRaises(LookupError):
                    tool.regenerate(self.root, "M01", source="package", cli=str(self.cli), use_account=False)
                self.assertEqual(list((self.root / "plan/batches").iterdir()), [package])
                self.assertFalse((self.root / "calls.jsonl").exists())

    def test_asset_model_selection_and_explicit_image_kind_are_preserved(self):
        _, snapshot = self.make_asset()
        snapshot.update(kind="image", command="image_to_image", model="kling-image-o1")
        selection = {"preferredModel": None, "selectedModel": snapshot["model"], "reason": "Выбрана по возможностям"}
        snapshot["model_selection"] = selection
        self.write_snapshot(snapshot)
        info = tool.regenerate(self.root, "M01", source="asset", cli=str(self.cli), use_account=False)
        request = json.loads((Path(info["work_dir"]) / "request.json").read_text())
        self.assertEqual(request["kind"], "image")
        self.assertEqual(request["model_selection"], selection)

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
        with self.assertRaisesRegex(LookupError, "провайдер снимка"):
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
        with self.assertRaisesRegex(LookupError, "path_base"):
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

    def test_generic_provider_prepares_asset_and_repeats_frozen_without_kling(self):
        """Чужой адаптер не вызывается: точный снимок готовится без знания команд сервиса."""
        asset, snapshot = self.make_asset()
        snapshot.update(provider=" GPTunnel ", command="generate", model="provider/model", outputs=12)
        # Ограничение начала промпта флагом относится к CLI Kling, а не к общему снимку.
        prompt = asset / snapshot["prompt"]
        prompt.write_bytes(b"--saved exact prompt\r\n")
        snapshot["prompt_sha256"] = hashlib.sha256(prompt.read_bytes()).hexdigest()
        snapshot["parameters"] = {"arbitraryOption": {"mode": "saved"}}
        snapshot["inputs"][0]["flag"] = "reference"
        self.write_snapshot(snapshot)
        project = json.loads((self.root / "plan/project.json").read_text())
        project["generation"]["video"]["provider"] = "gPtUnNeL"
        (self.root / "plan/project.json").write_text(json.dumps(project))
        with patch.object(tool.cost_check, "check", side_effect=AssertionError("Вызван Kling cost_check")):
            info = tool.regenerate(self.root, "M01", source="asset", cli=str(self.cli), executor="app")
            frozen_dir = Path(info["work_dir"])
            frozen = json.loads((frozen_dir / "request.json").read_text())
            self.assertEqual(frozen["provider"], " GPTunnel ")
            self.assertEqual(frozen["command"], "generate")
            self.assertEqual(frozen["outputs"], 12)
            self.assertEqual(frozen["parameters"], snapshot["parameters"])
            self.assertEqual(frozen["inputs"][0]["flag"], "reference")
            self.assertNotIn("video_without_watermark", frozen)
            self.assertEqual((frozen_dir / "prompt.txt").read_bytes(), (asset / snapshot["prompt"]).read_bytes())
            repeated = tool.regenerate(self.root, "M01", source="package", cli=str(self.cli))
        self.assertEqual(repeated["provider"], " GPTunnel ")
        self.assertEqual(repeated["request_sha256"], info["request_sha256"])
        self.assertEqual(info["cost"]["verdict"], "cost_or_balance_unknown")
        # Даже подменённый положительный cost report не подключает несуществующий адаптер.
        with self.assertRaisesRegex(LookupError, "не подключен исполнитель отправки"):
            tool.submit_and_watch(self.root, info | {"cost": {"verdict": "ok"}}, cli=str(self.cli))
        self.assertFalse((self.root / "calls.jsonl").exists())
        self.assertEqual(json.loads((frozen_dir / "attempt.json").read_text())["status"], "prepared")

    def test_auto_does_not_hide_damaged_latest_request_with_valid_asset(self):
        """Существующий последний frozen определяет источник; повреждение требует исправления явно."""
        package = self.make_package()
        self.make_asset()
        path = package / "request/request.json"
        original = json.loads(path.read_text())
        mutations = [
            {key: value for key, value in original.items() if key != "provider"},
            original | {"schema_version": 2},
            original | {"prompt": {"path": "missing.txt", "sha256": "a" * 64}},
        ]
        for request in mutations:
            with self.subTest(request=request):
                path.write_text(json.dumps(request))
                with self.assertRaises(LookupError):
                    tool.regenerate(self.root, "M01", source="auto", cli=str(self.cli), executor="app")
                self.assertEqual(list((self.root / "plan/batches").iterdir()), [package])
                self.assertFalse((self.root / "calls.jsonl").exists())

    def test_app_executor_records_question_and_requires_send_before_submit(self):
        """Владелец и вопрос включают кнопки приложения, но сами не разрешают платную отправку."""
        self.make_package()
        info = tool.regenerate(self.root, "M01", source="package", cli=str(self.cli), executor="app")
        workflow = json.loads((Path(info["package"]) / "workflow.json").read_text())
        self.assertEqual(workflow["executor"], "app")
        self.assertEqual(workflow["pending_decision"]["stage"], "request_choice")
        self.assertEqual(workflow["pending_decision"]["executor"], "app")
        self.assertEqual(workflow["pending_decision"]["options"], ["send", "park", "revise"])
        with patch.object(kling_request, "submit", side_effect=AssertionError("Отправка до согласия")):
            with self.assertRaisesRegex(LookupError, "ответа send"):
                tool.submit_and_watch(self.root, info, cli=str(self.cli))
        shot_workflow.decide(info["package"], "send", root=self.root)
        with patch.object(kling_request, "submit") as submit, patch.object(kling_request, "watch", return_value={}), \
                patch.object(tool.cost_check, "learn"):
            tool.submit_and_watch(self.root, info, cli=str(self.cli))
        submit.assert_called_once_with(Path(info["work_dir"]), info["request_sha256"], cli=str(self.cli))

    def test_cli_executor_app_is_forwarded(self):
        """Приложение выбирает владельца через CLI, обычный вызов остаётся агентским."""
        self.make_asset()
        with patch.object(sys, "argv", ["regenerate_shot", "M01", "--source", "asset", "--executor", "app",
                                       "--no-account", "--json"]), patch("sys.stdout", new_callable=io.StringIO) as output:
            tool.main()
        info = json.loads(output.getvalue())
        self.assertEqual(info["executor"], "app")
        self.assertEqual(json.loads((Path(info["package"]) / "workflow.json").read_text())["executor"], "app")

    def test_image_retry_compares_image_provider_independently(self):
        """Для изображения не применяется провайдер видеогенерации проекта."""
        _, snapshot = self.make_asset()
        snapshot.update(provider="Codex", kind="image", command="generate", model="image-model", parameters={})
        self.write_snapshot(snapshot)
        project = json.loads((self.root / "plan/project.json").read_text())
        project["generation"]["image"] = {"provider": " codex "}
        (self.root / "plan/project.json").write_text(json.dumps(project))
        info = tool.regenerate(self.root, "M01", source="asset", cli=str(self.cli))
        self.assertEqual(info["provider"], "Codex")
        self.assertFalse((self.root / "calls.jsonl").exists())

    def test_asset_settings_mismatch_stops_before_package_creation(self):
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
            "prompt_sha256": hashlib.sha256((asset / "generation-prompt.txt").read_bytes()).hexdigest(),
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
