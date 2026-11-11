# Карта кода

<!-- Сгенерировано `wails3 task docs:map` из internal/repodocs/areas.go, комментариев `// Package` и описаний страниц. Не править вручную. -->

Карта показывает, где лежит код каждой области и какие документы ей принадлежат. После изменения поведения области обновите её документы в том же коммите (правило «Документация и код» в [AGENTS.md](../AGENTS.md)). Назначение пакета — первое предложение его комментария `// Package`, страницы — комментария её компонента: чтобы поправить описание, правьте комментарий и перегенерируйте карту.

## Точка входа и граница Wails

Документы: [docs/development.md#точка-входа](development.md#точка-входа), [docs/development.md#wails-сервисы](development.md#wails-сервисы).

| Пакет | Назначение |
| --- | --- |
| [`.`](../main.go) | SongFrame запускает Wails-приложение со встроенным React frontend. |
| [`internal/app`](../internal/app) | Содержит границу между Wails и предметными сервисами приложения. |
| [`internal/wire`](../internal/wire) | Готовит ответы Wails-сервисов к TS-контракту. |

## Контракт window.api и каркас интерфейса

Документы: [docs/development.md#контракт-windowapi](development.md#контракт-windowapi), [docs/ui/README.md](ui/README.md), [docs/ui/structure.md](ui/structure.md), [docs/ui/texts.md](ui/texts.md), [docs/ui/storybook.md](ui/storybook.md).

| Страница | Назначение |
| --- | --- |
| [`HelpPage`](../frontend/src/renderer/pages/HelpPage/HelpPage.tsx) | Справка доступна без проекта: объяснения ищутся по названиям, синонимам и содержанию. |
| [`NativeCheckPage`](../frontend/src/renderer/pages/NativeCheckPage/NativeCheckPage.tsx) | Служебная страница существует только для явно запущенной нативной проверки. |
| [`NativePreviewPage`](../frontend/src/renderer/pages/NativePreviewPage/NativePreviewPage.tsx) | Служебное второе окно нативной проверки (--native-check): получает медиа из Go по session, сообщает loadedmetadata (preview:ready) и закрывается через Go. |

Ещё: [`frontend/src/shared/api.ts`](../frontend/src/shared/api.ts), [`frontend/src/platform`](../frontend/src/platform), [`frontend/src/shared/texts`](../frontend/src/shared/texts), [`frontend/src/renderer/components`](../frontend/src/renderer/components), [`frontend/src/renderer/hooks`](../frontend/src/renderer/hooks), [`frontend/src/renderer/testing`](../frontend/src/renderer/testing), [`frontend/.storybook`](../frontend/.storybook), [`frontend/tests`](../frontend/tests).

## Инфраструктура приложения

Документы: [docs/development.md#процессы-задания-и-запись-файлов](development.md#процессы-задания-и-запись-файлов), [docs/development.md#каталог-состояния](development.md#каталог-состояния), [docs/development.md#компоненты](development.md#компоненты), [internal/components/README.md](../internal/components/README.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/store`](../internal/store) | Определяет постоянный каталог состояния приложения и хранит в нём текущий проект и историю открытых проектов. |
| [`internal/diagnostics`](../internal/diagnostics) | Хранит журнал и признак штатного завершения только в профиле новой оболочки. |
| [`internal/process`](../internal/process) | Единственный путь запуска внешних программ SongFrame (FFmpeg, ffprobe, агенты). |
| [`internal/jobs`](../internal/jobs) | Общий менеджер длительных заданий приложения: отправка и ожидание генерации, приёмка, сборки, проверки, загрузка моделей. |
| [`internal/projectfs`](../internal/projectfs) | Записывает файлы проекта и локального состояния атомарно и решает, разрешена ли запись в проект. |
| [`internal/filedigest`](../internal/filedigest) | Считает SHA-256 файлов проекта с кэшем в памяти процесса. |
| [`internal/media`](../internal/media) | Отдаёт разрешённые приложением файлы системному WebView через loopback. |
| [`internal/desktop`](../internal/desktop) | Открывает файлы и папки системными средствами и читает небольшие тексты, выбранные пользователем. |
| [`internal/trash`](../internal/trash) | Перемещает файлы и папки в корзину ОС вместо безвозвратного удаления. |
| [`internal/components`](../internal/components) | Хранит закреплённый состав производственных зависимостей. |
| [`internal/appversion`](../internal/appversion) | Хранит версию собранного приложения. |
| [`internal/updates`](../internal/updates) | Обновляет приложение по явному действию пользователя: читает последний выпуск публичного репозитория на GitHub, скачивает пакет своей поставки и сверяет его с digest SHA-256 и размером из GitHub API — тем же, что проверяет публикация выпуска. |

| Страница | Назначение |
| --- | --- |
| [`JobsPage`](../frontend/src/renderer/pages/JobsPage/JobsPage.tsx) | Задания: общая хронология заданий агентов и инструментов с состоянием, журналом и отменой. |
| [`ComponentsPage`](../frontend/src/renderer/pages/ComponentsPage/ComponentsPage.tsx) | Компоненты: состояние FFmpeg/ffprobe, ONNX Runtime и моделей, их установка кнопкой или выбор уже имеющихся. |

## Проект и исходники

Документы: [dev-skills/songframe-project-contract/SKILL.md](../dev-skills/songframe-project-contract/SKILL.md), [resources/templates/project/README.md](../resources/templates/project/README.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/project`](../internal/project) | Содержит общие сведения о папке проекта, которые нужны нескольким областям: описание медиафайла для медиасервера, распознавание незавершённых многофайловых публикаций и понятные тексты файловых ошибок внутри папки проекта (FileProblem). |
| [`internal/projectfile`](../internal/projectfile) | Владеет правкой маркера проекта plan/project.json: переименование и редактируемая часть настроек — название, имя MP4 аниматика, постоянные инструкции агенту и блок generation. |
| [`internal/newproject`](../internal/newproject) | Создаёт папку клипа из встроенного шаблона: проверка формы «Новый проект», копирование шаблона с подстановкой плейсхолдеров и необязательный git init. |
| [`internal/status`](../internal/status) | Вычисляет состояние проекта из файлов его папки (projects.status). |
| [`internal/sources`](../internal/sources) | Читает опись исходников source/manifest.json. |
| [`internal/sourceedit`](../internal/sourceedit) | Ведёт форму «Исходники»: просмотр, проверку и сохранение трека, текста песни, идеи, обложки и референсов в source/ вместе с описью source/manifest.json. |
| [`internal/sourceinputs`](../internal/sourceinputs) | Вычисляет отпечаток содержательных входов описи исходников. |
| [`internal/referenceimage`](../internal/referenceimage) | Согласует запись референсов исходников и сущностей кастинга: они делят одни файлы в source/, поэтому их запись согласуется здесь, а не в internal/sourceedit (форма «Исходники») или internal/cast (документ кастинга). |
| [`internal/cast`](../internal/cast) | Читает кастинг plan/cast.json для вычислений, которым нужны сущности проекта: начальное состояние сущностей входит в отпечаток постановки каждого плана. |
| [`internal/castregistry`](../internal/castregistry) | Читает кастинг для инструментов tools.run (scene_registry, scene_scaffold, проверки): загрузка (Load), проверка (Validate), проекция описаний из source/manifest.json, начальные состояния (InitialStates) и карта референсов (References). |
| [`internal/covergen`](../internal/covergen) | Генерирует обложку проекта и изображения референсов. |
| [`internal/projectviews`](../internal/projectviews) | Строит производные Markdown/JSON-представления реестра сцен и технических комплектов — монтажный список, раскадровка, индекс комплектов assets, ROADMAP с готовностью, справочник визуальных правил с речевыми планами, README комплектов и таблица разметки трека. |

| Страница | Назначение |
| --- | --- |
| [`ProjectsPage`](../frontend/src/renderer/pages/ProjectsPage/ProjectsPage.tsx) | Выбор проекта: история открытых папок, открытие любой папки, переход к созданию нового. |
| [`NewProjectPage`](../frontend/src/renderer/pages/NewProjectPage/NewProjectPage.tsx) | Создание проекта: название, полный путь новой папки, имя MP4; папка создаётся из шаблона, Git используется при наличии. |
| [`ProjectPage`](../frontend/src/renderer/pages/ProjectPage/ProjectPage.tsx) | Обзор проекта: состояние, признаки, проблемы и следующий шаг. |
| [`SourcesPage`](../frontend/src/renderer/pages/SourcesPage/SourcesPage.tsx) | Исходники проекта: трек, текст песни, идея, обложка и референсы. |
| [`CastPage`](../frontend/src/renderer/pages/CastPage/CastPage.tsx) | Кастинг: сущности клипа, их изображения из исходников, роль, внешность и начальное состояние. |

Ещё: [`resources/templates/project`](../resources/templates/project).

## Разметка песни

Документы: [docs/timing.md](timing.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/timing`](../internal/timing) | Ведёт разметку песни plan/audio/timing.json: разбор текста source/text.md, вид для редактора таймингов, проверку и сохранение ручной разметки и сборку черновика после автоматической разметки. |
| [`internal/songtiming`](../internal/songtiming) | Локальная автоматическая разметка трека: кэш выделенного вокала вне проекта, задания выделения вокала и CTC-выравнивания и загрузка нужных компонентов. |
| [`internal/songml`](../internal/songml) | Выполняет ML-часть разметки песни: выделение вокала Voc FT (MDX-Net) и глобальное CTC-выравнивание известного текста в режиме margin/adaptive. |
| [`internal/speech`](../internal/speech) | Описывает речевые планы: строки песни в окне плана для выбора границ среза липсинка и подготовленный точный WAV пакета (audio/speech.wav и его рецепт audio/audio-recipe.json, которые режет штатный cut_speech). |
| [`internal/cutspeech`](../internal/cutspeech) | Вырезает точный WAV липсинка и его рецепт audio-recipe.json из исходной песни проекта (инструмент cut_speech). |

| Страница | Назначение |
| --- | --- |
| [`TimingPage`](../frontend/src/renderer/pages/TimingPage/TimingPage.tsx) | Редактор таймингов: загрузка документа, правки и сохранение подтверждённых на слух строк. |

## Сценарий

Документы: [docs/scenario-workflow.md](scenario-workflow.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/scenario`](../internal/scenario) | Вычисляет данные по реестру сцен plan/scenes.json: наследование состояния сущностей по state_from (ResolveStates) и отпечаток постановки плана (SceneFingerprints). |
| [`internal/sceneregistry`](../internal/sceneregistry) | Проверяет реестр сцен и проект для инструментов tools.run: единственный источник постановки и монтажного времени инструментов. |
| [`internal/scenesave`](../internal/scenesave) | Сохраняет реестр планов с учётом производства: определяет, какие планы меняют отпечаток постановки при сохранении черновика, с какой формальной причиной и что с ними станет. |
| [`internal/scenescaffold`](../internal/scenescaffold) | Строит детерминированный каркас реестра сцен plan/scenes.json (инструмент scene_scaffold) из сохранённой трактовки (plan/treatment.json), разметки трека (plan/audio/timing.json), текста песни и кастинга. |
| [`internal/sceneviews`](../internal/sceneviews) | Обновляет и проверяет производные представления единого реестра сцен (инструмент update_scene_views): документы internal/projectviews, PNG-карточки аниматика plan/animatic/cards/<план>.png (и .last.png последней опоры) и их квитанцию plan/animatic/cards/manifest.json. |
| [`internal/scenarioworkflow`](../internal/scenarioworkflow) | Ведёт сценарный проход агента: подготовка предложения кастинга и трактовки, реестра сцен или доработки выбранных планов, хранение предложения вне проекта, его разбор и проверка, утверждения пары и сцен и применение одной транзакцией. |
| [`internal/scenarioapply`](../internal/scenarioapply) | Хранилище многофайловой публикации семейства «сценарий» (кастинг, трактовка, реестр, опись исходников и их производные виды) с журналом и восстановлением после сбоя. |
| [`internal/continuitybrief`](../internal/continuitybrief) | Строит врезку непрерывности для плана (инструмент continuity_brief): состояние мира и героев словами на первый или последний кадр и чек-лист «да или нет» для проверки полученного изображения. |
| [`internal/lintregistry`](../internal/lintregistry) | Проверяет plan/scenes.json, кастинг, описание, комплекты assets, файл принятия и рабочие пакеты по встроенным JSON-схемам (подмножество JSON Schema) и правилам владения сведениями (хроника принятий и технические рецепты не хранятся в постановке). |

| Страница | Назначение |
| --- | --- |
| [`ScenarioPage`](../frontend/src/renderer/pages/ScenarioPage/ScenarioPage.tsx) | Сценарий связывает независимые черновики трактовки и реестра с их редакторами. |

Ещё: [`resources/skills/ai-clip-scenario`](../resources/skills/ai-clip-scenario).

## Производство и приёмка

Документы: [docs/production-workflow.md](production-workflow.md), [docs/agent-image-limits.md](agent-image-limits.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/production`](../internal/production) | Ведёт страницу «Производство»: вид планов и рабочих пакетов по файлам проекта, решения пользователя (через shot_workflow), согласование стоимости и платную отправку зафиксированного запроса, получение результата, повтор по сохранённому запросу и приёмку в assets. |
| [`internal/productionworkflow`](../internal/productionworkflow) | Ведёт проход агента производства: один план и один пакет проходят подготовку предложений описания, видеопромпта и запроса; проект меняется только отдельным Apply. |
| [`internal/shotworkflow`](../internal/shotworkflow) | Ведёт workflow.json рабочего пакета одного плана (инструмент shot_workflow): создание, план опор, кандидаты и принятие опор, промпт, вопросы и ответы приложения, этапы, image-ветка платных опор, перенос в очередь plan/awaiting и проверка целостности. |
| [`internal/shotstatus`](../internal/shotstatus) | Считает статусы планов (инструмент shot_status) по реестру сцен, выбранным комплектам assets, очереди plan/awaiting и рабочим попыткам plan/batches; кандидат next, таблица для человека, JSON для приложения и проверка независимости партии планов (--independent). |
| [`internal/regenerateshot`](../internal/regenerateshot) | Повторяет генерацию плана по сохранённому запросу без нового согласования (инструмент regenerate_shot). |
| [`internal/requestsnapshot`](../internal/requestsnapshot) | Готовит неизменяемый запрос генерации локально, без отправки: снимок спецификации, промпта и входов в новой папке попытки и атомарная запись его JSON. |
| [`internal/costcheck`](../internal/costcheck) | Оценивает стоимость запроса генерации и сверяет её с остатком кредитов до таблицы согласования (check), а после отправки записывает фактический расход наблюдением (learn); это инструмент cost_check. |
| [`internal/acceptance`](../internal/acceptance) | Определяет, какие комплекты assets/shots/Mxx приняты по текущей постановке. |
| [`internal/acceptshot`](../internal/acceptshot) | Принимает генерацию плана: инструмент accept_shot собирает комплект assets/shots/Mxx по контракту assets. |
| [`internal/assetpackage`](../internal/assetpackage) | Проверяет комплект принятого ассета и разрешает его файлы. |
| [`internal/verifyassetreplay`](../internal/verifyassetreplay) | Проверяет воспроизведение всех принятых комплектов планов из индекса assets/shots/manifest.json (инструмент verify_asset_replay). |
| [`internal/videoreview`](../internal/videoreview) | Проверяет полученное видео агентом: кадры по PTS, сверка с утверждёнными опорами и отчёт с наблюдениями (videoReview.view/start/cancel). |
| [`internal/contactsheet`](../internal/contactsheet) | Собирает техническую сводку полученного видео для быстрого просмотра (инструмент contact_sheet). |
| [`internal/dashboard`](../internal/dashboard) | Собирает дашборд сцен: по каждому плану реестра собирается всё, что о нём известно в проекте, в одну карточку: постановка и строка песни, положение на шкале, комплект в assets (оригинал против принятого монтажа, рецепт, промпт, входы), пакеты с опорами (production.ViewProduction), карточка аниматика, состояние героев до и после (scenario.ProjectBrief). |
| [`internal/checks`](../internal/checks) | Запускает проверки проекта (checks.list/run/runAll) заданиями общего менеджера с журналом и кодом завершения. |
| [`internal/checkassets`](../internal/checkassets) | Проверяет все выбранные комплекты assets/shots/M*/manifest.json проекта (validate_package, internal/assetpackage) и печатает сводку по их числу. |
| [`internal/checkworkspace`](../internal/checkworkspace) | Проверяет согласованность рабочего дерева проекта после приёмки: карточки и квитанция карточек, лишние пакеты plan/batches и plan/awaiting, пустые папки; готовые экспорты, пробы и материалы ручного монтажа не считаются остатками. |
| [`internal/tools`](../internal/tools) | Запускает инструменты комплекса по имени на папке проекта (метод контракта tools.run(project, name, args) → ToolResult). |

| Страница | Назначение |
| --- | --- |
| [`ProductionPage`](../frontend/src/renderer/pages/ProductionPage/ProductionPage.tsx) | Производство: список планов и один путь выбранного плана с решениями и подтверждениями платных действий. |
| [`ScenesPage`](../frontend/src/renderer/pages/ScenesPage/ScenesPage.tsx) | Дашборд сцен: сводка, шкала, сетка карточек и подробности плана: оригинал против монтажа, опоры, промпт, состояние до и после. |
| [`ChecksPage`](../frontend/src/renderer/pages/ChecksPage/ChecksPage.tsx) | Панель проверок: инструменты комплекса, проба стыков и текущие результаты. |

Ещё: [`resources/skills/ai-clip-scene`](../resources/skills/ai-clip-scene), [`resources/skills/ai-clip-video-review`](../resources/skills/ai-clip-video-review).

## Аниматик и монтаж

Документы: [docs/montage.md](montage.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/animatic`](../internal/animatic) | Проверяет сборку аниматика plan/animatic/latest: собрана ли она, свежа ли по реестру сцен и фактическим входам и принята ли именно она в plan/production-status.json. |
| [`internal/animaticcards`](../internal/animaticcards) | Рисует условные PNG-карточки аниматика для планов без видео. |
| [`internal/buildanimatic`](../internal/buildanimatic) | Детерминированно собирает единственный полный аниматик plan/animatic/latest (инструмент build_animatic) с кэшем проверенных фрагментов. |
| [`internal/buildreview`](../internal/buildreview) | Собирает временную видеопробу стыков из соседних сцен (инструмент build_review). |
| [`internal/montage`](../internal/montage) | Ведёт ручной монтаж соседних сцен: каталог монтажа (ViewProject), черновики plan/montage/<uuid>.json (Load/Save), экспорт пробы заданием build_review (Export), применение к сценам заданием apply_montage (Apply), путь и копия готовой пробы (VideoPath/CopyVideo) и восстановление прерванной публикации журнала plan/montage-history без инструмента (RecoverApplications/RecoverProjects). |
| [`internal/applymontage`](../internal/applymontage) | Применяет ручной монтаж (MontageDraft) к принятым комплектам assets/shots одной транзакцией (инструмент apply_montage). |
| [`internal/derivedshot`](../internal/derivedshot) | Определяет производный план по сценарию: план, материал которого собирается из принятого видео другого плана (derived_from.shot). |
| [`internal/derivedworkflow`](../internal/derivedworkflow) | Обслуживает страницу производного плана. |
| [`internal/deriveshot`](../internal/deriveshot) | Локально собирает производный план из принятого клипа другого плана без платной генерации и принимает показанные байты (инструмент derive_shot). |
| [`internal/exportbundle`](../internal/exportbundle) | Собирает пакет для монтажёра из реестра сцен, манифестов комплектов и разметки песни (инструмент export_edit_bundle). |
| [`internal/builtoutput`](../internal/builtoutput) | Задаёт границы удаления готовых результатов: удалять можно только обычные папки и файлы непосредственно в plan/batches выбранного проекта. |

| Страница | Назначение |
| --- | --- |
| [`AnimaticPage`](../frontend/src/renderer/pages/AnimaticPage/AnimaticPage.tsx) | Страница аниматика объединяет сборку, просмотр планов и принятие результата. |
| [`MontagePage`](../frontend/src/renderer/pages/MontagePage/MontagePage.tsx) | Монтаж: ручная проба из принятых планов, её черновики, экспорт и применение к сценам. |
| [`MontagePlayerPage`](../frontend/src/renderer/pages/MontagePlayerPage/MontagePlayerPage.tsx) | Отдельное окно воспроизводит несохранённый монтаж из основного окна, не создавая второй черновик. |

## Агенты и провайдеры медиа

Документы: [docs/agents.md](agents.md), [docs/development.md#агенты-и-провайдеры-медиа](development.md#агенты-и-провайдеры-медиа), [resources/providers/README.md](../resources/providers/README.md), [resources/skills/README.md](../resources/skills/README.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/agents`](../internal/agents) | Ведёт внешних текстовых агентов SongFrame (Codex и Claude Code): реестр исполнителей, глобальный выбор агента в settings.json, диагностику программы (поиск, версия, вход), сведения аккаунта и каталог моделей, аргументы и потоковые протоколы обоих CLI, задания с историей, отменой дерева процессов и вложениями изображений, а также явный выбор исполнителей ИИ (ai.access). |
| [`internal/providers`](../internal/providers) | Слой провайдеров медиа приложения: адаптеры, каталог моделей, вход и строки страницы «Среда». |
| [`internal/providers/agentexec`](../internal/providers/agentexec) | Задаёт контракт исполнителя опор провайдера-агента: провайдер, генерацию которого исполняет программа-агент из реестра (MediaProviderInfo.executor). |
| [`internal/providers/codex`](../internal/providers/codex) | Адаптер провайдера изображений Codex: опоры и обложки рисует программа-агент из реестра (internal/agents), отдельной программы провайдера нет. |
| [`internal/providers/kling`](../internal/providers/kling) | Адаптер провайдера генерации kling. |
| [`internal/providers/kling/mcp`](../internal/providers/kling/mcp) | Клиент MCP-сервера Kling на стандартной библиотеке Go: вход OAuth, хранение и обновление токенов, вызовы инструментов и загрузка файлов. |
| [`internal/mediaproviders`](../internal/mediaproviders) | Go-часть реестра провайдеров медиа (frontend/src/shared/media-providers.ts). |
| [`internal/mediaadapters`](../internal/mediaadapters) | Ведёт таблицу адаптеров провайдеров генерации: id провайдера → адаптер. |
| [`internal/mediaapi`](../internal/mediaapi) | Контракт адаптера провайдера генерации: необязательные возможности, их результаты и ошибки отправки. |
| [`internal/mediarequest`](../internal/mediarequest) | Ведёт жизненный цикл одной попытки генерации у выбранного провайдера (возможности, подготовка, единственная отправка, получение оригиналов, ручной результат при неизвестном исходе) и инструмент media_request. |
| [`internal/mediatest`](../internal/mediatest) | Тестовый провайдер генерации `test` без сети и платных запросов. |
| [`internal/mediatest/scenario`](../internal/mediatest/scenario) | Проигрывает сценарии эталонов платной попытки (домены media-request и cost-check в testdata/golden) и сравнивает каждый шаг с эталоном. |
| [`internal/mediafile`](../internal/mediafile) | Проверки файлов медиа, общие для слоя провайдеров (оригиналы платного провайдера, опоры провайдера-агента, референсы обложки) и производства: |
| [`internal/mediacmd`](../internal/mediacmd) | Запускает FFmpeg/ffprobe для медиаинструментов: cut_speech, contact_sheet, build_review, build_animatic и рендер участка accept_shot. |

| Страница | Назначение |
| --- | --- |
| [`SettingsPage`](../frontend/src/renderer/pages/SettingsPage/SettingsPage.tsx) | Настройки: выбор агента и его модели, переход к компонентам и обновление приложения. |
| [`EnvironmentPage`](../frontend/src/renderer/pages/EnvironmentPage/EnvironmentPage.tsx) | Проверка среды: что найдено, чего не хватает и для чего это нужно; встроенные ресурсы приложения. |

Ещё: [`frontend/src/shared/agent-providers.ts`](../frontend/src/shared/agent-providers.ts), [`frontend/src/shared/media-providers.ts`](../frontend/src/shared/media-providers.ts), [`resources/providers`](../resources/providers).

## Встроенные ресурсы

Документы: [resources/README.md](../resources/README.md), [resources/skills/README.md](../resources/skills/README.md).

| Пакет | Назначение |
| --- | --- |
| [`resources`](../resources) | Встраивает в бинарник ресурсы, которые приложение читает во время работы. |

Ещё: [`resources/skills`](../resources/skills), [`resources/fonts`](../resources/fonts).

## Семантика форматов и эталоны

Документы: [testdata/golden/README.md](../testdata/golden/README.md), [testdata/README.md](../testdata/README.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/toolrt`](../internal/toolrt) | Модель значений инструментов комплекса, в которой зафиксированы их файлы и вывод: строгий разбор и запись JSON, текстовые записи значений (repr для сообщений, str для текста), равенство и истинность, индексация, приведение и округление чисел, десятичная арифметика и разбор аргументов командной строки. |
| [`internal/toolregex`](../internal/toolregex) | Регулярные выражения с поиском с возвратом и классами Unicode для шаблонов инструментов (lint_registry, shot_status, check_workspace и др.). |
| [`internal/toolsubcmd`](../internal/toolsubcmd) | Разбор аргументов с обязательной подкомандой для CLI платной попытки (prog media_request, cost_check): у подкоманд — логические флаги, опции с одним или несколькими значениями, обязательные опции, списки допустимых значений, дробные значения и одна взаимоисключающая группа (в том числе обязательная). |
| [`internal/toolcli`](../internal/toolcli) | Общий каркас CLI-инструментов: результат запуска (код, stdout, stderr), печать строк со строгим кодированием UTF-8, завершение ошибкой аргументов, сообщением или необработанной ошибкой. |
| [`internal/dynvalue`](../internal/dynvalue) | Динамическая модель значений проектных JSON-файлов и ответов приложения: документ читается без схемы, а доменный код работает с деревом значений по фиксированным правилам истинности, строгого равенства, текстового приведения, порядка свойств и записи JSON. |
| [`internal/golden`](../internal/golden) | Читает эталоны поведения testdata/golden и сравнивает с ними результаты. |
| [`internal/repodocs`](../internal/repodocs) | Проверяет, что документация репозитория не разошлась с кодом, и генерирует карту кода docs/code-map.md. |

Ещё: [`testdata`](../testdata).

## Сборка и поставки

Документы: [packaging/README.md](../packaging/README.md), [packaging/windows/README.md](../packaging/windows/README.md), [dev-skills/songframe-build/SKILL.md](../dev-skills/songframe-build/SKILL.md), [dev-skills/songframe-release/SKILL.md](../dev-skills/songframe-release/SKILL.md).

| Пакет | Назначение |
| --- | --- |
| [`scripts/packtool`](../scripts/packtool) | Packtool — инструмент сборщика поставок и проверок разработчика: лицензионные материалы, квитанции сборки, значки темы hicolor, политика runtime AppDir, подготовка и статическая проверка Windows-поставки, проверка рецептов на паре FFmpeg/ffprobe. |
| [`scripts/appimage-bootstrap`](../scripts/appimage-bootstrap) | Подготовка AppArmor выполняется до загрузки GTK/WebKit: иначе отказ user namespaces завершает процесс внутри C и не оставляет понятной ошибки. |

Ещё: [`packaging`](../packaging), [`scripts`](../scripts), [`Taskfile.yml`](../Taskfile.yml), [`.github/workflows`](../.github/workflows), [`www`](../www).
