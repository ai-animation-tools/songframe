"""Значимые поля проекта для производных карточек и сборки; @link build_animatic/README.md"""


def project_inputs(project, animatic=False):
    """Настройки генерации не входят в уже нарисованную карточку или собранное видео."""
    keys = ("name", "animatic_video") if animatic else ("name",)
    return {key: project[key] for key in keys}


def project_inputs_match(record, project, animatic=False):
    """Отсутствующий или повреждённый снимок требует обновления производного результата."""
    if "project_inputs" not in record:
        return False
    saved = record["project_inputs"]
    expected = project_inputs(project, animatic)
    return (
        isinstance(saved, dict)
        and saved.keys() == expected.keys()
        and all(isinstance(value, str) for value in saved.values())
        and saved == expected
    )
