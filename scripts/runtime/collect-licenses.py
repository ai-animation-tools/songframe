"""Сохраняет лицензии поставляемых wheels и их перечень рядом с runtime. @link README.md"""

import importlib.metadata
import json
import shutil
import sys
from pathlib import Path

target = Path(sys.argv[1])
target.mkdir(parents=True, exist_ok=True)
packages = []
distributions = (
    importlib.metadata.distributions(path=[sys.argv[2]]) if len(sys.argv) > 2 else importlib.metadata.distributions()
)
for dist in sorted(distributions, key=lambda item: item.metadata["Name"].lower()):
    name = dist.metadata["Name"]
    files = []
    for entry in dist.files or []:
        # Сохраняем вложенные уведомления нативных библиотек, а не только поле License из metadata.
        if not any(word in str(entry).lower() for word in ("license", "licence", "copying", "notice", "third_party")):
            continue
        source = Path(dist.locate_file(entry))
        if not source.is_file():
            continue
        destination = target / name / str(entry)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        files.append(str(destination.relative_to(target)))
    packages.append(
        {
            "name": name,
            "version": dist.version,
            "license": dist.metadata.get("License-Expression") or dist.metadata.get("License", ""),
            "files": files,
        }
    )
(target / "packages.json").write_text(json.dumps(packages, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
