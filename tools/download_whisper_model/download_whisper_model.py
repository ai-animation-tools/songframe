"""Загрузка локальной модели через Python из поставки приложения."""

import argparse
import os
import sys
from pathlib import Path


def missing_model_files(directory: Path) -> list[str]:
    # Контракт совпадает с missingModelFiles в src/main/media-runtime.ts:
    # разные модели CTranslate2 поставляют словарь в JSON либо TXT.
    def missing(name: str) -> bool:
        path = directory / name
        return not path.is_file() or path.stat().st_size == 0

    missing_files = [name for name in ("config.json", "model.bin", "tokenizer.json") if missing(name)]
    if missing("vocabulary.json") and missing("vocabulary.txt"):
        missing_files.append("vocabulary.json или vocabulary.txt")
    return missing_files


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Скачать локальную модель faster-whisper из Hugging Face.")
    parser.add_argument(
        "--repository", required=True, help="Репозиторий модели, например Systran/faster-whisper-medium"
    )
    parser.add_argument("--output", required=True, type=Path, help="Абсолютный путь к папке модели")
    parser.add_argument("--project", help="Совместимость с проектным launcher; проект не используется")
    args = parser.parse_args(argv)
    if not args.output.is_absolute():
        parser.error("--output должен содержать абсолютный путь к папке модели")

    try:
        # Hub читает офлайн-флаг при импорте. Снимаем его только в загрузчике;
        # родительский launcher и локальный ASR сохраняют своё окружение.
        os.environ.pop("HF_HUB_OFFLINE", None)
        from huggingface_hub import snapshot_download

        print(f"Загрузка {args.repository} в {args.output}", flush=True)
        snapshot_download(repo_id=args.repository, local_dir=str(args.output))
        missing_files = missing_model_files(args.output)
        if missing_files:
            print(
                f"Модель загружена не полностью: отсутствуют непустые файлы {', '.join(missing_files)}.",
                file=sys.stderr,
            )
            print("Повторите ту же команду для продолжения загрузки.", file=sys.stderr)
            return 1
    except KeyboardInterrupt:
        print("Загрузка прервана. Повторите ту же команду для продолжения.", file=sys.stderr)
        return 130
    except ImportError:
        print(
            "Не найдена библиотека huggingface_hub во встроенном Python. Восстановите поставку приложения.",
            file=sys.stderr,
        )
        return 1
    except Exception as error:
        print(f"Не удалось загрузить модель: {error}", file=sys.stderr)
        print("Повторите ту же команду для продолжения загрузки.", file=sys.stderr)
        return 1

    print(f"Модель готова: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
