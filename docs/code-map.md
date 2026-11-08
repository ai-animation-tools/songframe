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
| [`internal/store`](../internal/store) | Отделяет постоянный профиль новой оболочки от профиля Electron. |
| [`internal/diagnostics`](../internal/diagnostics) | Хранит журнал и признак штатного завершения только в профиле новой оболочки. |
| [`internal/process`](../internal/process) | Единственный путь запуска внешних программ SongFrame (FFmpeg, ffprobe, агенты). |
| [`internal/jobs`](../internal/jobs) | Общий менеджер длительных заданий приложения: отправка и ожидание генерации, приёмка, сборки, проверки, загрузка моделей. |
| [`internal/projectfs`](../internal/projectfs) | Записывает файлы проекта и локального состояния атомарно и решает, разрешена ли запись в проект. |
| [`internal/filedigest`](../internal/filedigest) | Считает SHA-256 файлов проекта с кэшем в памяти процесса. |
| [`internal/media`](../internal/media) | Отдаёт разрешённые приложением файлы системному WebView через loopback. |
| [`internal/desktop`](../internal/desktop) | Открывает файлы и папки системными средствами и читает небольшие тексты, выбранные пользователем. |
| [`internal/trash`](../internal/trash) | Перемещает файлы и папки в корзину ОС вместо безвозвратного удаления (shell.trashItem оригинала). |
| [`internal/components`](../internal/components) | Хранит закреплённый состав производственных зависимостей. |
| [`internal/appversion`](../internal/appversion) | Хранит версию собранного приложения. |
| [`internal/updates`](../internal/updates) | Обновляет приложение по явному действию пользователя: читает последний выпуск публичного репозитория на GitHub, скачивает пакет своей поставки и сверяет его с digest SHA-256 и размером из GitHub API — тем же, что проверяет публикация выпуска. |

| Страница | Назначение |
| --- | --- |
| [`JobsPage`](../frontend/src/renderer/pages/JobsPage/JobsPage.tsx) | Задания: общая хронология заданий агентов и инструментов с состоянием, журналом и отменой. |
| [`ComponentsPage`](../frontend/src/renderer/pages/ComponentsPage/ComponentsPage.tsx) | Компоненты: состояние FFmpeg/ffprobe, ONNX Runtime и моделей, их установка кнопкой или выбор уже имеющихся. |

## Проект и исходники

Документы: [dev-skills/songframe-go-project-contract/SKILL.md](../dev-skills/songframe-go-project-contract/SKILL.md), [resources/templates/project/README.md](../resources/templates/project/README.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/project`](../internal/project) | Содержит общие сведения о папке проекта, которые нужны нескольким областям: описание медиафайла для медиасервера и распознавание незавершённых многофайловых публикаций. |
| [`internal/projectfile`](../internal/projectfile) | Владеет правкой маркера проекта plan/project.json: переименование (Projects.rename оригинала) и редактируемая часть настроек — название, имя MP4 аниматика, постоянные инструкции агенту и блок generation (readProjectSettings/writeProjectSettings из src/main/checks.ts). |
| [`internal/newproject`](../internal/newproject) | Создаёт папку клипа из встроенного шаблона: проверка формы «Новый проект» (validateNewProject оригинала), копирование шаблона с подстановкой плейсхолдеров (copyTemplate) и необязательный git init. |
| [`internal/status`](../internal/status) | Вычисляет состояние проекта из файлов его папки (computeStatus оригинала и постобработка обработчика IPC projects:status). |
| [`internal/sources`](../internal/sources) | Читает опись исходников source/manifest.json так же, как readManifest и descriptionManifest оригинала. |
| [`internal/sourceedit`](../internal/sourceedit) | Ведёт форму «Исходники»: просмотр (viewSources), проверку (validateSources) и сохранение (saveSources) трека, текста песни, идеи, обложки и референсов в source/ вместе с описью source/manifest.json. |
| [`internal/sourceinputs`](../internal/sourceinputs) | Отпечаток содержательных входов описи исходников (source-input-hash.ts оригинала). |
| [`internal/referenceimage`](../internal/referenceimage) | Переносит reference-image-storage.ts оригинала: референсы исходников и сущности кастинга делят одни файлы в source/, поэтому их запись согласуется здесь, а не в internal/sourceedit (форма «Исходники») или internal/cast (документ кастинга). |
| [`internal/cast`](../internal/cast) | Читает кастинг plan/cast.json для вычислений, которым нужны сущности проекта: начальное состояние сущностей входит в отпечаток постановки каждого плана. |
| [`internal/castregistry`](../internal/castregistry) | Перенос чтения кастинга из tools/cast_registry/cast_registry.py замороженного оригинала для Python-инструментов (scene_registry, scene_scaffold и проверок, которые переносятся следом): load_cast, validate_cast, проекция описаний из source/manifest.json, initial_states и references. |
| [`internal/covergen`](../internal/covergen) | Генерация обложки проекта и изображений референсов (cover-generation.ts, cover-provider.ts и cover-paid.ts оригинала). |
| [`internal/projectviews`](../internal/projectviews) | Перенос tools/project_views/project_views.py замороженного оригинала (634fd94): производные Markdown/JSON-представления реестра сцен и технических комплектов — монтажный список, раскадровка, индекс комплектов assets, ROADMAP с готовностью, справочник визуальных правил с речевыми планами, README комплектов и таблица разметки трека. |

| Страница | Назначение |
| --- | --- |
| [`ProjectsPage`](../frontend/src/renderer/pages/ProjectsPage/ProjectsPage.tsx) | Выбор проекта: история открытых папок, открытие любой папки, переход к созданию нового. |
| [`NewProjectPage`](../frontend/src/renderer/pages/NewProjectPage/NewProjectPage.tsx) | Создание проекта: название, полный путь новой папки, имя MP4; папка создаётся из шаблона, Git используется при наличии. |
| [`ProjectPage`](../frontend/src/renderer/pages/ProjectPage/ProjectPage.tsx) | Обзор проекта: состояние, признаки, проблемы и следующий шаг. |
| [`SourcesPage`](../frontend/src/renderer/pages/SourcesPage/SourcesPage.tsx) | Исходники проекта: трек, текст песни, идея, обложка и референсы. |
| [`CastPage`](../frontend/src/renderer/pages/CastPage/CastPage.tsx) | Кастинг: сущности клипа, их изображения из исходников, роль, внешность и начальное состояние. |

Ещё: [`resources/templates/project`](../resources/templates/project).

## Разметка песни

Отдельного документа нет: правила области описаны комментариями пакетов и страниц.

| Пакет | Назначение |
| --- | --- |
| [`internal/timing`](../internal/timing) | Переносит разметку песни plan/audio/timing.json: разбор текста source/text.md (shared/lyrics.ts), проверку разметки перед сохранением (shared/timing-validation.ts) и просмотр для редактора таймингов (viewTiming). |
| [`internal/songtiming`](../internal/songtiming) | Локальная автоматическая разметка трека: кэш выделенного вокала вне проекта, задания выделения вокала и CTC-выравнивания и загрузка нужных компонентов. |
| [`internal/songml`](../internal/songml) | Принятый ML-путь разметки песни (D-018/D-019): выделение вокала Voc FT (MDX-Net) и глобальное CTC-выравнивание известного текста в режиме margin/adaptive. |
| [`internal/speech`](../internal/speech) | Речевые планы (speech.ts оригинала): строки песни в окне плана для выбора границ среза липсинка и подготовленный точный WAV пакета (audio/speech.wav и его рецепт audio/audio-recipe.json, которые режет штатный cut_speech). |
| [`internal/cutspeech`](../internal/cutspeech) | Перенос tools/cut_speech/cut_speech.py: точный WAV липсинка и его рецепт audio-recipe.json из исходной песни проекта. |

| Страница | Назначение |
| --- | --- |
| [`TimingPage`](../frontend/src/renderer/pages/TimingPage/TimingPage.tsx) | Редактор таймингов: загрузка документа, правки и сохранение подтверждённых на слух строк. |

## Сценарий

Документы: [docs/scenario-workflow.md](scenario-workflow.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/scenario`](../internal/scenario) | Переносит вычисления по реестру сцен plan/scenes.json: наследование состояния сущностей по state_from (resolveStates) и отпечаток постановки плана (sceneFingerprints). |
| [`internal/sceneregistry`](../internal/sceneregistry) | Перенос tools/scene_registry/scene_registry.py замороженного оригинала: единственный источник постановки и монтажного времени для Python-инструментов. |
| [`internal/scenesave`](../internal/scenesave) | Сохранение реестра планов с учётом производства (scenario-save оригинала): какие планы меняют отпечаток постановки при сохранении черновика, с какой формальной причиной и что с ними станет. |
| [`internal/scenescaffold`](../internal/scenescaffold) | Перенос tools/scene_scaffold/scene_scaffold.py замороженного оригинала: детерминированный каркас реестра сцен plan/scenes.json из сохранённой трактовки (plan/treatment.json), разметки трека (plan/audio/timing.json), текста песни и кастинга. |
| [`internal/sceneviews`](../internal/sceneviews) | Перенос tools/update_scene_views/update_scene_views.py замороженного оригинала (634fd94): обновление и проверка производных представлений единого реестра сцен — документов internal/projectviews, PNG-карточек аниматика plan/animatic/cards/<план>.png (и .last.png последней опоры) и их квитанции plan/animatic/cards/manifest.json. |
| [`internal/scenarioworkflow`](../internal/scenarioworkflow) | Сценарный проход агента (ScenarioWorkflow оригинала, src/main/scenario-workflow.ts и scenario-apply.ts на 634fd94): подготовка предложения кастинга и трактовки, реестра сцен или доработки выбранных планов, хранение предложения вне проекта, его разбор и проверка, утверждения пары и сцен и применение одной транзакцией. |
| [`internal/scenarioapply`](../internal/scenarioapply) | Хранилище многофайловой публикации семейства «сценарий» (кастинг, трактовка, реестр, опись исходников и их производные виды) с журналом и восстановлением после сбоя. |
| [`internal/continuitybrief`](../internal/continuitybrief) | Перенос tools/continuity_brief/continuity_brief.py замороженного оригинала (634fd94): врезка непрерывности для плана — состояние мира и героев словами на первый или последний кадр и чек-лист «да или нет» для проверки полученного изображения. |
| [`internal/lintregistry`](../internal/lintregistry) | Перенос tools/lint_registry/lint_registry.py замороженного оригинала: проверка plan/scenes.json, кастинга, описания, комплектов assets, файла принятия и рабочих пакетов по JSON-схемам (подмножество JSON Schema оригинала) и правилам владения сведениями (хроника принятий и технические рецепты не хранятся в постановке). |

| Страница | Назначение |
| --- | --- |
| [`ScenarioPage`](../frontend/src/renderer/pages/ScenarioPage/ScenarioPage.tsx) | Сценарий связывает независимые черновики трактовки и реестра с их редакторами. |

Ещё: [`resources/skills/ai-clip-scenario`](../resources/skills/ai-clip-scenario).

## Производство и приёмка

Документы: [docs/production-workflow.md](production-workflow.md), [docs/agent-image-limits.md](agent-image-limits.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/production`](../internal/production) | Страница «Производство» главного процесса (production.ts оригинала): вид планов и рабочих пакетов по файлам проекта, решения пользователя (через shot_workflow), согласование стоимости и платная отправка замороженного запроса, получение результата, повтор по сохранённому запросу и приёмка в assets. |
| [`internal/productionworkflow`](../internal/productionworkflow) | Проход агента производства (ProductionWorkflow оригинала, src/main/production-workflow.ts, production-proposal.ts и production-workflow-apply.ts на 634fd94): один план и один пакет проходят подготовку предложений описания, видеопромпта и запроса; проект меняется только отдельным Apply. |
| [`internal/shotworkflow`](../internal/shotworkflow) | Перенос tools/shot_workflow/shot_workflow.py замороженного оригинала: ведение workflow.json рабочего пакета одного плана (создание, план опор, кандидаты и принятие опор, промпт, вопросы и ответы приложения, этапы, image-ветка платных опор, перенос в очередь plan/awaiting и проверка целостности). |
| [`internal/shotstatus`](../internal/shotstatus) | Перенос tools/shot_status/shot_status.py замороженного оригинала: статусы планов по реестру сцен, выбранным комплектам assets, очереди plan/awaiting и рабочим попыткам plan/batches; кандидат next, таблица для человека, JSON для приложения и проверка независимости партии планов (--independent). |
| [`internal/regenerateshot`](../internal/regenerateshot) | Перенос tools/regenerate_shot/regenerate_shot.py: повтор генерации плана по сохранённому запросу без нового согласования. |
| [`internal/requestsnapshot`](../internal/requestsnapshot) | Перенос tools/request_snapshot.py замороженного оригинала: общая локальная подготовка неизменяемого запроса генерации (снимок спецификации, промпта и входов в новой папке попытки) и атомарная запись его JSON. |
| [`internal/costcheck`](../internal/costcheck) | Перенос tools/cost_check/cost_check.py замороженного оригинала: оценка стоимости запроса генерации и сверка с остатком кредитов до таблицы согласования (check), а после отправки — запись фактического расхода наблюдением (learn). |
| [`internal/acceptance`](../internal/acceptance) | Определяет, какие комплекты assets/shots/Mxx приняты по текущей постановке. |
| [`internal/acceptshot`](../internal/acceptshot) | Перенос tools/accept_shot/accept_shot.py: перенос принятой генерации в комплект assets/shots/Mxx по контракту assets. |
| [`internal/assetpackage`](../internal/assetpackage) | Перенос проверки комплекта принятого ассета из tools/asset_package/asset_package.py оригинала (validate_package и разрешение файлов комплекта). |
| [`internal/verifyassetreplay`](../internal/verifyassetreplay) | Перенос tools/verify_asset_replay/verify_asset_replay.py: проверка воспроизведения всех принятых комплектов планов из индекса assets/shots/manifest.json. |
| [`internal/videoreview`](../internal/videoreview) | Переносит проверку полученного видео агентом (videoReview.view/start/cancel, src/main/video-review.ts и tools/video_review оригинала). |
| [`internal/contactsheet`](../internal/contactsheet) | Перенос tools/contact_sheet/contact_sheet.py замороженного оригинала (634fd94): техническая сводка полученного видео для быстрого просмотра. |
| [`internal/dashboard`](../internal/dashboard) | Дашборд сцен (src/main/dashboard.ts оригинала): по каждому плану реестра собирается всё, что о нём известно в проекте, в одну карточку: постановка и строка песни, положение на шкале, комплект в assets (оригинал против принятого монтажа, рецепт, промпт, входы), пакеты с опорами (production.ViewProduction), карточка аниматика, состояние героев до и после (scenario.ProjectBrief). |
| [`internal/checks`](../internal/checks) | Перенос группы checks.list/run/runAll из src/main/checks.ts замороженного оригинала: проверки проекта запускаются заданиями общего менеджера с журналом и кодом завершения. |
| [`internal/checkassets`](../internal/checkassets) | Перенос tools/check_assets/check_assets.py замороженного оригинала: проверка всех выбранных комплектов assets/shots/M*/manifest.json проекта (validate_package, internal/assetpackage) и сводка по их числу. |
| [`internal/checkworkspace`](../internal/checkworkspace) | Перенос tools/check_workspace/check_workspace.py замороженного оригинала (вместе с tools/montage_files.py): согласованность рабочего дерева проекта после приёмки — карточки и квитанция карточек, лишние пакеты plan/batches и plan/awaiting, пустые папки; готовые экспорты, пробы и материалы ручного монтажа не считаются остатками. |
| [`internal/tools`](../internal/tools) | Метод контракта tools.run(project, name, args) → ToolResult: запуск инструмента комплекса по имени на папке проекта. |

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
| [`internal/animaticcards`](../internal/animaticcards) | Рисует условные PNG-карточки аниматика — перенос tools/render_animatic_cards/render_animatic_cards.py замороженного оригинала (634fd94). |
| [`internal/buildanimatic`](../internal/buildanimatic) | Перенос tools/build_animatic/build_animatic.py и его кэша tools/animatic_cache/animatic_cache.py замороженного оригинала (634fd94): детерминированная сборка единственного полного аниматика plan/animatic/latest. |
| [`internal/buildreview`](../internal/buildreview) | Перенос tools/build_review/build_review.py: временная видеопроба стыков из соседних сцен. |
| [`internal/montage`](../internal/montage) | Перенос src/main/montage.ts, montage-video.ts и montage-recovery.ts оригинала: каталог ручного монтажа (ViewProject), черновики plan/montage/<uuid>.json (Load/Save), экспорт пробы заданием build_review (Export), применение к сценам заданием apply_montage (Apply), путь и копия готовой пробы (VideoPath/CopyVideo) и восстановление прерванной публикации журнала plan/montage-history без инструмента (RecoverApplications/RecoverProjects). |
| [`internal/applymontage`](../internal/applymontage) | Перенос tools/apply_montage оригинала: явное применение ручного монтажа (MontageDraft) к принятым комплектам assets/shots одной транзакцией. |
| [`internal/derivedshot`](../internal/derivedshot) | Производный план по сценарию (derived-shot.ts оригинала): план, материал которого собирается из принятого видео другого плана (derived_from.shot). |
| [`internal/derivedworkflow`](../internal/derivedworkflow) | Перенос src/main/derived-workflow.ts и derived-recovery.ts оригинала: страница производного плана. |
| [`internal/deriveshot`](../internal/deriveshot) | Перенос tools/derive_shot оригинала: локальная сборка производного плана из принятого клипа другого плана без платной генерации и приёмка показанных байтов. |
| [`internal/exportbundle`](../internal/exportbundle) | Перенос tools/export_edit_bundle/export_edit_bundle.py замороженного оригинала (634fd94): пакет для монтажёра из реестра сцен, манифестов комплектов и разметки песни. |
| [`internal/builtoutput`](../internal/builtoutput) | Границы удаления готовых результатов (built-output-path.ts оригинала): удалять можно только обычные папки и файлы непосредственно в plan/batches выбранного проекта. |

| Страница | Назначение |
| --- | --- |
| [`AnimaticPage`](../frontend/src/renderer/pages/AnimaticPage/AnimaticPage.tsx) | Страница аниматика объединяет сборку, просмотр планов и принятие результата. |
| [`MontagePage`](../frontend/src/renderer/pages/MontagePage/MontagePage.tsx) | Монтаж: ручная проба из принятых планов, её черновики, экспорт и применение к сценам. |
| [`MontagePlayerPage`](../frontend/src/renderer/pages/MontagePlayerPage/MontagePlayerPage.tsx) | Отдельное окно воспроизводит несохранённый монтаж из основного окна, не создавая второй черновик. |

## Агенты и провайдеры медиа

Документы: [docs/agents.md](agents.md), [docs/development.md#агенты-и-провайдеры-медиа](development.md#агенты-и-провайдеры-медиа), [resources/providers/README.md](../resources/providers/README.md), [resources/skills/README.md](../resources/skills/README.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/agents`](../internal/agents) | Переносит в Go внешних текстовых агентов SongFrame (Codex и Claude Code): реестр исполнителей, глобальный выбор агента в settings.json, диагностику программы (поиск, версия, вход), сведения аккаунта и каталог моделей, аргументы и потоковые протоколы обоих CLI, задания с историей, отменой дерева процессов и вложениями изображений, а также явный выбор исполнителей ИИ (ai.access). |
| [`internal/providers`](../internal/providers) | Слой провайдеров медиа приложения, единственный владелец того, что в оригинале делали src/main/providers/{types,index}.ts, src/main/media-providers.ts, media-catalog.ts и provider-guides.ts, а также маршруты environment:* и media:capabilities из ipc.ts и environment.ts: |
| [`internal/providers/agentexec`](../internal/providers/agentexec) | Контракт исполнителя опор провайдера-агента (AgentImageExecutor и KeyframeImages из src/main/providers/types.ts оригинала): провайдер, генерацию которого исполняет программа-агент из реестра (MediaProviderInfo.executor). |
| [`internal/providers/codex`](../internal/providers/codex) | Адаптер провайдера изображений Codex: опоры и обложки рисует программа-агент из реестра (internal/agents), отдельной программы провайдера нет. |
| [`internal/providers/kling`](../internal/providers/kling) | Go-адаптер провайдера генерации kling (перенос нужного из tools/kling_request/kling_request.py оригинала). |
| [`internal/providers/kling/mcp`](../internal/providers/kling/mcp) | Клиент MCP-сервера Kling на стандартной библиотеке Go: вход OAuth, хранение и обновление токенов, вызовы инструментов и загрузка файлов. |
| [`internal/mediaproviders`](../internal/mediaproviders) | Go-часть реестра провайдеров медиа (frontend/src/shared/media-providers.ts). |
| [`internal/mediaadapters`](../internal/mediaadapters) | Таблица Go-адаптеров провайдеров генерации: id провайдера → адаптер. |
| [`internal/mediaapi`](../internal/mediaapi) | Контракт адаптера провайдера генерации: необязательные возможности, их результаты и ошибки отправки. |
| [`internal/mediarequest`](../internal/mediarequest) | Перенос tools/media_request оригинала: общий жизненный цикл одной попытки генерации у выбранного провайдера (возможности, подготовка, единственная отправка, получение оригиналов, ручной результат при неизвестном исходе) и CLI media_request. |
| [`internal/mediatest`](../internal/mediatest) | Тестовый провайдер генерации `test` без сети и платных запросов: перенос tools/testing/fake_media_request.py оригинала. |
| [`internal/mediatest/scenario`](../internal/mediatest/scenario) | Проигрывает сценарии эталонов платной попытки (домены media-request и cost-check в testdata/golden) на Go-переносе и сравнивает каждый шаг с оригиналом. |
| [`internal/mediafile`](../internal/mediafile) | Проверки файлов медиа, общие для слоя провайдеров (оригиналы платного провайдера, опоры провайдера-агента, референсы обложки) и производства: |
| [`internal/mediacmd`](../internal/mediacmd) | Общий запуск FFmpeg/ffprobe для перенесённых медиаинструментов (этап 46): cut_speech, contact_sheet, build_review, build_animatic и рендер участка accept_shot. |

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

## Семантика оригинала и эталоны

Документы: [testdata/golden/README.md](../testdata/golden/README.md), [testdata/README.md](../testdata/README.md).

| Пакет | Назначение |
| --- | --- |
| [`internal/pycompat`](../internal/pycompat) | Воспроизводит семантику значений Python 3.12, на которой работали инструменты замороженного оригинала (`tools/*.py` Electron-версии SongFrame на срезе `634fd94`): разбор и запись JSON модулем json, repr/str, равенство и истинность, индексацию, приведение float()/round() и десятичную арифметику Decimal. |
| [`internal/pyre`](../internal/pyre) | Регулярные выражения с семантикой модуля re CPython 3.12 для строковых шаблонов перенесённых Python-инструментов (lint_registry, shot_status, check_workspace и др.). |
| [`internal/pyargparse`](../internal/pyargparse) | Argparse CPython 3.12 с подкомандами для перенесённых CLI платной попытки (media_request.py, cost_check.py): parser.add_subparsers(dest=..., required=True), у подкоманд — опции store_true, с одним значением или nargs="+", required=True, choices, type=float и одна взаимоисключающая группа (в том числе required=True). |
| [`internal/pytool`](../internal/pytool) | Общий каркас CLI-инструментов, перенесённых с Python: результат процесса (код, stdout, stderr), print() с кодированием UTF-8 и завершение необработанным исключением или parser.exit. |
| [`internal/jscompat`](../internal/jscompat) | Воспроизводит семантику JavaScript/Node.js, от которой зависит результат перенесённых функций Electron-оригинала SongFrame. |
| [`internal/golden`](../internal/golden) | Читает эталоны поведения замороженного Electron-оригинала SongFrame (commit 634fd94) из testdata/golden и сравнивает с ними результаты Go-переноса. |
| [`internal/repodocs`](../internal/repodocs) | Проверяет, что документация репозитория не разошлась с кодом, и генерирует карту кода docs/code-map.md. |

Ещё: [`testdata`](../testdata).

## Сборка и поставки

Документы: [packaging/README.md](../packaging/README.md), [packaging/windows/README.md](../packaging/windows/README.md), [dev-skills/songframe-go-build/SKILL.md](../dev-skills/songframe-go-build/SKILL.md), [dev-skills/songframe-go-release/SKILL.md](../dev-skills/songframe-go-release/SKILL.md).

| Пакет | Назначение |
| --- | --- |
| [`scripts/appimage-bootstrap`](../scripts/appimage-bootstrap) | Подготовка AppArmor выполняется до загрузки GTK/WebKit: иначе отказ user namespaces завершает процесс внутри C и не оставляет понятной ошибки. |

Ещё: [`packaging`](../packaging), [`scripts`](../scripts), [`Taskfile.yml`](../Taskfile.yml), [`.github/workflows`](../.github/workflows), [`www`](../www).
