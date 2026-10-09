# Skein — операции над IR: справочник и матрица тестов

> Английский оригинал — `docs/ir_operations.md`.

Связанные: `docs/ir_semantics_ru.md` (формальная семантика — этот документ есть
операционный справочник и контракт покрытия, а не вторая формализация),
`docs/projection_ru.md`, `docs/tools_ru.md`, `docs/ir_ru.md`, `docs/walkthrough_ru.md`,
`docs/testing_ru.md`.

Статус: **Реализовано.** §1–§4 специфицируют модель и каждую операцию; §5 —
матрица покрытия (заполнена). Идентификатор **стабилен**: у пункта могут появиться
тесты, но его смысл не меняется.

---

## 0. Как читать этот документ

Каждая операция описана как:

- **Pre** — когда допустима (допустимые ходы/предусловие логоса).
- **Effects** — какие события журнала и какое изменение дерева она эмитит.
- **Derived** — какие факты меняются в результате.
- **Refuses** — причины отказа (`classify`), каталог в §3.
- **Projection** — как результат виден в следующем контексте (§ проекция).
- **ID** — стабильный идентификатор; тест ссылается на него как на токен `ID` в заголовке.

Семейства ID: `OP-CG` create_goal, `OP-AP-READ|GREP|LIST|EDIT|WRITE|RUN|FETCH|PATCH`
инструменты `apply`, `OP-AP-CONT|ALT` как `apply` ложится в дерево, `OP-ST` stop,
`OP-DC` decline, `OP-QR` query, `TR` обход/контейнеры, `DER` производные
факты/предикаты, `REF` отказы (каталог), `PRJ` проекция (ссылки).

---

## 1. Модель

### 1.1 Узлы work (`src/ir/types.ts`)

| Kind | Payload | Роль |
|---|---|---|
| `request` | `{text}` | сырая мотивация; корень; интерпретируется однажды (`has_goal`) или отклоняется (`no_goal`); заканчивается, когда его цель остановлена |
| `goal` | `{what, why?, done_when, plan?}` | интерпретация запроса или подцель; `done_when` — команда-критерий (строка); `plan` — исходный строковый набросок (I3) |
| `action` | `{command, ...}` | один запуск инструмента; также пункт плана вида `action` |
| `plan` | — | упорядоченный контейнер стадий цели (`item`-рёбра); **последний** пункт — текущий |
| `alternatives` | — | контейнер вариантов (ревизованная цель или ветвящийся шаг); `item`-рёбра, порядок = последовательность, **последний** — текущий |
| `observation` | `{ref?, version?, command?, target?, exitCode?, witness?, output/error/...}` | тело результата инструмента; запуск-критерий несёт `target`+`exitCode` |
| `stop` | `{why?}` | завершает фокусную цель: добавляется её **последним пунктом плана**, с ребром `has_stopped` от цели |
| `unactionable` | `{why?}` | намерение запроса недейственно; докса отказывается формулировать цель (ребро `no_goal`) |
| `constraint` | `{forbid: string[]}` | инвариант; сеется на старте прогона |
| `file` (artifact) | — | файл-ссылка; производится `mutates` |

### 1.2 Рёбра (`src/ir/types.ts`)

| Kind | From → To | Смысл |
|---|---|---|
| `has_goal` | request → goal | единственная интерпретация запроса (фиксирована) |
| `has_plan` | goal → plan | контейнер стадий цели |
| `item` | plan/alternatives → goal/action/stop | упорядоченное членство (порядок = последовательность; **последний** пункт — текущий) |
| `has_alternatives` | goal / пункт плана → alternatives | контейнер вариантов (ревизованная цель / ветвящийся шаг) |
| `produces` | action → observation | тело результата действия |
| `has_stopped` | goal → stop | цель завершена доксой (`stop` также есть последний пункт плана цели) |
| `no_goal` | request → unactionable | докса отказалась формулировать цель для запроса |
| `mutates` | action → file | действие изменило файл |

### 1.3 События (`src/ir/events.ts`)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`. `fold`
применяет их по порядку; состояние (`children`, `branch`, `focusOf`, версии)
**производно**, не хранится. Нет ни `record_check`, ни `set_status`: смена состояния —
это новое событие-узел (`observation`/`stop`). Результат запуска — обычный
`observation`; pass/fail читается из его `exitCode`.

### 1.4 Контейнеры и обход

- **branch** — стек целей от корня-запроса до фокуса; `descend` кладёт, `return`
  снимает (`TR-1`).
- **focus** — `branch[last]`, иначе корень (`TR-1`).
- **plan** — цель `has_plan`; **items** — рёбра `item` в порядке вставки;
  **последний** пункт — текущий.
- **alternatives** — цель `has_alternatives`; **текущий** вариант — последний
  ребёнок `item` (ребра `chosen` нет).
- **допустимые ходы** — ходы, допустимые в фокусе, вычисляются **один раз** и общие
  для проекции и `classify` (`TR-8`). Доксе отдают **руку целиком** (соседние
  варианты уровня), а **курсор** — только на текущем узле; движок не диктует
  единственный следующий ход.

---

## 2. Операции

### 2.1 `create_goal` (`OP-CG`)

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| на запросе (интерпретация) | фокус — `request` без цели | add `goal`; `has_goal` request → goal; `descend` в неё | цель `open`; интерпретация фиксирована | `empty_what`, `empty_done_when`, `empty_plan`, `empty_step`, `interpreted` | `OP-CG-1` |
| разложить открытую цель | фокус — `goal:open`, критерий не провален, есть текущий шаг-действие | add `goal`; обеспечить `alternatives` у текущего шага; `item`; `descend` | подцель — новейший вариант шага; шаг вытеснён | то же; `all plan items are fulfilled` (нужно чекать, не растить) | `OP-CG-2` |
| ревизия (`revises`) | фокус — цель, чей критерий провален | add `goal`; `item` в собственный/текущий контейнер `alternatives` провалившейся цели; `descend` | провалившиеся варианты становятся невыбранными; новая цель `open` | `missing_revision` (перечислены не все провалившиеся варианты), `unknown_revision` (`revises` в непроваленной точке) | `OP-CG-3` |
| план + первый шаг | любой из выше, есть `plan` (строка) и `step` | сохранить `plan` в цели; добавить ровно один пункт-действие (`step`) под новый контейнер `plan` | пункт-шаг `open` | `empty_plan` (пустой набросок), `empty_step` (пустая команда) | `OP-CG-4` |

- **Проекция** (`PRJ-CG`): фокусный `path` получает цель (`what`/`why`/`done_when`/
  `planHint`).
- **Замечания.** `why` — это гипотеза; она выводится на пункт, чтобы провалившуюся
  попытку не повторяли (`PRJ-PATH-why`). `what`, совпавший (нормализованно) с
  провалившимся вариантом, — `repeat_hypothesis`. Чтобы разложить открытую цель, нужен
  текущий шаг-действие; если его нет, движок пишет fail-наблюдение
  (`create goal failed: no current step to decompose`).

### 2.2 `apply` (`OP-AP`)

Диспетчер одного инструмента под фокусом (`src/tools/index.ts`, `OP-AP-*`).

**Как `apply` ложится в план** — различение *continue* / *alternative*
(`docs/ir_semantics_ru.md` §2.6): переиспользовать неисполненный пункт-действие с той
же командой (`OP-AP-CONT-1`); иначе приделать новое действие новейшим вариантом
текущего невыполненного пункта (`OP-AP-ALT-1`); иначе создать действие и добавить его
новым `item` плана (`OP-AP-CONT-2`). В само действие движок **не** переходит. На
закрытом запросе (`requestSettled`) любой `apply` отклоняется с `addressed`
(принимается только `stop`).

#### 2.2.1 `read` (`OP-AP-READ`)

| Случай | Pre | Effects | ID |
|---|---|---|---|
| новое окно | файл существует; мир не менялся с прошлого идентичного чтения | add `action`; add `observation` (`produces`); записать observed-версию | `OP-AP-READ-1` |
| продолжение окна | другой `start/end` | новые action/observation | `OP-AP-READ-2` |
| нет файла | — | action + fail-observation | `OP-AP-READ-3` |
| повтор | идентичное окно, мир не менялся | отказ `repeated_action` | `OP-AP-READ-4` |
| путь вне воркспейса | — | action + fail-observation (записанный отказ, без падения) | `OP-AP-READ-5` |
| трэш чтения | неизменённый файл уже читался дважды (правки не было) | отказ `repeated_action` (указывает на правку) | `OP-AP-READ-6` |

#### 2.2.2 `grep` (`OP-AP-GREP`)

| Случай | Pre | Effects | ID |
|---|---|---|---|
| поиск по scope | `path`/`include`/`exclude` корректны | action + observation (JSON-окна) | `OP-AP-GREP-1` |
| пагинация | `from`/`count` | новые action/observation; повтор того же паттерна с новым `from` — новый | `OP-AP-GREP-2` |
| нет попаданий / плохой scope | — | пустой результат / fail-observation | `OP-AP-GREP-3` |
| повтор | идентичный scope+паттерн, мир не менялся | отказ `repeated_action` | `OP-AP-GREP-4` |

#### 2.2.3 `list` (`OP-AP-LIST`)

| Случай | Pre | Effects | ID |
|---|---|---|---|
| список scope | — | action + observation (пути как JSON) | `OP-AP-LIST-1` |
| пагинация / пусто | `from`/`limit` | новые action/observation | `OP-AP-LIST-2` |

#### 2.2.4 `edit` (`OP-AP-EDIT`)

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| замена | файл прочитан и не менялся с того чтения; путь не запрещён | add `action` (`find`/`replace`); `mutate` на каждый изменённый файл | версия файла меняется; зависимые факты устаревают | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-EDIT-1` |
| `find` не найден | — | action + fail-observation (файл материализуется, пиннится) | — | — | `OP-AP-EDIT-2` |
| запрещённый путь | constraint запрещает | — | — | `constraint_violation:<pattern>` | `OP-AP-EDIT-3` |
| устаревшая база | файл изменён после последнего чтения | — | — | `stale_base` | `OP-AP-EDIT-4` |
| путь вне воркспейса | — | fail-observation (записанный отказ, без падения) | — | — | `OP-AP-EDIT-5` |

#### 2.2.5 `run` (`OP-AP-RUN`)

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| exploratory-команда | есть `command`, нет `target` | action + `observation`; `mutate` на каждый изменённый файл | версии; старые чтения устаревают | `repeated_action` | `OP-AP-RUN-1` |
| запуск-критерий (`{target}`) | target — фокусная цель | action + `observation`, несущий `target`+`exitCode`+`witness`; команда берётся из `target.done_when` | `criterionPass` (`exitCode 0`) / `criterionFailed` (ненулевой) | `invalid_target`, `not_current_goal`, несовпадение команды, `repeated_action` | `OP-AP-RUN-2` |
| неразрешающий (таймаут) | запуск-критерий | observation **без** `exitCode` | вердикта нет: цель остаётся `open` | повторная проверка разрешена (не repeat) | `OP-AP-RUN-4` |
| background-старт | `background: true` + `command` | action; job запущен; ход сразу возвращает `job-N` | — | `background_run` (нет команды), `background_target` (критерий) | `OP-AP-RUN-5` |
| опрос (`{job}`) | id задачи | action; несёт состояние/код/хвост | — | `job_poll` (лишние поля) | `OP-AP-RUN-6` |
| критерий только своей цели | запуск-критерий по цели | `target` наблюдения — только эта цель, без влияния на предков (A1 снят) | `criterionPass`/`criterionFailed` для этой цели; запрос может стать закрытым | — | `OP-AP-RUN-7` |

- **Проекция** (`PRJ-AP`): узел результата — `lastResult`; stdout (`output`) и
  stderr (`error`) раздельны; краш добавляет `signal`/`core`/`backtrace`; `exitCode`
  запуска-критерия — на observation; запись в `calls` несёт `id` для последующего
  `query`.

#### 2.2.6 `write` (`OP-AP-WRITE`)

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| создание | `path` не существует | add `action` (`path`/`content`); `mutate`; версия файла установлена | — | — | `OP-AP-WRITE-1` |
| перезапись | файл прочитан и с тех пор не изменён; не запрещён | add `action`; `mutate`; версия растёт | зависимые факты устаревают | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-WRITE-2` |
| запрещённый путь | constraint запрещает | — | — | `constraint_violation:<pattern>` | `OP-AP-WRITE-3` |
| устаревшая база | файл изменён после последнего чтения | — | — | `stale_base` | `OP-AP-WRITE-4` |
| непрочитанный файл | файл существует, но не читался | — | — | fail-наблюдение (`read it first`) | `OP-AP-WRITE-5` |
| путь вне воркспейса | — | fail-observation (записанный отказ, без падения) | — | — | `OP-AP-WRITE-6` |

- **Проекция** (`PRJ-AP`): как у `edit` — `executed` узел `action` с ребром `mutates`
  и событием `mutate` с новой версией.

#### 2.2.7 `fetch` (`OP-AP-FETCH`)

Достаёт внешние референсные доказательства (апстрим/опубликованная версия/соседняя
копия) в воркспейс, чтобы их можно было прочитать и продиффить (B9,
`docs/system_prompt_ru.md`).

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| fetch | URL достижим; цели нет; не запрещён | action; файл записан; `mutate` + `mutates`; observation (`url`/`path`/`bytes`) | версия файла установлена; старые чтения устаревают | — | `OP-AP-FETCH-1` |
| сбой загрузки | не-2xx / таймаут | fail-observation | — | — (fail) | `OP-AP-FETCH-2` |
| цель существует / путь вне воркспейса | — | fail-observation (`choose another path` / записанный отказ) | — | — | `OP-AP-FETCH-3` |
| запрещённый явный путь | constraint запрещает | — | — | `constraint_violation:<pattern>` | `REF-FETCH-CONSTRAINT` |

Дефолтная цель — собственность движка (`refPathFor`, `.skein/ref/<hash>-<slug>`), поэтому
constraint проверяется только для явного `path`.

#### 2.2.8 `apply_patch` (`OP-AP-PATCH`)

Применяет unified diff в корне воркспейса (`patch -p<strip>`, по умолчанию 1), например
апстрим-правку, полученную через `fetch`.

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| применение | патч применяется чисто | action; `mutate` на каждый изменённый файл (`patch -p<strip>`) | изменённые версии; старые чтения устаревают | — | `OP-AP-PATCH-1` |
| не применяется | конфликт/уже применено | fail-observation | — | — (fail) | `OP-AP-PATCH-2` |
| запрещённая цель | constraint запрещает путь из `---`/`+++` | — | — | `constraint_violation:<pattern>` | `REF-PATCH-CONSTRAINT` |

### 2.3 `decline` (`OP-DC`)

Докса предлагает, что намерение запроса **недейственно** (болтовня, нет задачи), и
отказывается формулировать цель — вместо того чтобы выдумывать цель с фиктивным
критерием. Доступно, только пока у запроса нет интерпретации; оно пишет узел
`unactionable` под запросом (ребро `no_goal`) и заканчивает прогон
(`docs/plans/archive/request_goal_plan_ru.md`).

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| отклонить запрос | фокус — запрос без интерпретации и без узла `unactionable` | add узел `unactionable` и ребро `no_goal` от запроса; прогон заканчивается | запрос терминален (`request_unactionable`) | — | `OP-DC-1` |
| не на запросе | фокус — цель | — | — | `not_request` | `REF-DC-NOTREQ` |
| уже интерпретирован | у запроса уже есть интерпретация | — | — | `interpreted` | `REF-DC-ADDR` |

- **Проекция** (`PRJ-DC`): вариант `decline` предлагается на свежем запросе рядом с
  `create_goal`.

### 2.4 `stop` (`OP-ST`)

Терминальный ход доксы и **единственное закрытие**. На **цели** он завершает рамку
(движок на следующей проекции возвращается к родителю и продолжает). Ни один критерий
он не разрешает: проход — по-прежнему `exitCode` наблюдения-критерия, читаемый
вратами.

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| завершить цель | фокус — цель, чей критерий прошёл | add узел `stop` **последним пунктом плана** и ребро `has_stopped` от цели | цель `stopped`; движок возвращается; запрос заканчивается, когда его цель остановлена | — | `OP-ST-2` |
| критерий не прошёл | фокус — цель, чей критерий не прошёл | — | — | `check_not_run` | `REF-ST-CHECK` |
| не на цели | фокус — запрос | — | — | `not_addressed` | `REF-ST-STATE` |

- **Проекция** (`PRJ-STOP`): завершённая цель показывает состояние `stopped`; узел
  `stop` — последний пункт плана цели.
- Цель закрывается только `stop`; пока принимаются только **положительные** `stop`
  (критерий должен был пройти; сдача — более поздний шаг —
  `docs/plans/archive/request_goal_plan_ru.md`). Узел `stop` добавляется **последним пунктом
  плана** цели и связывается ребром `has_stopped` от цели; прогон заканчивается, когда
  цель запроса остановлена. На запросе `stop` нет.

### 2.5 `query` (`OP-QR`)

| Случай | Pre | Effects | ID |
|---|---|---|---|
| по id, тело | id адресует результат (observation или inline/`Ref`-тело) | узла нет; тело возвращено; id пиннится в `shown` (TTL) | `OP-QR-1` |
| по id, без тела | id — action/goal/т.п. | строка узла + инцидентные рёбра | `OP-QR-2` |
| по id, окно | `start`/`end` | окно строк; продолжение — новым `query` | `OP-QR-3` |
| state: `kind` | — | подходящие узлы (ограничено) | `OP-QR-4` |
| state: `edgesOf` | — | инцидентные рёбра узла | `OP-QR-5` |
| избыточный | id уже в `shown` | отказ `repeated_action` | `OP-QR-6` |

- **Проекция** (`PRJ-QR`): запрошенное тело входит в `shown` полностью на несколько
  ходов и снимается с явного удержания по истечении TTL; state-запросы не пиннятся.

### 2.6 Обход и контейнеры (`TR`)

| Случай | Правило | ID |
|---|---|---|
| фокус | фокус — `branch[last]`, иначе корень | `TR-1` |
| descend | `focusEvents` спускается в цель запроса (`has_goal`) или в последний вариант `alternatives` шага | `TR-2` |
| return | завершённая верхушка снимается; `return` легален | `TR-3` |
| обрезка под завершённым предком | если любой предок (кроме корня) завершён, ветка обрезается — не только когда завершается верхушка (инвариант 17 расширен) | `TR-4` |
| выбор контейнера | контейнер стадий цели — `plan` (`has_plan`); интерпретация запроса — ребро `has_goal`; ревизованная цель / ветвящийся шаг использует `alternatives` (`has_alternatives`) | `TR-5` |
| порядок items и курсор | items идут в порядке рёбер `item` (**последний** — текущий); курсор — первый не `itemFulfilled`; пункт выполнен, когда его действие исполнилось или его новейший вариант готов | `TR-6` |
| ветвление варианта | неисполненный пункт-действие с той же командой переиспользуется; иначе новое действие становится новейшим вариантом `alternatives` текущего невыполненного пункта-действия; более ранние варианты становятся невыбранными | `TR-7` |
| допустимые ходы | `applicable` вычисляет create_goal/apply/stop/decline/checkReady из тех же фактов, что и врата; докса выбирает среди них | `TR-8` |
| история ревизий пункта | `alternatives` пункта плана (история ревизий шага) рендерятся в проекции | `TR-9` |

### 2.7 Производные факты (`DER`)

Состояние всегда производно из инцидентных событий, не хранится.

| Предикат | Правило | ID |
|---|---|---|
| request `requestSettled` | цель запроса (через её текущий вариант) прошла свой критерий (`criterionPass`) | `DER-REQ-1` |
| критерий цели прошёл | у новейшего наблюдения, нацеленного на цель, `exitCode 0` | `DER-GOAL-1` |
| критерий цели провален | у новейшего наблюдения, нацеленного на цель, ненулевой `exitCode` | `DER-GOAL-3` |
| у цели нет вердикта / `open` | нет нацеленного наблюдения, или его `exitCode` отсутствует (таймаут) | `DER-GOAL-4` |
| цель невыбрана | это вариант контейнера, и он не **последний** | `DER-GOAL-5` |
| порядок критериев | побеждает новейшее нацеленное наблюдение (по `seq`) | `DER-GOAL-6` |
| action `executed` | у него есть ребро `produces` или `mutates` | `DER-ACT-1` |
| action вытеснен | в его контейнере `alternatives` есть новейший (последний) вариант | `DER-ACT-2` |
| witness запуска | наблюдение запуска-критерия несёт `witness` (основа для устаревания) | `DER-STALE-1` |

---

## 3. Каталог отказов (`REF`)

Гейт `classify` (`src/loop/classify.ts`). Отказ эмитит `record_rejection` и
**обязан менять проекцию** (инвариант).

| Причина (токен) | Триггер | Оператор | ID |
|---|---|---|---|
| `empty_what` / `empty_done_when` / `empty_plan` / `empty_step` | некорректный `create_goal` | `create_goal` | `REF-CG-EMPTY` |
| `no_current_goal` | нет фокуса | create_goal | `REF-NO-FOCUS` |
| `missing_revision` | `revises` не перечисляет провалившийся вариант | create_goal | `REF-REV-MISSING` |
| `unknown_revision` | `revises` в непроваленной точке | create_goal | `REF-REV-UNKNOWN` |
| `repeat_hypothesis` | `what` повторяет провалившийся вариант | create_goal | `REF-REPEAT-HYP` |
| `all plan items are fulfilled` | рост цели с выполненным планом | create_goal | `REF-PLAN-DONE` |
| `not_current_goal` | критерий целится не в фокус | run | `REF-NOT-FOCUS` |
| `invalid_target` | запуск-критерий не-цели | run | `REF-RUN-TARGET` |
| несовпадение команды | критерий передаёт другую команду | run | `REF-RUN-CMD` |
| `job_poll` | опрос с лишними полями | run | `REF-RUN-POLL` |
| `background_target` | background запуска-критерия | run | `REF-RUN-BGCHECK` |
| `background_run` | background без команды | run | `REF-RUN-BGCMD` |
| run без команды/target | пустой `run` | run | `REF-RUN-EMPTY` |
| `repeated_action` | идентичный read/grep/run или re-query показанного тела | read/grep/run/query | `REF-REPEAT` |
| `stale_base` | edit файла, изменённого после чтения | edit | `REF-EDIT-STALE` |
| `constraint_violation:<pattern>` | edit запрещённого пути | edit | `REF-EDIT-CONSTRAINT` |
| `stale_base` | write поверх файла, изменённого после чтения | write | `REF-WRITE-STALE` |
| `constraint_violation:<pattern>` | write запрещённого пути | write | `REF-WRITE-CONSTRAINT` |
| `not_addressed` | `stop`, когда фокус — не цель (запрос) | stop | `REF-ST-STATE` |
| `check_not_run` | `stop` на цели, чей критерий не прошёл | stop | `REF-ST-CHECK` |
| `addressed` | любой оператор кроме `stop` на закрытом запросе | create_goal/apply | `REF-ADDRESSED` |
| `not_request` | `decline` не в фокусе-запросе | decline | `REF-DC-NOTREQ` |
| `interpreted` | второй `create_goal` на запросе, у которого уже есть цель, или `decline` на нём | create_goal/decline | `REF-DC-ADDR` |

**Провалы** инструментов (это fail-observation, не отказ): нет файла (`read`),
плохой scope (`grep`/`list`), `find` не найден (`edit`), ненулевой код/таймаут/
сигнал (`run`).

---

## 4. Инварианты

- цель закрывается только `stop` (ребро `has_stopped`, и узел `stop` — последний пункт
  плана цели); запуск-критерий сам по себе ничего не разрешает (`DER-GOAL`).
- запрос заканчивается, когда его цель остановлена (на запросе `stop` нет); запрос
  интерпретируется однажды (`has_goal`) или отклоняется (`no_goal`).
- запуск-критерий — обычный `observation`; `exitCode 0` = проход, ненулевой = провал,
  отсутствует = нет вердикта.
- `stale`-факт никогда не показывается как активный; устаревший факт не активен.
- `project` детерминирован: те же события → тот же `Context`.
- структурные рёбра (`has_goal`/`has_plan`/`item`/`has_alternatives`/`has_stopped`/`no_goal`)
  образуют DAG (узел `stop` — одновременно последний пункт плана и цель `has_stopped`
  у цели, поэтому структура — не дерево).
- каждая не-корневая цель привязана ребром `has_goal` или `item`.
- отказ/провал меняет проекцию.
- завершённая цель (и её потомки) не остаётся фокусом (`TR-4`).
- секреты только в `.env`; маленькие результаты можно inline, секреты — нет.

Первые четыре уже реализованы хелперами: `tests/invariants.ts`.

---

## 5. Матрица покрытия

У каждого ID есть минимум один офлайн-тест; у семей операторов есть и онлайн-проверка.
Случайные деревья (`tests/ops/ir_properties.test.ts`) подпирают инварианты на 400
деревьях. Live step-тесты (`tests/live/ir_operations_step.test.ts`, запуск вручную:
`SKEIN_LIVE=true npx vitest run ...`) строят проекцию офлайн и проверяют форму
следующего хода живой модели (каждый шаг повторяется `SKEIN_STEP_REPEATS=3`).

| Spec ID | Офлайн-тест | Live |
|---|---|---|
| `OP-CG-1..4` | `tests/ops/create_goal.test.ts` | step `interpret-request`; сценарий `multi-step-plan` |
| `OP-AP-READ-1..6` | `tests/ops/apply.test.ts` | сценарий `locate-across-files` |
| `OP-AP-GREP-1..4` | `tests/ops/apply.test.ts` | сценарий `locate-across-files` |
| `OP-AP-LIST-1..2` | `tests/ops/apply.test.ts` | сценарий `locate-across-files` |
| `OP-AP-EDIT-1..5` | `tests/ops/apply.test.ts` | сценарии `stale-base`, `two-step-fix` |
| `OP-AP-WRITE-1..6` | `tests/ops/apply.test.ts` | сценарий `command-from-package` |
| `OP-AP-RUN-1`, `2`, `4..7` | `tests/ops/apply.test.ts` | steps `apply-next-action`, `check-ready-objective`, `poll-background-job`, `retry-inconclusive` |
| `OP-AP-FETCH-1..3`, `REF-FETCH-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-AP-PATCH-1..2`, `REF-PATCH-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-QR-1..6` | `tests/ops/query.test.ts` | сценарии `retrieve-at-scale`, `reproduce-then-read` |
| `TR-1..9` | `tests/ops/traversal.test.ts` | steps `apply-next-action`, `follow-focus-hint` |
| `DER-REQ/GOAL/ACT/STALE` | `tests/ops/derivation.test.ts` | — |
| `REF-CG/REV/NO-FOCUS` | `tests/ops/create_goal.test.ts` | step `follow-focus-hint`; сценарий `revise-hypothesis` |
| `REF-RUN/REPEAT` | `tests/ops/apply.test.ts`, `tests/ops/query.test.ts` | step `poll-background-job`; сценарий `two-outputs` |
| `REF-EDIT` | `tests/ops/apply.test.ts` | сценарий `constraint-honored` |
| `REF-WRITE-STALE`, `REF-WRITE-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-ST-2`, `REF-ST-STATE`, `REF-ST-CHECK` | `tests/ops/stop.test.ts` | step `stop-addressed` |
| `OP-DC-1`, `REF-DC-NOTREQ`, `REF-DC-ADDR` | `tests/ops/decline.test.ts` | — |
| `OP-AP-CONT/ALT` | `tests/ops/apply.test.ts`, `tests/ops/create_goal.test.ts` | steps `apply-next-action` |
| `TR-8` | `tests/ops/applicable.test.ts` | steps `check-ready-objective`, `stop-addressed` |
| `TR-9` | `tests/ops/traversal.test.ts` | — |

**Coverage-gate** (`tests/coverage.test.ts`): каждый ID реестра обязан встретиться
токеном минимум в одном тесте, и ни один тест не может ссылаться на ID вне реестра
— документ и тесты не могут разойтись.

---

## 6. Расширение

1. Добавить пункт сюда с новым стабильным ID и Pre/Effects/Derived/Refuses (и, если
   новый, токен отказа в §3).
2. Добавить офлайн-тест, цитирующий ID в заголовке.
3. Добавить live-сценарий только если семье операторов нужна сквозная проверка.
4. Coverage-gate падает, пока в матрице нет теста.
