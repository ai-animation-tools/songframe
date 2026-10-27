# Диаграммы процесса ai-clip-scene

Наглядное представление [скилла](SKILL.md) в пяти частях; в узлах указаны инструменты. Правила и условия переходов определяет скилл; диаграммы обновляются вместе с ним.

Узлы согласования работают через `workflow.json` пакета: основной поток пишет вопрос командой `shot_workflow ask --stage …`, блокируется в `shot_workflow wait`, а приложение по кнопке пользователя записывает ответ командой `shot_workflow decide --verdict …`. Переход по стрелке разрешает только полученный вердикт (`wait` с кодом 0); код 2 (время вышло) и код 3 (пакет изменён снаружи) перехода не дают. Подготовку материалов внутри узлов выполняет субагент, в чат возвращается карточка. Без приложения вопрос задаётся текстом с теми же вариантами, и ответ записывается через `decide` агентом. Полные правила в разделах [«Согласования в приложении»](SKILL.md#согласования-в-приложении) и [«Субагенты»](SKILL.md#субагенты).

## 1. Вызов и выбор плана

```mermaid
flowchart TD
    START(["Вызов ai-clip-scene"]) --> STATUS["shot_status: статусы, очередь, next"]
    STATUS --> MODE{"list=?"}
    MODE -->|"all / progress / completed"| LIST["Показать таблицу shot_status"] --> EXIT(["Без подготовки и расхода"])
    MODE -->|"Нет"| REGEN{"regenerate=true?"}
    REGEN -->|"Да"| RG(["Часть 5: regenerate_shot"])
    REGEN -->|"Нет"| ACCEPT{"accept=Mxx attempt=NN?"}
    ACCEPT -->|"Да"| ACC(["Часть 4: этап 6 без показа"])
    ACCEPT -->|"Нет"| EXPLICIT{"Указан Mxx или batch?"}
    EXPLICIT -->|"batch=…"| INDEP["shot_status --independent"]
    INDEP -->|"Конфликт по состоянию"| ASKBATCH["Показать зависимости, сузить партию"] --> EXPLICIT
    INDEP -->|"Соседи по шкале"| ADJ{"Стык: смена ракурса<br/>или пропуск?"}
    ADJ -->|"Нет"| ASKBATCH
    ADJ -->|"Да, по ответу пользователя"| USE
    INDEP -->|"Независимы"| USE
    EXPLICIT -->|"Mxx"| USE["Выбрать именно этот план"]
    EXPLICIT -->|"Нет"| QUEUE{"Очередь непуста?"}
    QUEUE -->|"Да"| SELECT["Предложить выбрать пакет очереди"] --> USE
    QUEUE -->|"Нет, scene=next"| NEXT["Кандидат next из shot_status<br/>Спросить, начать ли"] --> USE
    USE --> STAGEARG{"stage=?"}
    STAGEARG -->|"Назван этап"| BACK["set-stage назад на названный этап<br/>всё после него недействительно"] --> PREP
    STAGEARG -->|"Нет"| STATE{"Состояние пакета"}
    STATE -->|"Нет пакета"| PREP(["Часть 2: shot_workflow init"])
    STATE -->|"Этап подготовки"| RESUME["Продолжить этап по shot_workflow show"] --> PREP
    STATE -->|"ready / needs_revision"| SAVED(["Часть 3: из очереди"])
    STATE -->|"submitted / неизвестный исход"| RECOVER(["Часть 3: recovery.md"])
    STATE -->|"downloaded"| VIEW(["Часть 4: показать результат"])
    STATE -->|"Комплект в assets"| DONE(["Готово; без поручения не заменять"])
```

## 2. Подготовка и согласование

```mermaid
flowchart TD
    INIT["shot_workflow init Mxx --mode shot|frame<br/>generation.video/image из plan/project.json<br/>scene_registry: before/after<br/>continuity_brief: врезка и чек-лист<br/>capabilities: модели аккаунта"] --> DESC["Субагент: описание в пакете<br/>окно, T, D по duration_rule, первый кадр словами,<br/>сущности из кастинга, план опор (plan-keyframes),<br/>модель по model-selection.md"]
    DESC --> ASK_D["ask --stage description_review<br/>wait"]
    ASK_D --> D{"Вердикт"}
    ASK_D -->|"код 2"| ASK_D
    D -->|"revise + note"| FIX_D["Записать постановку у владельца (state.md)<br/>update_scene_views; править только названное"] --> DESC
    D -->|"approve"| BACKEND{"generation.image.provider"}
    BACKEND -->|"codex или импорт"| FRAMES{"Режим"}
    BACKEND -->|"kling"| IPREP["Одна Kxx: frozen image request<br/>set-image-request: отдельная image-история"]
    IPREP --> IASK["image_request_choice: send/park/revise<br/>показ точного SHA, inputs, цены/остатка"]
    IASK -->|"park/revise"| IWAIT["Сохранить / доработать без расхода"]
    IASK -->|"send и цена известна"| ISEND["Один submit показанного SHA<br/>image_submitted; resume того же ID"]
    ISEND --> IDOWN["image_downloaded: original PNG/JPEG/WebP<br/>select-image: кандидат approved=false"]
    IDOWN --> IMORE{"Все нужные кандидаты выбраны?"}
    IMORE -->|"Нет"| IPREP
    IMORE -->|"Да"| ASK_F
    FRAMES -->|"shot"| ALL["Субагент: все опоры<br/>image_gen с врезкой --paragraph,<br/>чек-лист continuity_brief,<br/>propose для каждой"]
    FRAMES -->|"frame"| ONE["Субагент: только текущая опора<br/>current_keyframe, propose"]
    ALL --> ASK_F["ask --stage keyframes_review<br/>wait"]
    ONE --> ASK_F
    ASK_F --> F{"Вердикт"}
    F -->|"revise + note"| REDO["Перегенерировать только названные<br/>затронута ранняя: вернуться к ней<br/>propose заново"] --> ASK_F
    F -->|"approve"| APPROVED["decide принял всех кандидатов<br/>approved_frames в workflow.json"]
    APPROVED --> MORE{"Остались опоры (frame)?"}
    MORE -->|"Да"| ONE
    MORE -->|"Нет"| PROMPT["Субагент: video-prompt.txt<br/>по prompt-template.md с врезкой дословно"]
    PROMPT --> ASK_P["ask --stage prompt_review<br/>wait"]
    ASK_P --> P{"Вердикт"}
    P -->|"revise: текст"| EDIT["Исправить только названное"] --> ASK_P
    P -->|"revise: затрагивает опоры"| REDO
    P -->|"approve"| PACK["Субагент: спецификация по generation.video и video capabilities<br/>kling_request prepare<br/>cost_check check<br/>set-stage request_choice --request-dir<br/>таблица запроса в пакете"]
    PACK --> SEND(["Часть 3: ask --stage request_choice"])
```

Выбор кандидата изображения не утверждает опору и не принимает assets. Текстовый агент и глобальный Codex `imageAgent` независимы от backend медиа; `app|agent` остаётся единственным владельцем продолжения.

В партии этапы описания, опор и промпта проходят по одному раунду на всех планах сразу (`--batch` в `shot_workflow init`): субагент готовит все пакеты, `ask` ставится в каждом пакете, `wait` выполняется по очереди. Таблицы и отправки остаются поплановыми, ожидание общее через `watch`.

## 3. Отправка, очередь, получение

```mermaid
flowchart TD
    NEW(["Таблица нового пакета"]) --> ASK_R["ask --stage request_choice<br/>wait"]
    ASK_R -->|"код 2"| ASK_R
    ASK_R --> CHOICE{"Вердикт"}
    CHOICE -->|"park"| PARK["shot_workflow park --wait-reason user_saved"] --> WAIT(["Ожидание без расхода"])
    CHOICE -->|"send"| VERDICT{"Вердикт cost_check"}
    VERDICT -->|"insufficient_balance<br/>cost_or_balance_unknown"| PARK2["park с этой причиной<br/>сообщить пользователю"] --> WAIT
    VERDICT -->|"ok, запрос неизменён"| SUBMIT["kling_request submit --confirm SHA<br/>ровно один раз, без второго вопроса"]
    FROM_QUEUE(["Пакет из очереди"]) --> CHECK["shot_workflow check<br/>kling_request status<br/>cost_check"]
    TOPUP(["«Счёт пополнен»"]) --> CHECK
    CHECK --> TABLE2["Таблица заново"] --> ASK_Q["ask --stage request_choice<br/>«Запустить этот запрос?» send,park<br/>wait"]
    ASK_Q -->|"park"| WAIT
    ASK_Q -->|"send"| VERDICT
    SUBMIT --> LEARN["cost_check learn<br/>set-stage submitted"]
    LEARN --> POLL["Субагент: kling_request watch<br/>одно ожидание"]
    RECOVERY(["Неизвестный исход"]) --> FIND["recovery.md: установить ID<br/>resume --generation-id"] --> POLL
    POLL --> RESULT{"Состояние"}
    RESULT -->|"время вышло"| POLL
    RESULT -->|"failed"| ERROR(["Сообщить причину, ждать решения"])
    RESULT -->|"downloaded"| SHOW(["Часть 4: set-stage downloaded"])
```

## 4. Результат, проба, приёмка

```mermaid
flowchart TD
    VIDEO["Субагент: contact_sheet<br/>параметры, контактный лист, границы рядом с опорами,<br/>чек-лист continuity_brief before/after, превью 2×<br/>«ожидает просмотра», без оценок"] --> ASK_V["ask --stage downloaded<br/>wait"]
    ASK_V -->|"код 2"| ASK_V
    ASK_V --> DECISION{"Вердикт"}
    DECISION -->|"retry"| RETRY["init --retry-of: новая попытка<br/>вернуться к затронутому этапу части 2<br/>новое разрешение на расход"]
    DECISION -->|"review"| REVIEW["build_review с соседями<br/>состав и обработка по поручению"] --> ASK_V
    DECISION -->|"accept"| EDIT_READY{"Участок и обработка определены?"}
    ACCEPT_ARG(["accept=Mxx attempt=NN"]) --> EDIT_READY
    EDIT_READY -->|"Нет"| ASK_EDIT["set-stage edit_review<br/>ask --stage edit_review: только участок<br/>wait"] --> EDIT_READY
    EDIT_READY -->|"Да"| ASSETS["accept_shot Mxx --package … --review | --cut<br/>оригинал, принятый монтаж, опоры, промпт,<br/>WAV, manifest.json с рецептом"]
    ASSETS --> VERIFY["внутри accept_shot: asset_package,<br/>cost_check learn, update_scene_views"]
    VERIFY -->|"Ошибка"| STOP(["Комплект не записан; исправить вход"])
    VERIFY -->|"OK"| CLEAN["--clean: удалить все пакеты плана,<br/>очередь, пробу и пустые папки"] --> FINISH(["Сцена принята"])
```

## 5. Повтор запроса: `regenerate=true`

```mermaid
flowchart TD
    RG(["scene=Mxx regenerate=true"]) --> TOOL["regenerate_shot Mxx --submit --json"]
    TOOL --> FOUND{"Источник запроса"}
    FOUND -->|"Нет данных, чужой формат или провайдер<br/>код 3; расхождение с generation"| NONE(["Сообщить пользователю,<br/>предложить этапы 1–4; ничего не выдумывать"])
    FOUND -->|"request.json пакета<br/>или снимок комплекта"| PKG["Новый пакет Mxx-attempt-NN с retry_of<br/>prepare, request_sha256, cost_check"]
    PKG --> CV{"Вердикт cost_check"}
    CV -->|"insufficient_balance<br/>cost_or_balance_unknown"| PARK3["Отправки нет: park с причиной,<br/>сообщить пользователю"] --> WAIT3(["Ожидание без расхода"])
    CV -->|"ok"| SUB["submit ровно один раз внутри инструмента<br/>одно явное поручение на показанный запрос<br/>и проверенную цену; не будущие retries"]
    SUB --> W["learn, submitted, watch внутри инструмента;<br/>затем contact_sheet субагентом"] --> SHOW5(["Часть 4: ask --stage downloaded"])
```

Пересборка полного аниматика, commit и push выполняются по отдельному поручению.
