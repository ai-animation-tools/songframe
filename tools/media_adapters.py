"""Таблица адаптеров провайдеров генерации: id провайдера → модуль; @link media_request/README.md#адаптеры

Общий код инструментов узнаёт сервисы только отсюда. Добавление провайдера — строка в ADAPTERS и папка
адаптера, удаление — обратное действие. Тесты дополняют таблицу переменной SONGFRAME_MEDIA_ADAPTERS
в виде «id=module[,id=module]» без правки кода.
"""

import importlib
import os

# Строка на провайдера: удаление сервиса — удаление его строки.
ADAPTERS = {
    "kling": "tools.kling_request.kling_request",
}
TEST_HOOK = "SONGFRAME_MEDIA_ADAPTERS"


def normalized(provider):
    """Id провайдера сравнивается без учёта регистра и пробелов по краям."""
    return provider.strip().casefold() if isinstance(provider, str) else ""


def table():
    modules = dict(ADAPTERS)
    for entry in os.environ.get(TEST_HOOK, "").split(","):
        if not entry.strip():
            continue
        name, separator, module = entry.partition("=")
        if not separator or not normalized(name) or not module.strip():
            raise ValueError(f"{TEST_HOOK}: ожидается список id=module через запятую.")
        modules[normalized(name)] = module.strip()
    return modules


def known(provider):
    return bool(normalized(provider)) and normalized(provider) in table()


def adapter(provider):
    """Модуль адаптера провайдера; неизвестный провайдер — понятная ошибка без импорта чужого кода."""
    module = table().get(normalized(provider))
    if module is None:
        raise ValueError(
            f"Для провайдера генерации {provider!r} нет адаптера: укажите provider подключённого сервиса."
        )
    return importlib.import_module(module)
