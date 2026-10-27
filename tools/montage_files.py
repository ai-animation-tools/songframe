"""Сохранённый ручной монтаж удерживает материалы от штатной очистки; @link ../docs/montage.md."""

import json
from pathlib import Path


def retained_montage_folders(root):
    """Возвращает рабочие папки, нужные черновикам и экспортам ручного монтажа."""
    root = Path(root).resolve()
    retained = set()
    drafts = list((root / "plan/montage").glob("*.json"))
    # montage.json — сохранённый рецепт ручного экспорта или применения, а не разовая проба агента.
    for marker in (root / "plan/batches").glob("*/montage.json"):
        retained.add(marker.parent.resolve())
        drafts.append(marker)
    for path in drafts:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            for clip in data.get("clips", []):
                source = (root / clip["path"]).resolve()
                relative = source.relative_to(root)
                if len(relative.parts) >= 4 and relative.parts[:2] in (("plan", "batches"), ("plan", "awaiting")):
                    retained.add(root.joinpath(*relative.parts[:3]))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            # Повреждённый черновик не разрешает очистить неизвестные зависимости.
            # После его исправления штатная очистка снова сможет определить владельцев.
            for base in ("plan/batches", "plan/awaiting"):
                retained.update(folder.resolve() for folder in (root / base).glob("*") if folder.is_dir())
    return retained
