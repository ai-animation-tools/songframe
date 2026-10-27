# Структура фронтенда

Нормативные правила структуры также находятся в [AGENTS.md](../../AGENTS.md#приложение). Эта страница поясняет их на примерах.

```text
src/renderer/src/
  App.tsx                         маршруты и предусловия страниц
  theme.tsx                       настройки и переключение темы
  theme-palette.ts                токены палитры обеих тем
  components/                     компоненты, используемые разными страницами
  hooks/                          общие hooks
  pages/
    ExamplePage/
      ExamplePage.tsx             сборка страницы
      index.ts                    публичный экспорт страницы
      components/
        ExampleBlock.tsx          самостоятельный блок
        index.ts                  экспорты блоков, нужных вне components/
      useExample.ts               hook только этой страницы
      types.ts, helpers.ts        локальные типы и функции при необходимости
```

Страницы размещайте в `pages/{PageName}/{PageName}.tsx`, экспортируйте через `pages/{PageName}/index.ts` и `pages/index.ts`. Страница собирается из самостоятельных компонентов в её `components/`: один компонент — один файл. Публичный `index.ts` страницы экспортирует только страницу; локальный barrel компонентов — только блоки, используемые вне их папки. Пример — [ProjectPage](../../src/renderer/src/pages/ProjectPage/ProjectPage.tsx).

Локальные hooks, типы, функции и связанные тесты оставляйте в папке страницы. Компоненты и hooks, действительно используемые несколькими страницами, размещайте в общих `components/` и `hooks/`. Не создавайте общую абстракцию только ради одного экрана и не переносите монолит страницы целиком в одну новую обёртку. Существующие исключения из структуры не являются образцом для новых компонентов.

Используйте существующие общие компоненты по назначению: [Layout](../../src/renderer/src/components/Layout.tsx) — оболочка и навигация, [PageActionBar](../../src/renderer/src/components/PageActionBar.tsx) — закреплённая панель действий страницы, [FileDropZone](../../src/renderer/src/components/FileDropZone.tsx) — выбор и перетаскивание файлов, [ConfirmationDialog](../../src/renderer/src/components/ConfirmationDialog.tsx) — общее оформление подтверждения, [AgentButton](../../src/renderer/src/components/AgentButton.tsx) и `AgentIcon` — обозначение агентных действий по правилам AGENTS.md, [DestructiveButton](../../src/renderer/src/components/DestructiveButton.tsx) — деструктивное действие с подтверждением, `StateChip` и компоненты заданий — соответствующие состояния. `PageActionBar`, `FileDropZone`, `ConfirmationDialog` и `DestructiveButton` сейчас импортируются непосредственно из своих файлов. Перед созданием нового общего компонента проверьте существующие; поведение и смысл должны совпадать, а не только внешний вид.

Renderer отвечает за интерфейс и вызывает возможности приложения через `window.api`. Файловая система и процессы принадлежат `src/main`, мост — `src/preload`, общий контракт — `src/shared`. Не переносите работу с файлами или запуск процессов в компонент ради удобства вёрстки.
