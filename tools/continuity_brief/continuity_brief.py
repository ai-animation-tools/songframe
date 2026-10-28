"""Врезка непрерывности для плана: состояние мира и героев словами и чек-лист проверки кадра; @link README.md

Детерминированный текст из вычисленного состояния `scene_registry` и словаря кастинга. Приложение
передаёт абзац в задание агента для дословной вставки в промпты опор и видео, а по чек-листу сверяется
полученное изображение. Так контроль непрерывности не зависит от памяти агента.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.cast_registry.cast_registry import WORLD_ID, labels, load_cast
from tools.scene_registry.scene_registry import load, scene_state

PHASE_TITLES = {"before": "Состояние на первый кадр", "after": "Состояние на последний кадр"}


def entity_order(cast, state):
    """Мир первым, дальше порядок кастинга, затем сущности, которых в кастинге нет."""
    known = [e["id"] for e in cast["entities"]] if cast else []
    ordered = [eid for eid in known if eid in state]
    ordered.sort(key=lambda eid: 0 if eid == WORLD_ID else 1)
    return ordered + sorted(eid for eid in state if eid not in known)


def describe(cast, state):
    """Строки «Имя: подпись свойства: значение; …» для каждой сущности с состоянием."""
    names = {e["id"]: (e["name"], e["kind"]) for e in cast["entities"]} if cast else {}
    vocab = labels(cast)
    lines = []
    for eid in entity_order(cast, state):
        name, kind = names.get(eid, (eid, None))
        props = vocab.get(kind, {}) if kind else {}
        parts = []
        for key, value in state[eid].items():
            label = props.get(key, {}).get("label", key.replace("_", " "))
            parts.append(f"{label.lower()}: {value}")
        lines.append(f"{name}: " + "; ".join(parts) + ".")
    return lines


def checklist(cast, state):
    """Вопросы «да или нет» по свойствам с шаблоном checklist в словаре; остальные свойства не спрашиваются."""
    names = {e["id"]: (e["name"], e["kind"]) for e in cast["entities"]} if cast else {}
    vocab = labels(cast)
    questions = []
    for eid in entity_order(cast, state):
        name, kind = names.get(eid, (eid, None))
        props = vocab.get(kind, {}) if kind else {}
        for key, value in state[eid].items():
            template = props.get(key, {}).get("checklist")
            if template:
                questions.append(f"{name}: " + template.format(value=value))
    return questions


def brief(data, cast, sid, phase="before"):
    state = scene_state(data, sid)[phase]
    scene = next(s for s in data["scenes"] if s["id"] == sid)
    description = describe(cast, state)
    questions = checklist(cast, state)
    paragraph = (
        f"{PHASE_TITLES[phase]} {sid}. " + " ".join(description)
        if description
        else f"{PHASE_TITLES[phase]} {sid}: состояние не задано."
    )
    text = [f"{PHASE_TITLES[phase]} {sid} ({scene['action'][:80]}{'…' if len(scene['action']) > 80 else ''})", ""]
    text += description or ["Состояние не задано: в кастинге нет начального состояния, а в сценах нет изменений."]
    if questions:
        text += ["", "Проверить по кадру:"] + [f"- [ ] {q}" for q in questions]
    return {
        "shot": sid,
        "phase": phase,
        "state": state,
        "paragraph": paragraph,
        "checklist": questions,
        "text": "\n".join(text),
    }


def main():
    parser = argparse.ArgumentParser(description="Врезка непрерывности и чек-лист для плана.")
    parser.add_argument("shot", help="Код плана, например M37")
    parser.add_argument("--phase", choices=["before", "after"], default="before")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--paragraph", action="store_true", help="Только абзац для вставки в промпт")
    args = parser.parse_args()
    try:
        data = load()
        cast = load_cast()
        if not any(s["id"] == args.shot for s in data["scenes"]):
            raise ValueError(f"{args.shot}: сцена отсутствует в реестре.")
        result = brief(data, cast, args.shot, args.phase)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, f"{error}\n")
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.paragraph:
        print(result["paragraph"])
    else:
        print(result["text"])


if __name__ == "__main__":
    main()
