# Структура Go/Wails-интерфейса

Рабочие пути относятся к этому репозиторию:

```text
frontend/src/renderer/         App, темы, страницы, общие компоненты
  pages/ExamplePage/           ExamplePage.tsx и index.ts
    components/               самостоятельные блоки страницы, один компонент — один файл
    useExample.ts             локальные hooks при необходимости
  components/                 действительно общие компоненты
  testing/                    независимые модели историй, не импортируются рабочим кодом
frontend/src/platform/        тонкий адаптер window.api над bindings: доступность методов и ошибки
frontend/src/shared/          чистые типы/правила и доменные тексты
frontend/bindings/            generated Wails bindings, не редактируются вручную
internal/app/                 Wails-сервисы и граница пользовательских операций
internal/project/             текущее чтение проектных данных
internal/components/          обнаружение, установка и probes компонентов
internal/store/               отдельный профиль приложения
```

Страницы экспортируются через `pages/{PageName}/index.ts` и `pages/index.ts`; публичный index страницы экспортирует саму страницу. Локальные типы, hooks, функции и тесты остаются в её папке, пока не появились реальные общие потребители. Не переносите монолит страницы в одну обёртку и не создавайте общую абстракцию ради одного экрана. Доменные UI-тексты в `frontend/src/shared/texts/` — намеренное исключение из локальности.

Используйте существующие [ShellLayout](../../frontend/src/renderer/components/ShellLayout.tsx), [PageActionBar](../../frontend/src/renderer/components/PageActionBar.tsx), [ActionButton](../../frontend/src/renderer/components/ActionButton.tsx), [DisabledHint](../../frontend/src/renderer/components/DisabledHint.tsx), [NativeDropZone](../../frontend/src/renderer/components/NativeDropZone.tsx) и [MediaPlayer](../../frontend/src/renderer/components/MediaPlayer.tsx) по их фактическому контракту. Исходный интерфейс Electron-оригинала переносится сюда целиком; его компоненты считаются существующими, только когда они уже лежат в этом репозитории. Если нужная предметная композиция ещё не перенесена, перенесите её из оригинала, а не пишите аналог заново; новое решайте через MUI и текущие общие компоненты.

Renderer не читает файловую систему и не запускает процессы. Операции выполняет Go, frontend обращается к ним через adapters `frontend/src/platform/` и generated bindings. Новое поведение согласованно меняет Go-сервис/DTO, adapter и потребителя. После изменения экспортируемого API выполните `wails3 task bindings`; ручная правка generated файла не заменяет изменение владельца. Не добавляйте Electron preload/IPC или второй обходной мост.

Истории `*.stories.tsx` лежат рядом с компонентами и не экспортируются публичными index. Общие decorators находятся в `frontend/.storybook/`; рабочее приложение не импортирует Storybook и синтетические модели. [Проверка историй](storybook.md) отдельно проверяет компоненты и их работу на родительской странице.
