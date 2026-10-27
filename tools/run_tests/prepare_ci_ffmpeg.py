"""Подготавливает проверенные FFmpeg и ffprobe для CI; @link README.md."""

import argparse
import hashlib
import json
import os
import shutil
import tarfile
import tempfile
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as data:
        for chunk in iter(lambda: data.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare(directory, distribution):
    """Кэш годится только с закреплённым хешем; архив распаковывается без путей из него."""
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / "ffmpeg.tar.xz"
    if not archive.is_file() or sha256(archive) != distribution["sha256"]:
        with tempfile.NamedTemporaryFile(dir=directory, prefix="download-", delete=False) as target:
            temporary = Path(target.name)
            try:
                with urlopen(distribution["url"], timeout=120) as response:
                    shutil.copyfileobj(response, target)
            except BaseException:
                temporary.unlink(missing_ok=True)
                raise
        try:
            if sha256(temporary) != distribution["sha256"]:
                raise ValueError("SHA-256 скачанного FFmpeg не совпадает с media-lock.json.")
            os.replace(temporary, archive)
        finally:
            temporary.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix="unpack-", dir=directory) as staging_name:
        staging = Path(staging_name)
        with tarfile.open(archive, mode="r:xz") as source:
            for name in ("ffmpeg", "ffprobe"):
                matches = [member for member in source.getmembers() if member.name.endswith(f"/bin/{name}")]
                if len(matches) != 1 or not matches[0].isfile():
                    raise ValueError(f"В архиве нет единственного файла {name}.")
                data = source.extractfile(matches[0])
                if data is None:
                    raise ValueError(f"Не удалось прочитать {name} из архива.")
                with data, (staging / name).open("wb") as output:
                    shutil.copyfileobj(data, output)
                (staging / name).chmod(0o755)
        binary_dir = directory / "bin"
        binary_dir.mkdir(exist_ok=True)
        for name in ("ffmpeg", "ffprobe"):
            os.replace(staging / name, binary_dir / name)
    return binary_dir


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--directory", required=True, type=Path, help="Временный каталог с кэшем и исполняемыми файлами."
    )
    args = parser.parse_args()
    lock = json.loads((ROOT / "scripts/runtime/media-lock.json").read_text(encoding="utf-8"))["ffmpeg"]
    print(f"FFmpeg для CI: {prepare(args.directory, lock)}")


if __name__ == "__main__":
    main()
