"""Попытка генерации у выбранного провайдера: возможности, подготовка, отправка и получение; @link README.md"""

import sys
from pathlib import Path

# Точка запуска находится на два уровня ниже корня комплекса.
# Полные импорты tools.* работают и при прямом запуске файла из любой папки.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


import argparse
import json

from tools import media_adapters
from tools.media_request import attempt


def provider_function(provider, name):
    """Необязательная функция адаптера (вход, состояние входа); её отсутствие — понятная ошибка."""
    function = getattr(media_adapters.adapter(provider), name, None)
    if function is None:
        raise ValueError(f"Провайдер {provider!r} не поддерживает это действие.")
    return function


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("capabilities")
    p.add_argument("--provider", required=True)
    p.add_argument("--kind", choices=["image", "video"], required=True)
    p.add_argument("--json", action="store_true")
    p.add_argument("--timeout", type=float, default=60)
    p = sub.add_parser("login")
    p.add_argument("--provider", required=True)
    p.add_argument("--no-browser", action="store_true")
    p.add_argument("--timeout", type=float, default=300)
    p = sub.add_parser("auth-status")
    p.add_argument("--provider", required=True)
    p.add_argument("--json", action="store_true")
    p.add_argument("--timeout", type=float, default=30)
    p = sub.add_parser("prepare")
    p.add_argument("--request", type=Path, required=True)
    p.add_argument("--work-dir", type=Path, required=True)
    p = sub.add_parser("watch")
    p.add_argument("--work-dir", type=Path, nargs="+", required=True)
    p.add_argument("--max-minutes", type=float, default=15)
    p.add_argument("--interval", type=float, default=20)
    p.add_argument("--timeout", type=float, default=60)
    p = sub.add_parser("attach")
    p.add_argument("--work-dir", type=Path, required=True)
    p.add_argument("--file", type=Path, nargs="+", required=True)
    for action in ("submit", "resume", "status", "not-created"):
        p = sub.add_parser(action)
        p.add_argument("--work-dir", type=Path, required=True)
        if action in ("submit", "resume"):
            p.add_argument("--timeout", type=float, default=60)
        if action == "submit":
            p.add_argument("--confirm", required=True)
        if action == "resume":
            p.add_argument("--generation-id")
            p.add_argument("--wait-seconds", type=float, default=0)
            p.add_argument("--interval", type=float, default=15)
    args = parser.parse_args()
    try:
        if args.action == "capabilities":
            report = attempt.capabilities(args.provider, args.kind, args.timeout)
            if args.json:
                print(json.dumps(report, ensure_ascii=False, indent=2))
            else:
                for entry in report["reports"]:
                    print(f"{entry['command']}: " + (", ".join(entry["models"]) or "—"))
                for entry in report["problems"]:
                    print(f"{entry['command']}: {entry['message']}")
            return
        if args.action == "login":
            result = provider_function(args.provider, "login")(open_browser=not args.no_browser, timeout=args.timeout)
            print(json.dumps(result, ensure_ascii=False))
            if not result.get("ok"):
                raise SystemExit(1)
            return
        if args.action == "auth-status":
            result = provider_function(args.provider, "auth_status")(timeout=args.timeout)
            print(json.dumps(result, ensure_ascii=False) if args.json else result.get("message") or result["status"])
            return
        if args.action == "watch":
            result = attempt.watch(
                args.work_dir,
                args.max_minutes,
                args.interval,
                args.timeout,
                report=lambda line: print(line, flush=True),
            )
            print(json.dumps(result, ensure_ascii=False, indent=2))
            if any(s.get("status") not in attempt.TERMINAL for s in result.values()):
                raise SystemExit(2)
            return
        if args.action == "prepare":
            result = attempt.prepare(args.request, args.work_dir)
        elif args.action == "submit":
            result = attempt.submit(args.work_dir, args.confirm, args.timeout)
        elif args.action == "attach":
            result = attempt.attach(args.work_dir, args.file)
        elif args.action == "not-created":
            result = attempt.not_created(args.work_dir)
        elif args.action == "resume":
            result = attempt.resume(args.work_dir, args.generation_id, args.wait_seconds, args.interval, args.timeout)
        else:
            result = attempt.status(args.work_dir)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, KeyError, TypeError, OSError) as error:
        # Не печатаем repr исключения: пути, ответы сервиса и сетевые ошибки могут содержать секреты.
        parser.exit(
            1,
            (
                str(error)
                if type(error) is ValueError or isinstance(error, attempt.NotSubmitted)
                else "Ошибка локальных данных или файлов; сырой вывод скрыт."
            )
            + "\n",
        )


if __name__ == "__main__":
    main()
