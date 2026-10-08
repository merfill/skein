# Skein — операции над IR: справочник и матрица тестов

> Английский оригинал — `docs/ir_operations.md`.

Связанные: `docs/ir_semantics_ru.md` (формальная семантика — этот документ есть
операционный справочник и контракт покрытия, а не вторая формализация),
`docs/projection_ru.md`, `docs/tools_ru.md`, `docs/ir_ru.md`, `docs/testing_ru.md`.

Статус: **Реализовано.** §1–§4 специфицируют модель и каждую операцию; §5 —
матрица покрытия (заполнена). Идентификатор **стабилен**: у пункта могут появиться
тесты, но его смысл не меняется.

---

## 0. Как читать

Каждая операция описана как:

- **Pre** — когда допустима (фронтир/предусловие логоса).
- **Effects** — какие события журнала и какое изменение дерева она эмитит.
- **Derived** — какие предикаты меняются в результате.
- **Refuses** — причины отказа (`classify`), каталог в §3.
- **Projection** — как результат виден в следующем контексте.
- **ID** — стабильный идентификатор; тест ссылается на него как на токен `ID` в заголовке.

Семейства ID: `OP-CG` create_goal, `OP-AP-READ|GREP|LIST|EDIT|WRITE|RUN|FETCH|PATCH`
инструменты `apply`, `OP-AP-CONT|ALT` как `apply` ложится в дерево, `OP-ST` stop,
`OP-QR` query, `TR` обход/контейнеры, `DER`
производные предикаты, `REF` отказы (каталог), `PRJ` проекция (ссылки).

---

## 1. Модель

### 1.1 Узлы work (`src/ir/types.ts`)

| Kind | Payload | Роль |
|---|---|---|
| `request` | `{text}` | сырая мотивация арбитра; корень; не закрывается в IR |
| `goal` | `{what, why?, done_when, plan?}` | интерпретация или стадия; `done_when` объективный/арбитр; `plan` — исходный набросок-строка (I3) |
| `action` | `{command, ...}` | один запуск инструмента; также item плана вида `action` |
| `plan` | — | упорядоченный контейнер стадий цели (`item`-рёбра) |
| `alternatives` | — | контейнер взаимозаменяемых целей/действий (`item` + `chosen`) |
| `observation` | `{ref?, version?, command?, verdict?, output?...}` | тело результата инструмента |
| `check` | `{command, verdict, witness?, actor, output/error/...}` | вердикт арбитра по цели |
| `stop` | `{why?}` | терминальное предложение доксы, что запрос выполнен; принимается только если запрос `addressed` |
| `constraint` | `{forbid: string[]}` | инвариант; сеется на старте прогона |
| `file` (artifact) | — | файл-ссылка; производится `mutates` |

### 1.2 Рёбра (`src/ir/types.ts`)

| Kind | From → To | Смысл |
|---|---|---|
| `has_plan` | goal → plan | контейнер стадий цели |
| `item` | plan/alternatives → goal/action | упорядоченное членство |
| `has_alternatives` | request/goal → alternatives | контейнер вариантов |
| `chosen` | alternatives → option | текущий выбранный вариант |
| `under` | check → goal | допущения, на которых стоит закрытие |
| `produces` | action → observation | тело результата действия |
| `verifies` | check → goal | цель(и), которые вердикт «решает» |
| `mutates` | action → file | действие изменило файл |

### 1.3 События (`src/ir/events.ts`)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`,
`record_check`. `fold` применяет их по порядку; состояние (предикаты, `children`,
`branch`, `focusOf`, версии) **производно**, не хранится.

### 1.4 Контейнеры и обход

- **branch** — стек целей от корня-запроса до фокуса; `descend` кладёт, `return`
  снимает (`TR-1`).
- **focus** — `branch[last]`, иначе корень (`TR-1`).
- **plan** — цель `has_plan`; **items** — рёбра `item` в порядке вставки.
- **alternatives** — цель `has_alternatives`; **chosen** — цель новейшего ребра
  `chosen` (порядок журнала).
- **фронтьер** — допустимые ходы в фокусе, вычисляется **один раз** и общий для
  проекции и `classify` (`TR-8`). Доксе отдают **руку целиком** (сиблинги уровня), а
  **курсор** — только на текущем узле; движок не диктует единственный следующий ход.

---

## 2. Операции

### 2.1 `create_goal` (`OP-CG`)

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| на запросе (интерпретация) | фокус `request:open` | add `goal`; обеспечить `alternatives` у запроса; `item` + `chosen` к цели; `descend` в неё | запрос остаётся `open`; цель `open` | `empty_what`, `empty_done_when`, `empty_plan`, `empty_step`, `repeat_hypothesis`, `addressed` | `OP-CG-1` |
| разложить открытую цель | фокус `goal:open`, не refuted, есть текущий шаг-действие | add `goal`; обеспечить `alternatives` у текущего шага; `item` + `chosen`; `descend` | подцель — выбранный вариант шага; шаг вытеснён | то же; `all plan items are fulfilled` (нужно чекать, не растить) | `OP-CG-2` |
| ревизия (`revises`) | фокус `request` с провалившимися вариантами, или `refuted` цель | add `goal`; `item` + `chosen` в контейнер провалившихся; `descend` | провалившиеся → `abandoned`; новая `open` | `missing_revision` (перечислены не все), `unknown_revision` (`revises` в не-refuted точке) | `OP-CG-3` |
| план + первый шаг | любой из выше, есть `plan` (строка) и `step` | сохранить `plan` в цели; добавить ровно один item-действие (`step`) под новый контейнер `plan` | item-шаг `open` | `empty_plan` (пустой набросок), `empty_step` (пустая команда) | `OP-CG-4` |

- **Проекция** (`PRJ-CG`): фокусный `path` получает цель (`what`/`why`/`done_when`/
  `plan`); на запросе список `alternatives` показывает её `chosen`.
- **Замечания.** `why` — это гипотеза; она выводится на item, чтобы провалившуюся
  попытку не повторяли (`PRJ-PATH-why`). `what`, совпавший (нормализованно) с
  провалившимся вариантом, — `repeat_hypothesis`. Чтобы разложить открытую цель, нужен
  текущий шаг-действие; если его нет, движок пишет fail-наблюдение
  (`create goal failed: no current step to decompose`).

### 2.2 `apply` (`OP-AP`)

Диспетчер одного инструмента под фокусом (`src/tools/index.ts`, `OP-AP-*`).

**Как `apply` ложится в план** — различение *continue* / *alternative*
(`docs/ir_semantics_ru.md` §2.6): переиспользовать невыполненный action-item с той же
командой (`OP-AP-CONT-1`); иначе приделать новое действие `chosen`-альтернативой первого
невыполненного item (`OP-AP-ALT-1`); иначе создать действие и добавить его новым
`item` плана (`OP-AP-CONT-2`). В само действие движок **не** переходит. На уже
`addressed` запросе любой `apply` отклоняется с `addressed` (принимается только
`stop`).

#### 2.2.1 `read` (`OP-AP-READ`)

| Случай | Pre | Effects | ID |
|---|---|---|---|
| новое окно | файл существует; мир не менялся с прошлого идентичного чтения | add `action`; add `observation` (`produces`); записать observed-версию | `OP-AP-READ-1` |
| продолжение окна | другой `start/end` | новые action/observation | `OP-AP-READ-2` |
| нет файла | — | action + fail-observation | `OP-AP-READ-3` |
| повтор | идентичное окно, мир не менялся | отказ `repeated_action` | `OP-AP-READ-4` |
| путь вне воркспейса | — | action + fail-observation (записанный отказ, без падения) | `OP-AP-READ-5` |

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
| замена | файл прочитан и не менялся с того чтения; путь не запрещён | add `action` (`find`/`replace`); `mutate` на каждый изменённый файл | версия файла меняется; зависимые проверки устаревают | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-EDIT-1` |
| `find` не найден | — | action + fail-observation (файл материализуется, пиннится) | — | — | `OP-AP-EDIT-2` |
| запрещённый путь | constraint запрещает | — | — | `constraint_violation:<pattern>` | `OP-AP-EDIT-3` |
| устаревшая база | файл изменён после последнего чтения | — | — | `stale_base` | `OP-AP-EDIT-4` |
| путь вне воркспейса | — | fail-observation (записанный отказ, без падения) | — | — | `OP-AP-EDIT-5` |

#### 2.2.5 `run` (`OP-AP-RUN`)

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| exploratory-команда | есть `command`, нет `target` | action + observation; `mutate` на каждый изменённый файл | версии; проверки устаревают | `repeated_action` | `OP-AP-RUN-1` |
| check (`{target}`) | target — фокус, объективная | узел `record_check` + ребро `verifies` | цель `achieved`/`refuted`/`open` | `invalid_target`, `arbiter_goal_needs_acceptance`, несовпадение команды, `not_current_goal`, `repeated_action` | `OP-AP-RUN-2` |
| check с `under` | как выше + допущения | рёбра `under` на check | при pass — `achieved_under` | — | `OP-AP-RUN-3` |
| inconclusive (таймаут) | check | `record_check` вердикт `inconclusive` | цель остаётся `open` | повторный check разрешён (не repeat) | `OP-AP-RUN-4` |
| background-старт | `background: true` + `command` | action; job запущен; ход сразу возвращает `job-N` | — | `background_run` (нет команды), `background_target` (check) | `OP-AP-RUN-5` |
| опрос (`{job}`) | id задачи | action; несёт состояние/код/хвост | — | `job_poll` (лишние поля) | `OP-AP-RUN-6` |
| закрывается своим чеком | чек objective-цели | чек `verifies` только эту цель — замыкания предков нет (A1 снят) | цель `achieved`/`refuted`/`open`; request может стать `addressed` | — | `OP-AP-RUN-7` |

- **Проекция** (`PRJ-AP`): узел результата — `lastResult`; stdout (`output`) и
  stderr (`error`) раздельны; краш добавляет `signal`/`core`/`backtrace`; вердикт
  check — на узле `check`; запись в `calls` несёт `id` для последующего `query`.

#### 2.2.6 `write` (`OP-AP-WRITE`)

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| создание | `path` не существует | add `action` (`path`/`content`); `mutate`; версия файла установлена | — | — | `OP-AP-WRITE-1` |
| перезапись | файл прочитан и с тех пор не изменён; не запрещён | add `action`; `mutate`; версия растёт | зависимые check устаревают | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-WRITE-2` |
| запрещённый путь | constraint запрещает | — | — | `constraint_violation:<pattern>` | `OP-AP-WRITE-3` |
| устаревшая база | файл изменён после последнего чтения | — | — | `stale_base` | `OP-AP-WRITE-4` |
| непрочитанный файл | файл существует, но не читался | — | — | fail-наблюдение (`read it first`) | `OP-AP-WRITE-5` |
| путь вне воркспейса | — | fail-observation (записанный отказ, без падения) | — | — | `OP-AP-WRITE-6` |

- **Проекция** (`PRJ-AP`): как у `edit` — `executed` узел `action` с ребром `mutates`
  и событием `mutate` с новой версией.

#### 2.2.7 `fetch` (`OP-AP-FETCH`)

Достаёт внешний референс (апстрим/опубликованная версия/соседняя копия) в воркспейс,
чтобы его можно было прочитать и продиффить (B9, `docs/system_prompt_ru.md`).

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| fetch | URL достижим; цели нет; не запрещён | action; файл записан; `mutate` + `mutates`; observation (`url`/`path`/`bytes`) | версия файла; зависимые check устаревают | — | `OP-AP-FETCH-1` |
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
| применение | патч применяется чисто | action; `mutate` на каждый изменённый файл (`patch -p<strip>`) | версии; зависимые check устаревают | — | `OP-AP-PATCH-1` |
| не применяется | конфликт/уже применено | fail-observation | — | — (fail) | `OP-AP-PATCH-2` |
| запрещённая цель | constraint запрещает путь из `---`/`+++` | — | — | `constraint_violation:<pattern>` | `REF-PATCH-CONSTRAINT` |

### 2.3 `stop` (`OP-ST`)

Терминальный ход доксы: предлагает, что запрос выполнен.

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| stop | фокус — корневой запрос, и он `addressed` | add узел `stop` (payload `{why?}`) | не меняется — `addressed` остаётся производным от выбранной интерпретации | `not_addressed` | `OP-ST-1` |

- **Проекция** (`PRJ-STOP`): узел `stop` — терминальный; прогон останавливается
  (`request_addressed`). Запрос никогда не проверяется; приёмка остаётся внешней.
- `stop` на запросе, который не `addressed`, отклоняется, поэтому докса не может закрыть
  запрос сама.

### 2.4 `query` (`OP-QR`)

| Случай | Pre | Effects | ID |
|---|---|---|---|
| по id, тело | id адресует результат (observation/check или inline/`Ref`-тело) | узла нет; тело возвращено; id пиннится в `shown` (TTL) | `OP-QR-1` |
| по id, без тела | id — action/goal/и т.п. | строка узла + инцидентные рёбра | `OP-QR-2` |
| по id, окно | `start`/`end` | окно строк; продолжение — новым `query` | `OP-QR-3` |
| state: `kind`/`predicate` | — | подходящие узлы (ограничено) | `OP-QR-4` |
| state: `edgesOf` | — | инцидентные рёбра узла | `OP-QR-5` |
| избыточный | id уже в `shown` | отказ `repeated_action` | `OP-QR-6` |

- **Проекция** (`PRJ-QR`): запрошенное тело входит в `shown` полностью на несколько
  ходов и снимается с явного удержания по истечении TTL; state-запросы не пиннятся.

### 2.5 Обход и контейнеры (`TR`)

| Случай | Правило | ID |
|---|---|---|
| фокус | фокус — `branch[last]`, иначе корень | `TR-1` |
| descend | `focusEvents` спускается в выбранную интерпретацию на запросе или в первый невыполненный подgoal | `TR-2` |
| return | закрытая верхушка снимается; `return` легален | `TR-3` |
| обрезка под закрытым предком | если любой предок (кроме корня) закрыт, ветка обрезается — не только когда закрыта верхушка (инвариант 17 расширен) | `TR-4` |
| выбор контейнера | контейнер стадий цели — `plan` (`has_plan`); контейнер вариантов запроса или `refuted`-цели — `alternatives` (`has_alternatives`) | `TR-5` |
| порядок items и курсор | items идут в порядке рёбер `item`; курсор — первый не `itemFulfilled`; `itemFulfilled` (разрешён, вкл. refuted) и `itemSucceeded` (только успех) различаются | `TR-6` |
| ветвление варианта | неисполненный action-item с той же командой переиспользуется; иначе новое действие становится `chosen`-вариантом в `alternatives` первого невыполненного action-item; невыбранные варианты → `abandoned` | `TR-7` |
| история ревизий пункта | `alternatives` пункта плана (история ревизий шага) рендерятся в проекции | `TR-9` |

### 2.6 Производные предикаты (`DER`)

Состояние всегда производно из инцидентных событий, не хранится.

| Предикат | Правило | ID |
|---|---|---|
| request `addressed` | выбранная интерпретация `achieved`/`achieved_under`; иначе `open` | `DER-REQ-1` |
| goal `achieved` | у новейшей закрывающей проверки `verdict=pass` и нет `under` | `DER-GOAL-1` |
| goal `achieved_under` | у новейшей закрывающей проверки `verdict=pass` с `under` | `DER-GOAL-2` |
| goal `refuted` | у новейшей закрывающей проверки `verdict=fail` | `DER-GOAL-3` |
| goal `open` | новейшая закрывающая проверка `inconclusive`, или закрытия нет | `DER-GOAL-4` |
| goal `abandoned` | это невыбранный вариант контейнера с `chosen`-сиблингом | `DER-GOAL-5` |
| порядок закрытий | побеждает новейшая `verifies`-проверка (по `seq`) | `DER-GOAL-6` |
| action `executed` | есть ребро `produces` или `mutates` | `DER-ACT-1` |
| action `abandoned` | его контейнер `alternatives` выбрал сиблинга | `DER-ACT-2` |
| check stale | версия ref из `witness` отличается от текущей | `DER-STALE-1` |

---

## 3. Каталог отказов (`REF`)

Гейт `classify` (`src/loop/classify.ts`). Отказ эмитит `record_rejection` и
**обязан менять проекцию** (инвариант).

| Причина (токен) | Триггер | Оператор | ID |
|---|---|---|---|
| `empty_what` / `empty_done_when` / `empty_plan` / `empty_step` | некорректный `create_goal` | create_goal | `REF-CG-EMPTY` |
| `no_current_goal` | нет фокуса | create_goal | `REF-NO-FOCUS` |
| `missing_revision` | `revises` не перечисляет провалившийся вариант | create_goal | `REF-REV-MISSING` |
| `unknown_revision` | `revises` в не-refuted точке | create_goal | `REF-REV-UNKNOWN` |
| `repeat_hypothesis` | `what` повторяет провалившийся вариант | create_goal | `REF-REPEAT-HYP` |
| `all plan items are fulfilled` | рост объективной цели с выполненным планом | create_goal | `REF-PLAN-DONE` |
| `not_current_goal` | check целится не в фокус | run | `REF-NOT-FOCUS` |
| `arbiter_goal_needs_acceptance` | check арбитр-цели (без команды) | run | `REF-RUN-ARB` |
| `invalid_target` | check не-цели | run | `REF-RUN-TARGET` |
| несовпадение команды | check передаёт другую команду | run | `REF-RUN-CMD` |
| `job_poll` | опрос с лишними полями | run | `REF-RUN-POLL` |
| `background_target` | background check | run | `REF-RUN-BGCHECK` |
| `background_run` | background без команды | run | `REF-RUN-BGCMD` |
| run без команды/target | пустой `run` | run | `REF-RUN-EMPTY` |
| `repeated_action` | идентичный read/grep/run или re-query показанного тела | read/grep/run/query | `REF-REPEAT` |
| `stale_base` | edit файла, изменённого после чтения | edit | `REF-EDIT-STALE` |
| `constraint_violation:<pattern>` | edit запрещённого пути | edit | `REF-EDIT-CONSTRAINT` |
| `stale_base` | write поверх файла, изменённого после чтения | write | `REF-WRITE-STALE` |
| `constraint_violation:<pattern>` | write запрещённого пути | write | `REF-WRITE-CONSTRAINT` |
| `not_addressed` | `stop` на запросе, который не `addressed` (или фокус не запрос) | stop | `REF-ST-STATE` |
| `addressed` | любой оператор кроме `stop` на уже `addressed` запросе | create_goal/apply | `REF-ADDRESSED` |

**Провалы** инструментов (это `fail`-observation, не отказ): нет файла (`read`),
плохой scope (`grep`/`list`), `find` не найден (`edit`), ненулевой код/таймаут/
сигнал (`run`).

---

## 4. Инварианты

- цель `achieved` — только через passing `check` без `under`; `achieved_under` —
  passing check с `under` (`DER-GOAL`).
- `stale`-проверка никогда не показывается как активная; устаревший факт не активен.
- `project` детерминирован: те же события → тот же `Context`.
- структурные рёбра (`has_plan`/`item`/`has_alternatives`/`chosen`) — лес.
- каждая не-корневая цель — item плана или alternatives.
- отказ/провал меняет проекцию.
- закрытая цель (и её потомки) не остаётся фокусом (`TR-4`).
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
| `OP-AP-READ-1..5` | `tests/ops/apply.test.ts` | сценарий `locate-across-files` |
| `OP-AP-GREP-1..4` | `tests/ops/apply.test.ts` | сценарий `locate-across-files` |
| `OP-AP-LIST-1..2` | `tests/ops/apply.test.ts` | сценарий `locate-across-files` |
| `OP-AP-EDIT-1..5` | `tests/ops/apply.test.ts` | сценарии `stale-base`, `two-step-fix` |
| `OP-AP-WRITE-1..6` | `tests/ops/apply.test.ts` | сценарий `command-from-package` |
| `OP-AP-RUN-1..7` | `tests/ops/apply.test.ts` | steps `apply-next-action`, `check-ready-objective`, `poll-background-job`, `retry-inconclusive` |
| `OP-AP-FETCH-1..3`, `REF-FETCH-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-AP-PATCH-1..2`, `REF-PATCH-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-QR-1..6` | `tests/ops/query.test.ts` | сценарии `retrieve-at-scale`, `reproduce-then-read` |
| `TR-1..7` | `tests/ops/traversal.test.ts` | steps `apply-next-action`, `follow-focus-hint` |
| `DER-REQ/GOAL/ACT/STALE` | `tests/ops/derivation.test.ts` | — |
| `REF-CG/REV/NO-FOCUS` | `tests/ops/create_goal.test.ts` | step `follow-focus-hint`; сценарий `revise-hypothesis` |
| `REF-RUN/REPEAT` | `tests/ops/apply.test.ts`, `tests/ops/query.test.ts` | step `poll-background-job`; сценарий `two-outputs` |
| `REF-EDIT` | `tests/ops/apply.test.ts` | сценарий `constraint-honored` |
| `REF-WRITE-STALE`, `REF-WRITE-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-ST-1`, `REF-ST-STATE` | `tests/ops/stop.test.ts` | step `stop-addressed` |
| `OP-AP-CONT/ALT` | `tests/ops/apply.test.ts`, `tests/ops/create_goal.test.ts` | step `apply-next-action` |
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
