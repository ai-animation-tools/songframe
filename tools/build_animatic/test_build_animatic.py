"""Контракт единственной сборки и повторяемость байтов; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import json
import shutil
import tempfile
import unittest
from copy import deepcopy
from unittest.mock import patch

from PIL import Image

from tools.build_animatic.build_animatic import build, prepare_plan, probe, run, sha


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="latest-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ["source", "plan/animatic/cards", "assets/shots/M01"]:
            (self.root / name).mkdir(parents=True)
        self.project = {"schema_version": 1, "name": "Тестовый клип", "animatic_video": "test-output.mp4"}
        (self.root / "plan/project.json").write_text(json.dumps(self.project))
        self.registry = {
            "schema_version": 1,
            "fps": 30,
            "audio": {"path": "source/track.mp3", "end_seconds": "0.8"},
            "references": {},
            "sequences": [{"id": "intro", "title": "Тест", "direction": ""}],
            "scenes": [
                {
                    "id": sid,
                    "original": sid,
                    "sequence": "intro",
                    "start_frame": start,
                    "end_frame_exclusive": start + 12,
                    "camera": "Статика",
                    "action": "Технический кадр",
                    "continuity": "",
                    "references": [],
                }
                for sid, start in [("M01", 0), ("M02", 12)]
            ],
        }
        (self.root / "plan/scenes.json").write_text(json.dumps(self.registry))
        run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100",
                "-t",
                "0.8",
                "-ac",
                "2",
                "-c:a",
                "libmp3lame",
                str(self.root / "source/track.mp3"),
            ]
        )
        clip = self.root / "assets/shots/M01/accepted-edit.mp4"
        run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=1920x1080:r=30",
                "-frames:v",
                "12",
                "-an",
                "-c:v",
                "libx264",
                "-threads",
                "2",
                "-pix_fmt",
                "yuv420p",
                str(clip),
            ]
        )
        # Оригинал и прежний video намеренно непригодны: сборщик должен читать
        # исключительно принятый монтаж из accepted_edit.video.
        (clip.parent / "original.mp4").write_bytes(b"original is not an assembly input")
        (clip.parent / "video.mp4").write_bytes(b"legacy clip must not be used")
        self.package = {
            "shot": "M01",
            "accepted_edit": {
                "video": {"path": clip.name, "sha256": sha(clip)},
                "frames": 12,
                "fps": 30,
                "timeline": {"start_frame": 0, "end_frame_exclusive": 12},
            },
        }
        self.manifest = clip.parent / "manifest.json"
        self.manifest.write_text(json.dumps(self.package))
        Image.new("RGB", (1280, 720), "blue").save(self.root / "plan/animatic/cards/M02.png")
        self.sync_receipt()

    def sync_receipt(self):
        card = self.root / "plan/animatic/cards/M02.png"
        (card.parent / "manifest.json").write_text(
            json.dumps(
                {
                    "registry_sha256": sha(self.root / "plan/scenes.json"),
                    "project_sha256": sha(self.root / "plan/project.json"),
                    "reference_hashes": {},
                    "cards": {"M02": {"sha256": sha(card)}},
                }
            )
        )

    def test_ready_clip_and_card_are_only_visual_inputs(self):
        (self.root / "plan/edit-list.md").write_text("Устаревшая копия, не источник")
        shots, _ = prepare_plan(self.root)
        self.assertEqual([s["media"] for s in shots], ["video", "card"])
        self.assertEqual(shots[0]["path"], "assets/shots/M01/accepted-edit.mp4")
        self.assertFalse((self.root / "plan/animatic/latest").exists())
        self.assertFalse((self.root / "plan/animatic/.cache").exists())

    def test_mp3_start_time_does_not_shorten_decoded_song(self):
        # Такая комбинация метаданных воспроизведена у встроенного FFmpeg на реальном MP3.
        # Вычитание начальной метки давало ложное расхождение с концом разметки.
        with patch(
            "tools.build_animatic.build_animatic.probe",
            return_value={"format": {"duration": "0.8", "start_time": "0.05"}},
        ):
            shots, _ = prepare_plan(self.root)
        self.assertEqual(shots[-1]["end"], "0.8")

    def test_mono_track_is_normalized_to_output_audio_format(self):
        track = self.root / "source/track.mp3"
        mono = self.root / "source/mono.mp3"
        run(["ffmpeg", "-v", "error", "-i", str(track), "-ac", "1", "-ar", "22050", str(mono)])
        mono.replace(track)
        build(self.root)
        info = probe(self.root / "plan/animatic/latest/test-output.mp4")
        audio = next(stream for stream in info["streams"] if stream["codec_type"] == "audio")
        self.assertEqual((audio["channels"], audio["sample_rate"]), (2, "44100"))

    def test_changed_registry_requires_fresh_card_receipt(self):
        card = self.root / "plan/animatic/cards/M02.png"
        receipt = {
            "registry_sha256": sha(self.root / "plan/scenes.json"),
            "project_sha256": sha(self.root / "plan/project.json"),
            "cards": {"M02": {"sha256": sha(card)}},
        }
        (card.parent / "manifest.json").write_text(json.dumps(receipt))
        prepare_plan(self.root)
        self.registry["scenes"][1]["action"] = "Другое действие"
        (self.root / "plan/scenes.json").write_text(json.dumps(self.registry))
        with self.assertRaisesRegex(ValueError, "Карточки устарели"):
            prepare_plan(self.root)

    def test_project_name_and_output_filename_come_from_data(self):
        # Другие имя и файл должны пройти весь путь: FFmetadata и README.
        build(self.root)
        previous_name = self.project["animatic_video"]
        self.project.update(name="Клип <A>&;#=", animatic_video="another-output.mp4")
        (self.root / "plan/project.json").write_text(json.dumps(self.project))
        self.sync_receipt()
        build(self.root)
        latest = self.root / "plan/animatic/latest"
        self.assertTrue((latest / self.project["animatic_video"]).is_file())
        self.assertFalse((latest / previous_name).exists())
        self.assertFalse((latest / "index.html").exists())
        self.assertIn("[Видео](" + self.project["animatic_video"] + ")", (latest / "README.md").read_text())
        self.assertEqual(
            probe(latest / self.project["animatic_video"])["format"]["tags"]["title"],
            self.project["name"] + " — текущий аниматик",
        )
        manifest = json.loads((latest / "manifest.json").read_text())
        self.assertEqual(manifest["source_hashes"]["plan/project.json"], sha(self.root / "plan/project.json"))

    def test_changed_or_missing_project_data_cannot_reuse_old_cards(self):
        self.project["name"] = "Другой клип"
        (self.root / "plan/project.json").write_text(json.dumps(self.project))
        with self.assertRaisesRegex(ValueError, "Карточки устарели"):
            prepare_plan(self.root)
        (self.root / "plan/project.json").unlink()
        with self.assertRaises(FileNotFoundError):
            prepare_plan(self.root)

    def test_invalid_ready_clip_is_not_replaced_by_card(self):
        Image.new("RGB", (1280, 720)).save(self.root / "plan/animatic/cards/M01.png")
        (self.root / "assets/shots/M01/accepted-edit.mp4").write_bytes(b"damaged")
        with self.assertRaises(ValueError):
            build(self.root)
        self.assertFalse((self.root / "plan/animatic/latest").exists())

    def test_wrong_timing_and_missing_card_stop_build(self):
        bad = deepcopy(self.package)
        bad["accepted_edit"]["frames"] = 11
        self.manifest.write_text(json.dumps(bad))
        with self.assertRaises(ValueError):
            prepare_plan(self.root)
        self.manifest.write_text(json.dumps(self.package))
        (self.root / "plan/animatic/cards/M02.png").unlink()
        with self.assertRaises(ValueError):
            prepare_plan(self.root)

    def keyframe_receipt(self):
        card = self.root / "plan/animatic/cards/M02.png"
        last = card.with_name("M02.last.png")
        # Исходные опоры отличаются от производных карточек и тоже входят в проверку свежести.
        first_source = self.root / "source/first-keyframe.png"
        last_source = self.root / "source/last-keyframe.png"
        shutil.copyfile(card, first_source)
        shutil.copyfile(last, last_source)
        keyframes = [
            {
                "id": "K01",
                "role": "first",
                "time_seconds": 0,
                "path": "source/first-keyframe.png",
                "sha256": sha(first_source),
            },
            {
                "id": "K02",
                "role": "last",
                "time_seconds": 1,
                "path": "source/last-keyframe.png",
                "sha256": sha(last_source),
            },
        ]
        (card.parent / "manifest.json").write_text(
            json.dumps(
                {
                    "registry_sha256": sha(self.root / "plan/scenes.json"),
                    "project_sha256": sha(self.root / "plan/project.json"),
                    "reference_hashes": {},
                    "cards": {
                        "M02": {
                            "sha256": sha(card),
                            "keyframes": keyframes,
                            "last": {"path": "plan/animatic/cards/M02.last.png", "sha256": sha(last)},
                        }
                    },
                }
            )
        )

    def test_raw_keyframe_change_requires_new_cards_without_touching_existing_latest(self):
        Image.new("RGB", (1280, 720), "green").save(self.root / "plan/animatic/cards/M02.last.png")
        self.keyframe_receipt()
        shots, _ = prepare_plan(self.root)
        self.assertEqual(set(shots[1]["card_sources"]), {"source/first-keyframe.png", "source/last-keyframe.png"})
        (self.root / "source/last-keyframe.png").write_bytes(b"changed raw keyframe")
        with self.assertRaisesRegex(ValueError, "Источники карточки изменились"):
            prepare_plan(self.root)
        self.assertFalse((self.root / "plan/animatic/latest").exists())

    def test_fallback_card_records_only_used_references(self):
        Image.new("RGB", (16, 16), "green").save(self.root / "source/used.png")
        Image.new("RGB", (16, 16), "red").save(self.root / "source/unused.png")
        self.registry["references"] = {
            name: {"name": name, "path": f"source/{name}.png"} for name in ("used", "unused")
        }
        self.registry["scenes"][1].update(references=["used"], card={"primary_reference": "used"})
        (self.root / "plan/scenes.json").write_text(json.dumps(self.registry))
        self.sync_receipt()
        path = self.root / "plan/animatic/cards/manifest.json"
        receipt = json.loads(path.read_text())
        receipt["reference_hashes"] = {
            f"source/{name}.png": sha(self.root / f"source/{name}.png") for name in ("used", "unused")
        }
        path.write_text(json.dumps(receipt))
        shots, _ = prepare_plan(self.root)
        self.assertEqual(shots[1]["card_sources"], {"source/used.png": sha(self.root / "source/used.png")})
        # Новый кандидат в batches не участвовал в карточке и не попадает в её зависимости.
        candidate = self.root / "plan/batches/M02-attempt-02/candidate.png"
        candidate.parent.mkdir(parents=True)
        Image.new("RGB", (16, 16), "blue").save(candidate)
        self.assertEqual(prepare_plan(self.root)[0][1]["card_sources"], shots[1]["card_sources"])

    def frame_color(self, video, index):
        raw = run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(video),
                "-vf",
                f"select='eq(n\\,{index})'",
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-",
            ]
        )
        pixels = len(raw) // 3
        return tuple(round(sum(raw[c::3]) / pixels) for c in range(3))

    def test_keyframe_card_dissolves_into_last_frame(self):
        Image.new("RGB", (1280, 720), "green").save(self.root / "plan/animatic/cards/M02.last.png")
        self.keyframe_receipt()
        shots, _ = prepare_plan(self.root)
        self.assertEqual([s["media"] for s in shots], ["video", "keyframes"])
        self.assertEqual(shots[1]["path_last"], "plan/animatic/cards/M02.last.png")
        result = build(self.root)
        self.assertEqual((result["video"], result["cards"], result["keyframes"]), (1, 0, 1))
        video = self.root / "plan/animatic/latest" / self.project["animatic_video"]
        manifest = json.loads((video.parent / "manifest.json").read_text())
        self.assertIn("plan/animatic/cards/M02.last.png", manifest["source_hashes"])
        self.assertEqual(
            manifest["source_hashes"]["source/first-keyframe.png"], sha(self.root / "source/first-keyframe.png")
        )
        self.assertEqual(
            manifest["source_hashes"]["source/last-keyframe.png"], sha(self.root / "source/last-keyframe.png")
        )
        self.assertEqual([item["id"] for item in manifest["shots"][1]["keyframes"]], ["K01", "K02"])
        # Первый кадр плана — первая опора, последний — последняя; середина растворения смешивает обе.
        first, middle, last = (self.frame_color(video, n) for n in (12, 18, 23))
        self.assertTrue(first[2] > 200 and first[1] < 40, first)
        self.assertTrue(last[1] > 100 and last[2] < 40, last)
        self.assertTrue(40 < middle[2] < 200, middle)
        self.assertEqual(manifest["shots"][1]["media"], "keyframes")
        # Изменённая последняя опора без обновления квитанции останавливает сборку.
        Image.new("RGB", (1280, 720), "white").save(self.root / "plan/animatic/cards/M02.last.png")
        with self.assertRaisesRegex(ValueError, "Карточки устарели"):
            prepare_plan(self.root)

    def test_failed_encoding_preserves_existing_latest_including_legacy_page(self):
        latest = self.root / "plan/animatic/latest"
        latest.mkdir()
        previous = {
            self.project["animatic_video"]: b"previous video",
            "manifest.json": json.dumps({"video_file": self.project["animatic_video"]}).encode(),
            "README.md": "Прежнее описание".encode(),
            "index.html": b"previous HTML page",
        }
        for name, content in previous.items():
            (latest / name).write_bytes(content)

        def fail_encoding(args):
            # Сбой финальной склейки происходит после подготовки фрагментов, до замены latest.
            if "concat" in args:
                raise ValueError("Ошибка финального кодирования")
            return run(args)

        with patch("tools.build_animatic.build_animatic.run", side_effect=fail_encoding):
            with self.assertRaisesRegex(ValueError, "Ошибка финального кодирования"):
                build(self.root)
        self.assertEqual({path.name: path.read_bytes() for path in latest.iterdir()}, previous)

    def test_cold_warm_and_empty_cache_produce_identical_video(self):
        latest = self.root / "plan/animatic/latest"
        latest.mkdir()
        legacy_page = latest / "index.html"
        legacy_page.write_text("Прежняя HTML-страница")
        # Проверка входов не меняет latest, полная успешная сборка удаляет прежнюю страницу.
        build(self.root, plan_only=True)
        self.assertEqual(legacy_page.read_text(), "Прежняя HTML-страница")
        first = build(self.root)
        self.assertFalse(legacy_page.exists())
        video = self.root / "plan/animatic/latest" / self.project["animatic_video"]
        # Служебные входы FFmpeg не должны попадать в готовую сборку.
        self.assertEqual(
            {p.name for p in video.parent.iterdir()}, {self.project["animatic_video"], "manifest.json", "README.md"}
        )
        readme = (latest / "README.md").read_text()
        self.assertNotIn("index.html", readme)
        self.assertIn("[Манифест](manifest.json)", readme)
        first_bytes = video.read_bytes()
        manifest = (video.parent / "manifest.json").read_bytes()
        warm = build(self.root)
        self.assertEqual(first_bytes, video.read_bytes())
        self.assertEqual(warm["segments_reused"], 2)
        self.assertEqual(manifest, (video.parent / "manifest.json").read_bytes())
        shutil.rmtree(self.root / "plan/animatic/.cache")
        cold = build(self.root)
        self.assertEqual(first_bytes, video.read_bytes())
        self.assertEqual(cold["segments_created"], 2)
        # Заменённая карточка пересоздаёт только свой фрагмент.
        Image.new("RGB", (1280, 720), "green").save(self.root / "plan/animatic/cards/M02.png")
        self.sync_receipt()
        changed = build(self.root)
        self.assertEqual(changed["segments_created"], 1)
        self.assertEqual(changed["segments_reused"], 1)
        self.assertNotEqual(first["video_sha256"], changed["video_sha256"])
        saved = video.read_bytes()
        (self.root / "assets/shots/M01/accepted-edit.mp4").unlink()
        with self.assertRaises(ValueError):
            build(self.root)
        self.assertEqual(saved, video.read_bytes())


if __name__ == "__main__":
    unittest.main()
