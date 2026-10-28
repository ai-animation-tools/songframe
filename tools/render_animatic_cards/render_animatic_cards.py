"""Подготовка PNG-карточек отдельно от сборки; @link README.md"""

import sys
from pathlib import Path

# После переноса точка запуска находится на два уровня ниже корня проекта.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import subprocess
from decimal import Decimal

from PIL import Image, ImageDraw, ImageFont, ImageOps

from tools.common import ROOT
from tools.scene_registry.scene_registry import load as load_scenes
from tools.scene_registry.scene_registry import shots as registry_shots

# Шрифт входит в комплекс рядом с модулем (лицензия — fonts/LICENSE): системные шрифты ОС не нужны.
FONTS = Path(__file__).resolve().parent / "fonts"
FONT = FONTS / "DejaVuSans.ttf"
BOLD = FONTS / "DejaVuSans-Bold.ttf"
FPS = 30
SIZE = (1280, 720)
ACCENT = "#E8B975"
BG = "#171E24"
FG = "#EDF0F2"
MUTED = "#ACB7C0"


def run(args):
    result = subprocess.run(args, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace")[-2000:])
    return result.stdout


def seconds(value):
    minutes, remainder = value.split(":")
    return Decimal(minutes) * 60 + Decimal(remainder)


def read_shots(omitted_ids=(), inserted_ids=()):
    # Аргументы сохранены для рабочих пакетов; они не меняют канонический порядок.
    return registry_shots(load_scenes(ROOT))


def wrapped(draw, text, font, width):
    lines = [""]
    for word in text.split():
        candidate = (lines[-1] + " " + word).strip()
        if draw.textlength(candidate, font=font) <= width:
            lines[-1] = candidate
        else:
            assert draw.textlength(word, font=font) <= width, word
            lines.append(word)
    return lines


def text_box(draw, text, xy, width, height, size=24, color=FG, bold=False):
    # Сначала уменьшаем шрифт до заданного предела. Если текст всё равно не помещается,
    # видимо сокращаем его многоточием: карточка лишь условный кадр, а полный текст
    # плана остаётся в монтажном списке и раскадровке, поэтому сборка не должна падать.
    for point in range(size, 15, -1):
        font = ImageFont.truetype(str(BOLD if bold else FONT), point)
        lines = wrapped(draw, text, font, width)
        leading = point + 7
        if len(lines) * leading <= height:
            break
    else:
        lines = shortened(draw, lines, font, width, max(1, height // leading))
    for index, line in enumerate(lines):
        draw.text((xy[0], xy[1] + index * leading), line, font=font, fill=color)
    return point


def shortened(draw, lines, font, width, count):
    """Оставляет первые count строк и завершает последнюю многоточием, убирая слова до совпадения по ширине."""
    kept = lines[:count]
    words = kept[-1].split()
    while words and draw.textlength(" ".join(words) + "…", font=font) > width:
        words.pop()
    kept[-1] = " ".join(words) + "…"
    return kept


def place_reference(card, source_path, box, root):
    x, y, width, height = box
    # Только масштабирование существующего референса с сохранением пропорций.
    # Образы не дорисовываются и не выдаются за готовые сценические композиции.
    image = Image.open(root / source_path).convert("RGB")
    image = ImageOps.contain(image, (width, height), Image.Resampling.LANCZOS)
    card.paste(image, (x + (width - image.width) // 2, y + (height - image.height) // 2))


def primary(shot):
    return shot["card"]["primary_reference"]


def fit_canvas(path, size=SIZE):
    """Изображение целиком на холсте карточки с полями, без обрезки и растяжения."""
    canvas = Image.new("RGB", size, BG)
    image = ImageOps.contain(Image.open(path).convert("RGB"), size, Image.Resampling.LANCZOS)
    canvas.paste(image, ((size[0] - image.width) // 2, (size[1] - image.height) // 2))
    return canvas


def render_keyframe_card(shot, target, project, keyframes, root=ROOT, last_target=None):
    """Первая опора на весь холст, остальные полоской; последняя — отдельным PNG для перехода."""
    if not keyframes:
        raise ValueError("Нет принятых опор для карточки.")
    card = fit_canvas(root / keyframes[0]["path"]).convert("RGBA")
    overlay = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    shade = ImageDraw.Draw(overlay)
    shade.rectangle((0, 0, SIZE[0], 58), fill=(13, 18, 22, 190))
    shade.rectangle((0, SIZE[1] - 112, SIZE[0], SIZE[1]), fill=(13, 18, 22, 190))
    card = Image.alpha_composite(card, overlay).convert("RGB")
    draw = ImageDraw.Draw(card)
    draw.rectangle((0, 0, SIZE[0], 7), fill=ACCENT)
    text_box(
        draw,
        project["name"].upper() + "  /  ОПОРЫ ПРИНЯТЫ, ВИДЕО НЕ СГЕНЕРИРОВАНО",
        (32, 20),
        860,
        28,
        18,
        ACCENT,
        True,
    )
    text_box(draw, shot["interval"] + "  •  " + shot["duration"] + " с", (900, 22), 350, 28, 18)
    text_box(draw, shot["id"] + "  /  " + shot["title"], (32, SIZE[1] - 100), 760, 40, 24, FG, True)
    plan = " → ".join(f"{k['id']} {k['time_seconds']:g} с" for k in keyframes)
    text_box(draw, "План опор: " + plan, (32, SIZE[1] - 58), 760, 24, 16, MUTED)
    text_box(draw, shot["camera"], (32, SIZE[1] - 32), 760, 24, 16, ACCENT)
    others = keyframes[1:]
    if others:
        width = min(176, (SIZE[0] - 820 - 32) // max(1, len(others)))
        for index, keyframe in enumerate(others):
            x = SIZE[0] - 32 - width * (len(others) - index) + 6
            place_reference(card, keyframe["path"], (x, SIZE[1] - 104, width - 6, 76), root)
            text_box(draw, keyframe["id"], (x, SIZE[1] - 26), width - 6, 24, 16, MUTED)
    card.save(target)
    if last_target is not None and len(keyframes) >= 2:
        fit_canvas(root / keyframes[-1]["path"]).save(last_target)
    return {"keyframes": [k["id"] for k in keyframes], "has_last": last_target is not None and len(keyframes) >= 2}


def render_card(shot, target, project, references, root=ROOT):
    card = Image.new("RGB", SIZE, BG)
    draw = ImageDraw.Draw(card)
    draw.rectangle((0, 0, 1280, 7), fill=ACCENT)
    # Название и подписи приходят из первичных источников, не из глобального
    # реестра при импорте: тот же рендерер работает с другим проектом и снимком.
    header = project["name"].upper() + "  /  ЧЕРНОВОЙ МОНТАЖ"
    text_box(draw, header, (32, 22), 760, 32, 20, ACCENT, True)
    text_box(draw, shot["interval"] + "  •  " + shot["duration"] + " с", (865, 24), 385, 30, 18)
    title = shot["title"]
    # План из материала другого плана помечается источником; у обычного плана заголовок прежний.
    if shot.get("derived_from"):
        title += "  •  из " + shot["derived_from"]["shot"]
    text_box(draw, shot["id"] + "  /  " + title, (32, 63), 1216, 51, 32, FG, True)
    text_box(draw, "РЕФЕРЕНСЫ • УСЛОВНЫЙ КАДР, НЕ ГОТОВАЯ СЦЕНА", (32, 128), 660, 26, 17, MUTED)
    text_box(draw, shot["camera"], (720, 128), 528, 83, 21, ACCENT)
    draw.rounded_rectangle((32, 166, 692, 540), radius=9, fill="#101519")
    key = primary(shot)
    source_path = references[key]["path"]
    place_reference(card, source_path, (32, 166, 660, 374), root)
    label = references[key]["name"] + " • исходный референс"
    text_box(draw, label, (42, 545), 640, 25, 16, MUTED)
    text_box(draw, "ДЕЙСТВИЕ", (720, 218), 528, 27, 17, ACCENT, True)
    action_font = text_box(draw, shot["action"], (720, 250), 528, 263, 24)
    text_box(draw, "НЕПРЕРЫВНОСТЬ", (720, 518), 528, 26, 17, ACCENT, True)
    state_font = text_box(draw, shot["state"], (720, 549), 528, 108, 18, MUTED)
    others = [ref for ref in shot["refs"] if ref != key]
    cell_width = min(106, 660 // max(1, len(others)))
    for index, ref in enumerate(others):
        x = 32 + index * cell_width
        place_reference(card, references[ref]["path"], (x, 582, cell_width - 6, 62), root)
        label = references[ref].get("short_name", references[ref]["name"])
        text_box(draw, label, (x, 647), cell_width - 6, 23, 16, MUTED)
    draw.rectangle((0, 679, 1280, 720), fill="#0D1216")
    if shot.get("lipsync"):
        notice = "РЕЧЕВОЙ ПЛАН • губы не анимированы, границы слов не проверены"
    else:
        notice = "Референсы не показывают текущую позу, ракурс и состояние"
    text_box(draw, notice, (32, 689), 974, 26, 17, ACCENT if shot.get("lipsync") else MUTED)
    card.save(target)
    return dict(
        action_font=action_font,
        state_font=state_font,
        primary_reference=key,
        primary_image=source_path,
        approved_scene_still=False,
    )
