# Карта производства

Схемы пути плана на странице «Производство»: все ветки от сценария до принятого видео и то, что на каждом этапе получает агент. Правила, проверки и контракт описаны в [production-workflow.md](production-workflow.md); схемы их не заменяют, а показывают, как шаги связаны.

Цвета на схемах:

| Цвет | Кто действует |
| --- | --- |
| жёлтый | пользователь: решение, свой файл или текст |
| фиолетовый | текстовый агент или агент изображений |
| синий | приложение само, без агента и сети |
| красный | платная операция: цена, согласие, списание |
| зелёный | сервис генерации |
| серый пунктир | тупик или возврат: отказ, ошибка, устаревание |

## Весь путь плана

Три способа поставить план: обычное производство, своё готовое видео или производный план из уже принятого клипа. Речевой план добавляет срез речи; без липсинка у провайдера видео он идёт ручной генерацией.

```mermaid
flowchart TD
  start(["План Mxx без принятого видео"]) --> how{"Как ставим план?"}
  how -- "Подготовить описание<br/>или Написать самому" --> desc["Описание<br/>текст, события, план опор"]
  how -- "Загрузить своё видео" --> own["Своё видео<br/>MP4, источник, цена"]
  how -- "derived_from в сценарии" --> derived["Производный план<br/>обрезка, скорость, стоп-кадр, повтор"]
  desc --> kf["Опоры K01…Kn<br/>по одной, каждая утверждается"]
  kf --> vp["Видеопромпт<br/>оригинал и перевод"]
  vp --> lip{"План с липсинком?"}
  lip -- "да" --> speech["Срез речи<br/>audio/speech.wav"]
  lip -- "нет" --> method
  speech --> method{"Способ генерации попытки"}
  method -- "провайдер проекта" --> req["Запрос<br/>request-NN"]
  method -- "вручную вне приложения<br/>или провайдер без липсинка" --> manual["Пакет ручной генерации<br/>видео делается вне приложения"]
  req --> pay["Платная отправка<br/>SHA, цена, согласие"]
  pay --> gen["Генерация и получение"]
  gen --> res["Результат: оригинал скачан"]
  manual -- "Загрузить видео" --> res
  own --> res
  res --> accept["Приёмка<br/>assets/shots/Mxx"]
  derived --> dprev["Предпросмотр FFmpeg"] --> daccept["Приёмка производного плана"]
  accept --> done(["План принят"])
  daccept --> done

  class how,method,lip,own,manual,speech user
  class desc,vp agent
  class kf,req,derived,dprev app
  class pay paid
  class gen service
  class res,accept,daccept app
  classDef user fill:#FAEEDA,stroke:#BA7517,color:#412402
  classDef agent fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef app fill:#E6F1FB,stroke:#185FA5,color:#042C53
  classDef paid fill:#FCEBEB,stroke:#A32D2D,color:#501313
  classDef service fill:#E1F5EE,stroke:#0F6E56,color:#04342C
  classDef bad fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A,stroke-dasharray:4 3
```

## Описание

Перед подготовкой выбирается число опор: «Авто» (агент берёт от 2 до 20) или точное число до предела провайдера видео. Агент работает только на чтение и отвечает одним JSON: предложением или отказом со списком противоречий. Отказ — нормальный исход: сценарий спорит с фактами кадра, кадрами соседних планов или сам с собой, и опоры по нему вышли бы неверными.

```mermaid
flowchart TD
  pre["Сценарий утверждён, агент выбран,<br/>число опор: Авто или 1…предел"] --> who{"Кто пишет описание?"}
  who -- "Подготовить описание" --> job["Задание агента описания"]
  who -- "Написать самому" --> owntext["Своё описание и план опор"]
  job --> answer{"Ответ агента"}
  answer -- "описание" --> check{"Проверка приложения"}
  answer -- "stage: blocked" --> blocked["Отказ: список противоречий"]
  answer -- "ошибка или остановка" --> failed["Ошибка или<br/>Подготовка остановлена"]
  check -- "контракт нарушен:<br/>формат, число опор, референсы" --> invalid["Результат требует исправления<br/>применить нельзя"]
  check -- "в порядке" --> ready["Предложение<br/>Посмотреть и решить"]
  blocked -- "значение врезки:<br/>состояние героя или места" --> fix["Исправить сценарий и подготовить заново<br/>агент запускается сам"]
  blocked -- "Камера, Действие, Непрерывность,<br/>В кадре, Точка съёмки" --> page["Правка на странице Сценарий,<br/>затем снова Подготовить описание"]
  ready --> decide{"Решение"}
  decide -- "Принять" --> applied["Попытка plan/batches/Mxx-attempt-NN<br/>description.md, keyframe-prompts.json"]
  decide -- "Доработать<br/>с замечанием" --> again["Агент готовит<br/>новое предложение"]
  decide -- "Отклонить предложение" --> dropped["Предложение удалено"]
  decide -- "Закрыть, решу позже" --> waiting["План ждёт вас"]
  ready -. "сценарий или материалы<br/>изменились" .-> stale["Устарело: только отклонить"]
  owntext -- "Сохранить и принять" --> applied
  applied --> next(["Опоры"])

  class who,decide,fix,page,owntext user
  class job,again agent
  class pre,check,ready,applied app
  class invalid,blocked,failed,stale,waiting,dropped bad
  classDef user fill:#FAEEDA,stroke:#BA7517,color:#412402
  classDef agent fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef app fill:#E6F1FB,stroke:#185FA5,color:#042C53
  classDef bad fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A,stroke-dasharray:4 3
```

Доработка оплаченной попытки создаёт новую попытку с `retry_of`: утверждённые опоры с неизменными файлами переносятся в неё утверждёнными.

## Опоры

Опоры идут строго по порядку плана: следующая создаётся, когда решено с предыдущей. Утверждённые опоры становятся референсами следующих, поэтому внешность, свет и расстановка держатся от K01 до последней.

```mermaid
flowchart TD
  next["Следующая опора Kxx"] --> kind{"Что за опора?"}
  kind -- "копия другой опоры<br/>или кадр принятого плана" --> copy["Приложение копирует байты<br/>и утверждает само"]
  kind -- "обычная" --> how{"Чем создаём?"}
  note["Добавить указание<br/>замечание к опоре"] -.-> how
  how -- "провайдер-исполнитель" --> exec["Задание агента изображений<br/>после подтверждения расхода лимита"]
  how -- "платный провайдер изображений" --> image["Image-запрос<br/>см. Платная отправка"]
  how -- "Свой файл" --> file["PNG, JPEG или WebP"]
  exec --> candidate["Кандидат Kxx"]
  image -- "Выбрать как опору" --> candidate
  file --> candidate
  candidate --> ask{"Утвердить опору Kxx?"}
  ask -- "Утвердить" --> approved["Kxx утверждена<br/>референс следующих опор"]
  ask -- "Доработать<br/>с замечанием" --> revise["Кандидат снят, замечание:<br/>только Kxx или и следующие"]
  revise -- "создать заново" --> how
  revise -- "нужно менять промпты опор" --> redesc["Доработать описание"]
  approved -. "Вернуть на доработку<br/>пока промпт не утверждён" .-> revise
  copy --> more{"Ещё опоры?"}
  approved --> more
  more -- "да" --> next
  more -- "нет" --> prompt(["Видеопромпт"])

  class how,note,file,ask,revise user
  class exec,redesc agent
  class next,kind,copy,candidate,approved,more app
  class image paid
  classDef user fill:#FAEEDA,stroke:#BA7517,color:#412402
  classDef agent fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef app fill:#E6F1FB,stroke:#185FA5,color:#042C53
  classDef paid fill:#FCEBEB,stroke:#A32D2D,color:#501313
  classDef service fill:#E1F5EE,stroke:#0F6E56,color:#04342C
  classDef bad fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A,stroke-dasharray:4 3
```

Опору, которую уже не вернуть на месте (запрос подготовлен или отправлен), исправляют в «Новой попытке с теми же опорами».

## Видеопромпт и способ генерации

Агент пишет промпт на языке указаний провайдера видео и рядом русский перевод. К отправке выбирается один из вариантов; предел длины провайдера относится к нему.

```mermaid
flowchart TD
  ready["Все опоры утверждены"] --> hints["Добавить указания<br/>необязательно"]
  hints --> job["Задание агента видеопромпта"]
  ready -- "Написать самому" --> own["Свой промпт без перевода"]
  job --> proposal["Предложение:<br/>оригинал и перевод"]
  proposal --> limit{"Длиннее предела провайдера?"}
  limit -- "да" --> shorten["Принять нельзя<br/>Доработать с замечанием о сокращении"]
  shorten --> job
  limit -- "нет" --> decide{"Решение"}
  decide -- "Принять выбранный вариант" --> approved["video-prompt.txt и перевод<br/>approved_prompt_sha256"]
  decide -- "Доработать" --> job
  own -- "Сохранить и принять" --> approved
  approved -. "Вернуть на доработку<br/>пока запрос не отправлен" .-> job
  approved --> lip{"План с липсинком?"}
  lip -- "да" --> speech["Срез речи<br/>границы по разметке, Подготовить WAV"]
  lip -- "нет" --> method{"Способ генерации попытки"}
  speech --> method
  method -- "провайдер проекта" --> request(["Запрос"])
  method -- "вручную вне приложения" --> manual["Собрать пакет<br/>опоры, промпт, срез речи"]
  manual --> upload["Видео сделано вне приложения<br/>Загрузить видео: MP4, источник, цена"]
  upload --> result(["Результат"])

  class hints,own,decide,lip,speech,method,upload user
  class job agent
  class ready,proposal,limit,approved,manual app
  class shorten bad
  classDef user fill:#FAEEDA,stroke:#BA7517,color:#412402
  classDef agent fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef app fill:#E6F1FB,stroke:#185FA5,color:#042C53
  classDef paid fill:#FCEBEB,stroke:#A32D2D,color:#501313
  classDef service fill:#E1F5EE,stroke:#0F6E56,color:#04342C
  classDef bad fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A,stroke-dasharray:4 3
```

## Запрос и платная отправка

Запрос собирает приложение без агента. Схема показывает запрос видео; платная опора проходит те же оценку, согласие, отправку и получение по одному image-запросу, а скачанный вариант выбирается кандидатом опоры. Каждая отправка записывается в журнал отправок до того, как уходит к сервису.

```mermaid
flowchart TD
  prep["Подготовить запрос<br/>модель, слоты опор, звуковой слот,<br/>параметры по правилам провайдера"] --> folder["Папка request-NN<br/>промпт, копии входов, request_sha256"]
  folder --> choice{"Отправить?"}
  choice -- "Изменить" --> change["Другая модель или параметры<br/>новая папка request-NN"]
  change --> choice
  choice -- "Сохранить в очередь" --> queue["plan/awaiting/Mxx"]
  queue -- "Отправить из очереди" --> quote
  choice -- "Отправить" --> quote["Оценка: цена и остаток"]
  quote --> price{"Цена"}
  price -- "известна, средств хватает" --> send["Отправить и списать кредиты"]
  price -- "неизвестна" --> agree["Я согласен<br/>и проверка промпта"]
  agree --> send
  price -- "нехватка или остаток неизвестен" --> blocked["Отправка заблокирована<br/>Обновить стоимость"]
  blocked --> quote
  send --> recheck{"Повторная проверка Go<br/>цена, остаток, материалы"}
  recheck -- "что-то изменилось" --> quote
  recheck -- "совпадает" --> submit["Отправка сервису"]
  submit -- "сервис отклонил до оплаты" --> choice
  submit -- "ID задания получен" --> watch["Генерация и получение<br/>по сохранённому ID"]
  watch -- "приложение закрыто" --> resume["Продолжить получение<br/>без повторной оплаты"]
  resume --> watch
  watch --> downloaded(["Результат скачан"])
  submit -- "обрыв во время отправки" --> unknown["Исход неизвестен<br/>повторная отправка запрещена"]
  unknown -- "нашли генерацию на сайте" --> manualres["Загрузить результат вручную"]
  manualres --> downloaded
  unknown -- "не нашли" --> notcreated["Задание не создано<br/>попытка снова подготовлена"]
  notcreated --> quote

  class choice,agree,manualres,notcreated user
  class prep,folder,change,queue,recheck app
  class quote,price,send paid
  class submit,watch,resume service
  class blocked,unknown bad
  classDef user fill:#FAEEDA,stroke:#BA7517,color:#412402
  classDef agent fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef app fill:#E6F1FB,stroke:#185FA5,color:#042C53
  classDef paid fill:#FCEBEB,stroke:#A32D2D,color:#501313
  classDef service fill:#E1F5EE,stroke:#0F6E56,color:#04342C
  classDef bad fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A,stroke-dasharray:4 3
```

Согласие действует на одну показанную оценку: «Обновить стоимость», смена запроса, «Ещё» или повтор после ошибки требуют нового.

## Результат, приёмка и повтор

```mermaid
flowchart TD
  result["Результат: скачан или загружен"] --> sheet["Сделать техническую сводку<br/>необязательно"]
  result --> review["Проверить видео агентом<br/>необязательно"]
  result --> ask{"Что делаем с результатом?"}
  ask -- "Принять" --> window{"Окно приёмки"}
  window -- "длина как у плана,<br/>кадр 1920×1080, частота проекта" --> full["Целиком: побайтная копия"]
  window -- "иначе" --> cut["Участок: начало, конец, скорость,<br/>удержание последнего кадра"]
  full --> accept["accept_shot: assets/shots/Mxx<br/>отпечаток постановки"]
  cut --> accept
  accept -- "у плана был комплект" --> replaced["Прежний комплект<br/>в assets/replaced/Mxx"]
  ask -- "Новая генерация" --> regen["Новая попытка по сохранённому запросу<br/>снова цена и согласие"]
  ask -- "Собрать пробу стыков" --> probe["Монтаж пробы с соседями<br/>вопрос остаётся открытым"]
  ask -- "Доработать с замечанием" --> revise["Агент дорабатывает этап"]
  accept --> accepted(["План принят"])
  accepted -. "постановка в сценарии изменилась" .-> stale["Постановка изменена<br/>нужно новое производство"]

  class ask,window,full,cut user
  class review,revise agent
  class sheet,accept,replaced,probe app
  class regen paid
  class stale bad
  classDef user fill:#FAEEDA,stroke:#BA7517,color:#412402
  classDef agent fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef app fill:#E6F1FB,stroke:#185FA5,color:#042C53
  classDef paid fill:#FCEBEB,stroke:#A32D2D,color:#501313
  classDef service fill:#E1F5EE,stroke:#0F6E56,color:#04342C
  classDef bad fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A,stroke-dasharray:4 3
```

Меню «Другие действия» плана начинает попытку заново с нужного места:

| Действие | С чего начинается новая попытка |
| --- | --- |
| Новая попытка с описания | с шага «Описание» |
| Новая попытка с теми же опорами | с шага «Видеопромпт»: описание и утверждённые опоры переносятся |
| Новая попытка только с первой опорой | с шага «Видеопромпт»: описание и первая опора переносятся, промпт пишется для одной опоры |
| Повторить по сохранённому запросу | с вопроса об отправке того же запроса |
| Удалить попытку | попытка удаляется целиком, оплаченный оригинал тоже |

## Что получает агент

Агента запускает приложение без shell ([agents.md](agents.md)). Задания описания, видеопромпта и проверки видео только читают проект: агент не может ничего записать и отвечает одним JSON. Задание опор пишет только в свою рабочую папку вне проекта. Текст задания складывается из общего вступления, постоянных инструкций проекта (кроме заданий изображений), встроенного скилла с задачей и контекста JSON. Изображения идут отдельными вложениями в пределах [бюджета агента](agent-image-limits.md). Каждое задание записывается в журнал отправок `plan/prompt-log/` целиком: промпт, контекст, вложения путями и SHA, ответ.

Ответ агента не пишется в проект напрямую: приложение проверяет его по контракту. Описание и видеопромпт применяются только после решения пользователя, а файлы опор становятся кандидатами, которые пользователь утверждает.

### Описание

```mermaid
flowchart LR
  subgraph task["Текст задания"]
    direction LR
    skill["Скилл ai-clip-scene:<br/>правила, контракт предложений,<br/>шаблон промптов"]
    guide["Указания агенту<br/>провайдеров видео и изображений"]
    rules["Постоянные инструкции проекта"]
  end
  subgraph context["Контекст JSON"]
    direction LR
    scene["scene: постановка плана,<br/>направление части, визуальные правила"]
    cast["cast и references: сущности плана,<br/>их изображения и примечания к ним"]
    brief["brief: врезка непрерывности<br/>на первый и последний кадр;<br/>stateSources: откуда каждое значение"]
    frame["frame: факты кадра по схеме локации<br/>только у плана с точкой съёмки"]
    scheme["scheme: схема локации точки<br/>без цвета: форма и высота ориентиров"]
    tech["settings, capabilities, windowSeconds,<br/>allowedPaths, keyframeCount,<br/>speech, lipSync, manualGeneration"]
    current["existing, description, prompt, keyframes:<br/>что уже есть в попытке"]
    note["note: замечание доработки"]
  end
  subgraph images["Изображения"]
    direction LR
    frames["Первый и последний кадры<br/>принятых связанных планов<br/>до 6, JPEG 960 px;<br/>continuityFrames в контексте"]
  end
  task --> agent(("Агент описания<br/>только чтение"))
  context --> agent
  images --> agent
  agent --> answer["Описание с событиями плана,<br/>requestSeconds, опоры K01…Kn:<br/>время, промпт, референсы"]
  agent --> refusal["или отказ stage: blocked<br/>со списком противоречий"]

  class skill,guide,rules app
  class scene,cast,brief,frame,scheme,tech,current app
  class note user
  class frames app
  class agent agent
  class answer app
  class refusal bad
  classDef user fill:#FAEEDA,stroke:#BA7517,color:#412402
  classDef agent fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef app fill:#E6F1FB,stroke:#185FA5,color:#042C53
  classDef bad fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A,stroke-dasharray:4 3
```

Приложение принимает описание, только если опоры идут подряд от `K01`, первая стоит в 0, последняя на границе запроса, число опор совпадает с выбранным, длительность подходит провайдеру, а референсы взяты из `allowedPaths`. Иначе предложение получает статус «Результат требует исправления».

### Опоры у провайдера-исполнителя

```mermaid
flowchart LR
  subgraph task["Текст задания"]
    direction LR
    howto["Как пользоваться копиями,<br/>куда сохранить Kxx"]
  end
  subgraph context["Контекст JSON"]
    direction LR
    list["frames: опоры этого запуска,<br/>роль, время, промпт, референсы"]
    refs["references: подписи копий,<br/>чья это сущность или кадр какого плана"]
    approved["approvedFrames:<br/>уже утверждённые опоры"]
    previous["previousFrames:<br/>снятый кандидат при доработке"]
    notes["notes: указания и замечания к опорам"]
    layout["frame и scheme: факты кадра и схема<br/>только у плана с точкой съёмки"]
  end
  subgraph work["Рабочая папка задания"]
    direction LR
    copies["Копии только для чтения:<br/>reference-NN, approved-Kxx, previous-Kxx"]
  end
  task --> agent(("Агент изображений<br/>пишет только в рабочую папку"))
  context --> agent
  work --> agent
  agent --> files["Файлы Kxx.png, .jpg или .webp<br/>и их список в JSON<br/>с промптом генератора"]
  files --> check{"Проверка приложения"}
  check -- "ровно запрошенные опоры,<br/>настоящие изображения,<br/>копии входов не изменены" --> candidate["Кандидаты Kxx<br/>копируются в проект,<br/>промпт генератора — на опору"]
  check -- "иначе" --> rejected["Ответ отклонён"]

  class howto,list,refs,approved,previous,layout,copies app
  class notes user
  class agent agent
  class files,check,candidate app
  class rejected bad
  classDef user fill:#FAEEDA,stroke:#BA7517,color:#412402
  classDef agent fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef app fill:#E6F1FB,stroke:#185FA5,color:#042C53
  classDef bad fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A,stroke-dasharray:4 3
```

Платная опора агента не использует: промпт опоры из описания, замечания к опорам и подписи слотов утверждённых опор приложение собирает в image-запрос само. Входы — референсы описания, за ними утверждённые опоры плана.

### Видеопромпт

```mermaid
flowchart LR
  subgraph task["Текст задания"]
    direction LR
    skill["Скилл ai-clip-scene<br/>и примеры видеопромптов"]
    guide["Указания агенту<br/>провайдера видео"]
    rules["Постоянные инструкции проекта"]
  end
  subgraph context["Контекст JSON"]
    direction LR
    same["Те же scene, cast, brief, frame,<br/>settings, capabilities"]
    done["description и keyframes:<br/>принятое описание и план опор"]
    attached["attachedFrames: какие опоры<br/>и кадр стыка приложены"]
    materials["materials: пути исходников<br/>и принятых связанных планов"]
    limit["promptMaxChars: предел провайдера;<br/>manualVideo, manualGeneration"]
    hints["note: указания или замечание"]
  end
  subgraph images["Изображения"]
    direction LR
    kf["Утверждённые опоры<br/>по порядку плана, JPEG 960 px"]
    joint["Последний кадр<br/>сюжетного предшественника"]
  end
  task --> agent(("Агент видеопромпта<br/>только чтение"))
  context --> agent
  images --> agent
  agent --> answer["Промпт на языке провайдера<br/>и русский перевод"]

  class skill,guide,rules,same,done,attached,materials,limit,kf,joint app
  class hints user
  class agent agent
  class answer app
  classDef user fill:#FAEEDA,stroke:#BA7517,color:#412402
  classDef agent fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef app fill:#E6F1FB,stroke:#185FA5,color:#042C53
```

Предел длины проверяется при утверждении: промпт длиннее предела нельзя принять, только доработать.

### Проверка видео

```mermaid
flowchart LR
  subgraph task["Текст задания"]
    direction LR
    skill["Скилл проверки видео<br/>с пределами ответа"]
  end
  subgraph context["Контекст JSON"]
    direction LR
    staging["staging: постановка, направление части,<br/>визуальные правила, кастинг,<br/>описание, видеопромпт, опоры"]
    briefs["briefs: врезка на первый<br/>и последний кадр"]
    timing["durationSeconds и frames:<br/>длина ролика и время каждого кадра"]
    refs["references: R001… —<br/>утверждённые опоры"]
  end
  subgraph images["Изображения"]
    direction LR
    shots["Кадры ролика: около 0,5 с,<br/>первый и последний, не больше 32"]
    kf["Утверждённые опоры"]
  end
  task --> agent(("Агент проверки<br/>только чтение"))
  context --> agent
  images --> agent
  agent --> report["Вывод и наблюдения:<br/>соответствует, расхождение,<br/>не удалось определить;<br/>по наблюдению на каждое событие плана"]

  class skill,staging,briefs,timing,refs,shots,kf app
  class agent agent
  class report app
  classDef agent fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef app fill:#E6F1FB,stroke:#185FA5,color:#042C53
```

Отчёт с кадром, которого не было в выборке, или временем вне ролика отклоняется целиком. Проверка ничего не решает за пользователя: принять, доработать или повторить — его ответ на вопрос о результате.
