"""Оценка стоимости и остатка без обращения к сервису; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import copy
import json
import os
import tempfile
import unittest
import unittest.mock

from tools import kling_cli
from tools.cost_check import cost_check as tool


class CostCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cost-check-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.pricing_path = self.root / "pricing.json"
        self.pricing = {
            "schema_version": 1,
            "currency": "credits",
            "models": {
                "kling-video-v3_0": {"base_credits": 2, "per_second": {"1080p": 7, "720p": None}},
                "kling-video-v4_0": {"base_credits": 0, "per_second": {"1080p": None}},
            },
            "observed": [],
        }
        self.pricing_path.write_text(json.dumps(self.pricing))
        self.request = {
            "schema_version": 1,
            "shot": "M32",
            "kind": "video",
            "command": "image_to_video",
            "model": "kling-video-v3_0",
            "parameters": {"duration": 7, "resolution": "1080p", "prefer_multi_shots": False},
            "outputs": 1,
        }
        self.cli = self.root / "fake-kling"
        self.cli.write_text(
            "#!" + sys.executable + "\nimport json,sys\nfrom pathlib import Path\n"
            "print(json.dumps(json.loads((Path(__file__).parent/'account.json').read_text())))\n"
        )
        self.cli.chmod(0o755)
        self.account({"ok": True, "body": {"membership": "pro", "credits": {"total": 2000, "remaining": 1824}}})

    def account(self, value):
        (self.root / "account.json").write_text(json.dumps(value))

    def test_estimate_uses_table_then_observations(self):
        pricing = tool.load_pricing(self.pricing_path)
        self.assertEqual(tool.estimate(pricing, self.request)["credits"], 2 + 7 * 7)
        self.request["outputs"] = 2
        self.assertEqual(tool.estimate(pricing, self.request)["credits"], (2 + 7 * 7) * 2)
        self.request["outputs"] = 1
        self.request["model"] = "kling-video-v4_0"
        self.assertIsNone(tool.estimate(pricing, self.request)["credits"])
        pricing["observed"].append(
            {
                "model": "kling-video-v4_0",
                "kind": "video",
                "resolution": "1080p",
                "duration": 5,
                "outputs": 1,
                "credits": 50,
            }
        )
        scaled = tool.estimate(pricing, self.request)
        self.assertEqual(scaled["credits"], 70)
        self.assertIn("пересчёт", scaled["source"])
        pricing["observed"].append(
            {
                "model": "kling-video-v4_0",
                "kind": "video",
                "resolution": "1080p",
                "duration": 7,
                "outputs": 1,
                "credits": 66,
            }
        )
        self.assertEqual(tool.estimate(pricing, self.request)["credits"], 66)
        self.request["model"] = "kling-video-o1"
        self.assertIn("отсутствует", tool.estimate(pricing, self.request)["missing"][0])

    def test_balance_from_account_prefers_remaining_and_keeps_only_number(self):
        balance, source = tool.account_balance(str(self.cli))
        self.assertEqual((balance, source), (1824.0, "credits.remaining"))
        self.account({"ok": False})
        self.assertEqual(tool.account_balance(str(self.cli))[0], None)
        self.account({"ok": True, "body": {"membership": "pro"}})
        self.assertIn("нет числового поля", tool.account_balance(str(self.cli))[1])

    def test_bundled_account_uses_the_same_prefix_and_only_child_electron_mode(self):
        script = self.root / "bundled CLI.js"
        script.write_text(self.cli.read_text())
        env = {
            "SONGFRAME_KLING_EXECUTABLE": sys.executable,
            "SONGFRAME_KLING_SCRIPT": str(script),
            "ELECTRON_RUN_AS_NODE": "parent-value",
        }
        with unittest.mock.patch.dict(os.environ, env):
            with unittest.mock.patch.object(kling_cli.subprocess, "run", wraps=kling_cli.subprocess.run) as runner:
                self.assertEqual(tool.account_balance(), (1824.0, "credits.remaining"))
                self.assertEqual(runner.call_args.args[0], [sys.executable, str(script), "account", "--quiet"])
                self.assertIs(runner.call_args.kwargs["shell"], False)
                self.assertEqual(runner.call_args.kwargs["env"]["ELECTRON_RUN_AS_NODE"], "1")
            self.assertEqual(os.environ["ELECTRON_RUN_AS_NODE"], "parent-value")

    def test_missing_bundle_never_uses_global_account_but_explicit_cli_still_works(self):
        env = {"SONGFRAME_KLING_EXECUTABLE": sys.executable, "SONGFRAME_KLING_SCRIPT": str(self.root / "missing.js")}
        with unittest.mock.patch.dict(os.environ, env):
            with unittest.mock.patch.object(kling_cli.subprocess, "run", wraps=kling_cli.subprocess.run) as runner:
                balance, reason = tool.account_balance()
                self.assertIsNone(balance)
                self.assertIn("Встроенный Kling CLI недоступен", reason)
                runner.assert_not_called()
                self.assertEqual(tool.account_balance(str(self.cli)), (1824.0, "credits.remaining"))
                self.assertEqual(runner.call_args.args[0], [str(self.cli), "account", "--quiet"])

    def test_verdicts_and_manual_balance(self):
        pricing = tool.load_pricing(self.pricing_path)
        report = tool.check(self.request, pricing, cli=str(self.cli))
        self.assertEqual(
            (report["verdict"], report["estimate_credits"], report["balance_credits"]), ("ok", 51.0, 1824.0)
        )
        self.account({"ok": True, "body": {"credits": {"remaining": 10}}})
        self.assertEqual(tool.check(self.request, pricing, cli=str(self.cli))["verdict"], "insufficient_balance")
        self.assertEqual(tool.check(self.request, pricing, balance=51, use_account=False)["verdict"], "ok")
        unknown = tool.check(self.request, pricing, use_account=False)
        self.assertEqual(unknown["verdict"], "cost_or_balance_unknown")
        self.assertTrue(any("остаток неизвестен" in r for r in unknown["reasons"]))
        self.request["model"] = "kling-video-v4_0"
        unknown = tool.check(self.request, pricing, balance=1000, use_account=False)
        self.assertEqual(unknown["verdict"], "cost_or_balance_unknown")
        self.assertIn("| Вердикт | стоимость или баланс неизвестны (`cost_or_balance_unknown`) |", tool.table(unknown))

    def test_learn_records_consumed_credits_once(self):
        work = self.root / "attempt"
        work.mkdir()
        (work / "request.json").write_text(json.dumps(self.request))
        (work / "attempt.json").write_text(json.dumps({"status": "submitted", "credits_consumed": 49}))
        with unittest.mock.patch.object(tool, "work_path", lambda value: Path(value)):
            observation = tool.learn(work, self.pricing_path)
            tool.learn(work, self.pricing_path)
        self.assertEqual(observation["credits"], 49.0)
        self.assertEqual(len(tool.load_pricing(self.pricing_path)["observed"]), 1)
        (work / "attempt.json").write_text(json.dumps({"status": "prepared"}))
        with unittest.mock.patch.object(tool, "work_path", lambda value: Path(value)), self.assertRaises(ValueError):
            tool.learn(work, self.pricing_path)

    def image_request(self):
        return {
            "schema_version": 1,
            "shot": "M32",
            "kind": "image",
            "command": "text_to_image",
            "model": "kling-image-v3_0_omni",
            "parameters": {"img_resolution": "1k", "aspect_ratio": "16:9", "quality": "low", "imageCount": 1},
            "outputs": 1,
            "inputs": [],
        }

    def learn_image(self, request, credits=1):
        work = self.root / "image-attempt"
        work.mkdir(exist_ok=True)
        (work / "request.json").write_text(json.dumps(request))
        (work / "attempt.json").write_text(json.dumps({"status": "downloaded", "credits_consumed": credits}))
        with unittest.mock.patch.object(tool, "work_path", lambda value: Path(value)):
            return tool.learn(work, self.pricing_path)

    def test_image_learn_prices_exact_configuration_without_model_table_entry(self):
        request = self.image_request()
        observation = self.learn_image(request)
        pricing = tool.load_pricing(self.pricing_path)
        self.assertNotIn(request["model"], pricing["models"])
        self.assertEqual(observation["kind"], "image")
        self.assertEqual(observation["command"], "text_to_image")
        self.assertEqual(observation["img_resolution"], "1k")
        self.assertEqual(observation["quality"], "low")
        self.assertNotIn("duration", observation)
        self.assertEqual(tool.estimate(pricing, request)["credits"], 1)
        self.assertEqual(tool.check(request, pricing, balance=1, use_account=False)["verdict"], "ok")
        self.learn_image(request)
        self.assertEqual(len(tool.load_pricing(self.pricing_path)["observed"]), 1)

    def test_image_observation_never_transfers_to_other_significant_settings(self):
        request = self.image_request()
        self.learn_image(request)
        pricing = tool.load_pricing(self.pricing_path)
        changes = [
            ("command", "image_to_image"),
            ("model", "another-image-model"),
            ("outputs", 9),
            ("parameters", {**request["parameters"], "img_resolution": "4k"}),
            ("parameters", {**request["parameters"], "quality": "high"}),
            ("parameters", {**request["parameters"], "aspect_ratio": "1:1"}),
            ("parameters", {**request["parameters"], "imageCount": 9}),
            ("parameters", {**request["parameters"], "story_mode": False}),
            ("parameters", {**request["parameters"], "prompt_enhance": True}),
            ("inputs", [{"flag": "input", "slot": "image_1", "role": "reference", "path": "reference.png"}]),
        ]
        for field, value in changes:
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(request)
                changed[field] = value
                self.assertIsNone(tool.estimate(pricing, changed)["credits"])
                self.assertEqual(
                    tool.check(changed, pricing, balance=1000, use_account=False)["verdict"], "cost_or_balance_unknown"
                )

    def test_image_reference_count_and_slots_are_exact_but_local_metadata_does_not_define_tariff(self):
        request = self.image_request()
        request["command"] = "image_to_image"
        request["parameters"]["story_mode"] = False
        request["inputs"] = [
            {
                "flag": "input",
                "slot": "image_1",
                "role": "reference",
                "path": "first.png",
                "sha256": "first-sha",
                "bytes": 100,
            }
        ]
        self.learn_image(request)
        pricing = tool.load_pricing(self.pricing_path)
        changed = copy.deepcopy(request)
        changed["inputs"][0].update(path="next.jpg", sha256="next-sha", bytes=200)
        self.assertEqual(tool.estimate(pricing, changed)["credits"], 1)
        changed["inputs"][0]["role"] = "first"
        self.assertEqual(tool.estimate(pricing, changed)["credits"], 1)
        changed["inputs"][0]["slot"] = "style_image"
        self.assertIsNone(tool.estimate(pricing, changed)["credits"])
        changed = copy.deepcopy(request)
        changed["inputs"].append({"flag": "input", "slot": "image_2", "role": "reference", "path": "second.png"})
        self.assertIsNone(tool.estimate(pricing, changed)["credits"])
        changed = copy.deepcopy(request)
        changed["inputs"] = []
        self.assertIsNone(tool.estimate(pricing, changed)["credits"])

    def test_image_signature_is_canonical_and_excludes_prompt_and_credentials(self):
        request = self.image_request()
        request["parameters"].update(
            {
                "prompt": "PRIVATE PROMPT",
                "credentials": {"token": "PRIVATE TOKEN"},
                "options": {"quality_mode": "low", "prompt": "PRIVATE NESTED PROMPT"},
            }
        )
        observation = self.learn_image(request)
        self.assertNotIn("PRIVATE", json.dumps(observation))
        changed = copy.deepcopy(request)
        changed["parameters"] = dict(reversed(list(changed["parameters"].items())))
        changed["parameters"]["prompt"] = "different subject"
        changed["parameters"]["credentials"] = {"token": "different secret"}
        self.assertEqual(tool.image_signature(request), tool.image_signature(changed))
        self.assertEqual(tool.estimate(tool.load_pricing(self.pricing_path), changed)["credits"], 1)
        changed["parameters"]["options"]["quality_mode"] = "high"
        self.assertIsNone(tool.estimate(tool.load_pricing(self.pricing_path), changed)["credits"])

    def test_image_observation_is_total_cost_and_never_video_rate(self):
        request = self.image_request()
        request["outputs"] = 9
        request["parameters"]["imageCount"] = 9
        self.learn_image(request, credits=7)
        pricing = tool.load_pricing(self.pricing_path)
        self.assertEqual(tool.estimate(pricing, request)["credits"], 7)
        changed = copy.deepcopy(request)
        changed["outputs"] = 1
        changed["parameters"]["imageCount"] = 1
        self.assertIsNone(tool.estimate(pricing, changed)["credits"])
        pricing["models"][request["model"]] = {"per_second": {"1k": 1}, "base_credits": 0}
        changed["parameters"].update(duration=1, resolution="1k")
        self.assertIsNone(tool.estimate(pricing, changed)["credits"])
        self.assertNotIn("per_image", pricing["models"][request["model"]])

    def test_legacy_image_observation_without_signature_is_not_an_exact_tariff(self):
        request = self.image_request()
        pricing = tool.load_pricing(self.pricing_path)
        pricing["observed"].append(
            {
                "kind": "image",
                "model": request["model"],
                "resolution": "1k",
                "duration": None,
                "outputs": 1,
                "credits": 1,
            }
        )
        self.assertIsNone(tool.estimate(pricing, request)["credits"])
        pricing["models"][request["model"]] = {"per_image": 2}
        self.assertEqual(tool.estimate(pricing, request)["credits"], 2)

    def test_image_price_table_shows_image_resolution_and_command_without_duration(self):
        request = self.image_request()
        self.learn_image(request)
        report = tool.check(request, tool.load_pricing(self.pricing_path), balance=10, use_account=False)
        table = tool.table(report)
        self.assertIn("command=text_to_image", table)
        self.assertIn("img_resolution=1k", table)
        self.assertIn("quality=low", table)
        self.assertNotIn("duration=", table)
        self.assertEqual(report["estimate_credits"], 1)


if __name__ == "__main__":
    unittest.main()
