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

from tools.cost_check import cost_check as tool
from tools.testing import fake_media_request as fake


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
                "test-video": {"base_credits": 2, "per_second": {"1080p": 7, "720p": None}},
                "test-video-fast": {"base_credits": 0, "per_second": {"1080p": None}},
            },
            "observed": [],
        }
        self.pricing_path.write_text(json.dumps(self.pricing))
        self.request = {
            "schema_version": 1,
            "shot": "M32",
            "kind": "video",
            "provider": "test",
            "command": "image_to_video",
            "model": "test-video",
            "parameters": {"duration": 7, "resolution": "1080p"},
            "outputs": 1,
        }
        self.service = fake.enable(self, balance=1824)

    def test_estimate_uses_table_then_observations(self):
        pricing = tool.load_pricing(self.pricing_path)
        self.assertEqual(tool.estimate(pricing, self.request)["credits"], 2 + 7 * 7)
        self.request["outputs"] = 2
        self.assertEqual(tool.estimate(pricing, self.request)["credits"], (2 + 7 * 7) * 2)
        self.request["outputs"] = 1
        self.request["model"] = "test-video-fast"
        self.assertIsNone(tool.estimate(pricing, self.request)["credits"])
        pricing["observed"].append(
            {
                "model": "test-video-fast",
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
                "model": "test-video-fast",
                "kind": "video",
                "resolution": "1080p",
                "duration": 7,
                "outputs": 1,
                "credits": 66,
            }
        )
        self.assertEqual(tool.estimate(pricing, self.request)["credits"], 66)
        self.request["model"] = "test-video-unknown"
        self.assertIn("отсутствует", tool.estimate(pricing, self.request)["missing"][0])

    def test_balance_comes_from_provider_adapter(self):
        report = tool.check(self.request, tool.load_pricing(self.pricing_path))
        self.assertEqual((report["balance_credits"], report["balance_source"]), (1824.0, "тестовый сервис"))
        self.assertEqual([entry["action"] for entry in self.service.calls()], ["account"])
        self.service.configure(balance=None)
        report = tool.check(self.request, tool.load_pricing(self.pricing_path))
        self.assertEqual(report["verdict"], "cost_or_balance_unknown")
        self.assertIn("остаток неизвестен: тестовый сервис не сообщил остаток", report["reasons"])
        tool.check(self.request, tool.load_pricing(self.pricing_path), use_account=False)
        self.assertEqual(len(self.service.calls("account")), 2)

    def test_default_pricing_belongs_to_provider_adapter(self):
        self.assertEqual(tool.pricing_path(self.request), self.service.directory / "pricing.json")
        self.assertEqual(tool.pricing_path(self.request, self.pricing_path), self.pricing_path)
        self.request["provider"] = "unknown"
        with self.assertRaisesRegex(ValueError, "нет адаптера"):
            tool.pricing_path(self.request)

    def test_verdicts_and_manual_balance(self):
        pricing = tool.load_pricing(self.pricing_path)
        report = tool.check(self.request, pricing)
        self.assertEqual(
            (report["verdict"], report["estimate_credits"], report["balance_credits"]), ("ok", 51.0, 1824.0)
        )
        self.service.configure(balance=10)
        self.assertEqual(tool.check(self.request, pricing)["verdict"], "insufficient_balance")
        self.assertEqual(tool.check(self.request, pricing, balance=51, use_account=False)["verdict"], "ok")
        unknown = tool.check(self.request, pricing, use_account=False)
        self.assertEqual(unknown["verdict"], "cost_or_balance_unknown")
        self.assertTrue(any("остаток неизвестен" in r for r in unknown["reasons"]))
        self.request["model"] = "test-video-fast"
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
        self.assertEqual(len(tool.load_pricing(self.pricing_path, "test")["observed"]), 1)
        (work / "attempt.json").write_text(json.dumps({"status": "prepared"}))
        with unittest.mock.patch.object(tool, "work_path", lambda value: Path(value)), self.assertRaises(ValueError):
            tool.learn(work, self.pricing_path)

    def test_learn_keeps_base_table_and_writes_observations_to_state(self):
        work = self.root / "attempt"
        work.mkdir()
        (work / "request.json").write_text(json.dumps(self.request))
        (work / "attempt.json").write_text(json.dumps({"status": "submitted", "credits_consumed": 49}))
        base = self.service.directory / "pricing.json"
        self.service.configure(pricing="pricing.json")
        models = {"test-video": {"per_second": {"1080p": None}}}
        base.write_text(json.dumps({"schema_version": 1, "models": models, "observed": []}))
        base.chmod(0o444)
        self.addCleanup(base.chmod, 0o644)
        before = base.read_bytes()
        with unittest.mock.patch.object(tool, "work_path", lambda value: Path(value)):
            tool.learn(work)
        self.assertEqual(base.read_bytes(), before)
        state = Path(os.environ["SONGFRAME_LOCAL_DIR"]) / "providers/test/pricing-observations.json"
        self.assertEqual(tool.observations_path("test"), state.resolve())
        self.assertEqual(json.loads(state.read_text())["observed"][0]["credits"], 49.0)
        self.assertEqual(tool.estimate(tool.pricing_for(self.request), self.request)["credits"], 49.0)
        self.assertEqual(tool.load_pricing(base)["observed"], [])

    def test_state_observations_take_priority_over_base_observations(self):
        self.pricing["models"] = {"test-video": {"per_second": {"1080p": None}}}
        self.pricing["observed"] = [
            {"model": "test-video", "kind": "video", "resolution": "1080p", "duration": 7, "credits": 70}
        ]
        self.pricing_path.write_text(json.dumps(self.pricing))
        self.assertEqual(tool.estimate(tool.pricing_for(self.request, self.pricing_path), self.request)["credits"], 70)
        state = tool.observations_path("test")
        state.parent.mkdir(parents=True)
        observed = [{"model": "test-video", "kind": "video", "resolution": "1080p", "duration": 7, "credits": 63}]
        state.write_text(json.dumps({"schema_version": 1, "observed": observed}))
        # Явный --pricing заменяет только базовую таблицу; наблюдения состояния учитываются и идут последними.
        pricing = tool.pricing_for(self.request, self.pricing_path)
        self.assertEqual([item["credits"] for item in pricing["observed"]], [70, 63])
        self.assertEqual(tool.estimate(pricing, self.request)["credits"], 63)
        state.write_text("{")
        with self.assertRaisesRegex(ValueError, "наблюдений цен повреждён"):
            tool.pricing_for(self.request, self.pricing_path)
        with self.assertRaisesRegex(ValueError, "идентификатор"):
            tool.observations_path("../test")

    def image_request(self):
        return {
            "schema_version": 1,
            "shot": "M32",
            "kind": "image",
            "provider": "test",
            "command": "text_to_image",
            "model": "test-image",
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
        pricing = tool.load_pricing(self.pricing_path, "test")
        self.assertNotIn(request["model"], pricing["models"])
        self.assertEqual(observation["kind"], "image")
        self.assertEqual(observation["command"], "text_to_image")
        self.assertEqual(observation["img_resolution"], "1k")
        self.assertEqual(observation["quality"], "low")
        self.assertNotIn("duration", observation)
        self.assertEqual(tool.estimate(pricing, request)["credits"], 1)
        self.assertEqual(tool.check(request, pricing, balance=1, use_account=False)["verdict"], "ok")
        self.learn_image(request)
        self.assertEqual(len(tool.load_pricing(self.pricing_path, "test")["observed"]), 1)

    def test_image_observation_never_transfers_to_other_significant_settings(self):
        request = self.image_request()
        self.learn_image(request)
        pricing = tool.load_pricing(self.pricing_path, "test")
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
        pricing = tool.load_pricing(self.pricing_path, "test")
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
        self.assertEqual(tool.estimate(tool.load_pricing(self.pricing_path, "test"), changed)["credits"], 1)
        changed["parameters"]["options"]["quality_mode"] = "high"
        self.assertIsNone(tool.estimate(tool.load_pricing(self.pricing_path, "test"), changed)["credits"])

    def test_image_observation_is_total_cost_and_never_video_rate(self):
        request = self.image_request()
        request["outputs"] = 9
        request["parameters"]["imageCount"] = 9
        self.learn_image(request, credits=7)
        pricing = tool.load_pricing(self.pricing_path, "test")
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
        report = tool.check(request, tool.pricing_for(request, self.pricing_path), balance=10, use_account=False)
        table = tool.table(report)
        self.assertIn("command=text_to_image", table)
        self.assertIn("img_resolution=1k", table)
        self.assertIn("quality=low", table)
        self.assertNotIn("duration=", table)
        self.assertEqual(report["estimate_credits"], 1)


if __name__ == "__main__":
    unittest.main()
