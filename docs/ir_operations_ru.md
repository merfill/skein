# Skein — операции над IR: справочник и матрица тестов

> Английский оригинал — `docs/ir_operations.md`.

Связанные: `docs/ir_semantics_ru.md` (формальная семантика — этот документ есть
операционный справочник и контракт покрытия, а не вторая формализация),
`docs/projection_ru.md`, `docs/tools_ru.md`, `docs/ir_ru.md`, `docs/walkthrough_ru.md`,
`docs/testing_ru.md`.

Статус: **Реализовано.** §1–§4 специфицируют модель и каждую операцию; §5 —
матрица покрытия (заполнена). Идентификатор **стабилен**: у пункта могут появиться
тесты, но его смысл не меняется.

> **Редуцированная модель цели** (`docs/plans/goal_reduction_plan_ru.md`). Цель — это
> `what` + `why?` + `sketch` + контейнер плана, засеянный первой командой. Закрытие
> динамическое: `stop` доксы закрывает цель; нет критерия, нет гейта по exit code, нет
> `done_when`/`step`/`revises` и нет `state` (`exitCode` — обычный вывод).

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

### 1.1 Рабочие узлы (`src/ir/types.ts`)

| Kind | Payload | Роль |
|---|---|---|
| `request` | `{text}` | сырая мотивация; корень; интерпретируется один раз (`has_goal`) или отклоняется (`no_goal`); завершается, когда его цель остановлена |
| `goal` | `{what, why?, sketch?}` | интерпретация запроса или подцель; `sketch` — короткая свободная строка-заметка (I3) |
| `action` | `{command, ...}` | один прогон инструмента; пункт плана |
| `plan` | — | упорядоченный контейнер пунктов цели (рёбра `item`); ПОСЛЕДНИЙ пункт — текущий |
| `alternatives` | — | контейнер вариантов (ответвлённый пункт или подцель-альтернатива); рёбра `item`, порядок = последовательность, ПОСЛЕДНИЙ — текущий |
| `observation` | `{ref?, version?, command?, exitCode?, witness?, output/error/...}` | тело результата инструмента; `exitCode` — обычный вывод, не оракул закрытия |
| `stop` | `{why?}` | завершает цель в фокусе: добавляется как ПОСЛЕДНИЙ пункт её плана, с ребром `has_stopped` от цели |
| `unactionable` | `{why?}` | намерение запроса не действенно; докса отказывается формулировать цель (ребро `no_goal`) |
| `constraint` | `{forbid: string[]}` | инвариант; сеется при старте прогона |
| `file` (artifact) | — | упомянутый файл; порождается `mutates` |

### 1.2 Рёбра (`src/ir/types.ts`)

| Kind | From → To | Смысл |
|---|---|---|
| `has_goal` | request → goal | единственная интерпретация запроса (фиксирована) |
| `has_plan` | goal → plan | контейнер пунктов цели |
| `item` | plan/alternatives → goal/action/stop | упорядоченное членство (порядок = последовательность; ПОСЛЕДНИЙ пункт — текущий) |
| `has_alternatives` | goal / пункт плана → alternatives | контейнер вариантов (ответвлённый пункт / подцель) |
| `produces` | action → observation | тело результата действия |
| `has_stopped` | goal → stop | цель завершена доксой (`stop` также последний пункт её плана) |
| `no_goal` | request → unactionable | докса отказалась формулировать цель для запроса |
| `mutates` | action → file | действие изменило файл |

### 1.3 События (`src/ir/events.ts`)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`. `fold`
применяет их по порядку; состояние (`children`, `branch`, `focusOf`, версии) —
**производное**, никогда не хранится. Нет `record_check` и нет `set_status`: смена
состояния — это новое событие-узел (`observation`/`stop`). Результат прогона — обычная
`observation`; её `exitCode` — вывод, не вердикт.

### 1.4 Контейнеры и обход

- **branch** — стек целей от корня-запроса до фокуса; `descend` кладёт, `return` снимает (`TR-1`).
- **focus** — `branch[last]`, иначе корень (`TR-1`).
- **plan** — цель `has_plan`; **пункты** — рёбра `item` в порядке вставки;
  **последний** пункт — текущий.
- **alternatives** — цель `has_alternatives`; **текущая** опция — последний
  ребёнок `item` (ребра `chosen` нет).
- **frontier** — допустимые ходы в фокусе, вычисляются **один раз** и разделяются
  проекцией и `classify` (`TR-8`). Доксе выдаётся всё **плечо** (соседи уровня) с
  **курсором** только на текущем узле; движок не диктует единственный следующий ход.

---

## 2. Операции

### 2.1 `create_goal` (`OP-CG`)

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| у запроса (интерпретация) | фокус — `request` ещё без цели | добавить `goal` (`what`/`why?`/`sketch`); `has_goal` request → goal; засеять план первой `command`; `descend` в неё | интерпретация фиксирована; первый пункт плана текущий | `empty_what`, `empty_sketch`, `empty_command`, `interpreted` | `OP-CG-1` |
| декомпозиция открытой цели | фокус — `goal` с текущим action-пунктом | добавить `goal`; обеспечить `alternatives` на текущем пункте; `item`; `descend` | подцель — новейшая опция пункта; пункт вытеснен | как выше | `OP-CG-2` |
| план + первая команда | любой из случаев, есть `sketch` и `command` | сохранить `sketch` на цели; добавить ровно один action-пункт (`command`) под новый контейнер `plan` | пункт текущий | `empty_sketch` (пустая заметка), `empty_command` (пустая команда) | `OP-CG-3` |
| один пункт плана | сев материализуется ровно одним действием | план содержит только первую команду | последующие команды добавляются по одной | — | `OP-CG-4` |

- **Projection** (`PRJ-CG`): `path` в фокусе получает цель (`what`/`why`/`sketch`).
- **Notes.** `why` — гипотеза, показывается на пункте, чтобы провалившаяся попытка не
  повторялась (`PRJ-PATH-why`). Декомпозиция открытой цели требует текущего action-пункта;
  без него движок пишет fail-observation
  (`create goal failed: no current plan item to decompose`). Первую команду несёт
  `command` — это не особый `step`.

### 2.2 `apply` (`OP-AP`)

Диспетчер одного инструмента в фокусе (`src/tools/index.ts`, `OP-AP-*`).

**Как `apply` ложится в план** — различие *continue* vs *alternative*
(`docs/ir_semantics_ru.md` §2.6): переиспользовать неисполненный action-пункт с той же
командой (`OP-AP-CONT-1`); иначе прикрепить новое действие как новейшую альтернативу
текущего невыполненного пункта (`OP-AP-ALT-1`); иначе создать действие и добавить как
новый пункт `item` (`OP-AP-CONT-2`). Движок никогда не входит в действие.

#### 2.2.1 `read` (`OP-AP-READ`)

| Случай | Pre | Effects | ID |
|---|---|---|---|
| новое окно | путь существует; мир не менялся с прошлого идентичного чтения | добавить `action`; добавить `observation` (`produces`); записать наблюдённую версию | `OP-AP-READ-1` |
| продолжение окна | другие `start/end` | новое действие/наблюдение | `OP-AP-READ-2` |
| отсутствующий файл | — | действие + fail-observation | `OP-AP-READ-3` |
| повтор | идентичное окно, мир не менялся | отказ `repeated_action` | `OP-AP-READ-4` |
| путь вне workspace | — | действие + fail-observation (записанный отказ, без краха) | `OP-AP-READ-5` |
| трэш чтения | неизменный файл уже прочитан дважды (без правок) | отказ `repeated_action` (указать на edit) | `OP-AP-READ-6` |

#### 2.2.2 `grep` (`OP-AP-GREP`)

| Случай | Pre | Effects | ID |
|---|---|---|---|
| поиск по scope | `path`/`include`/`exclude` валидны | действие + наблюдение (JSON-окна) | `OP-AP-GREP-1` |
| пагинация | `from`/`count` | новое действие/наблюдение; повтор того же паттерна с новым `from` — новое | `OP-AP-GREP-2` |
| нет попаданий / плохой scope | — | пустой результат / fail-observation | `OP-AP-GREP-3` |
| повтор | идентичные scope+паттерн, мир не менялся | отказ `repeated_action` | `OP-AP-GREP-4` |

#### 2.2.3 `list` (`OP-AP-LIST`)

| Случай | Pre | Effects | ID |
|---|---|---|---|
| список по scope | — | действие + наблюдение (пути как JSON) | `OP-AP-LIST-1` |
| пагинация / пусто | `from`/`limit` | новое действие/наблюдение | `OP-AP-LIST-2` |

#### 2.2.4 `edit` (`OP-AP-EDIT`)

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| замена | файл прочитан и не менялся с того чтения; не запрещён | добавить `action` (`find`/`replace`); `mutate` на каждый изменённый файл | версия файла меняется; зависимые факты устаревают | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-EDIT-1` |
| `find` отсутствует | — | действие + fail-observation (файл материализуется и закрепляется) | — | — | `OP-AP-EDIT-2` |
| запрещённый путь | запрет constraint | — | — | `constraint_violation:<pattern>` | `OP-AP-EDIT-3` |
| устаревшая база | файл изменился после последнего чтения | — | — | `stale_base` | `OP-AP-EDIT-4` |
| путь вне workspace | — | fail-observation (записанный отказ, без краха) | — | — | `OP-AP-EDIT-5` |

#### 2.2.5 `run` (`OP-AP-RUN`)

`run` — одна простая **foreground**-команда. Нет критерия, нет `target` и нет механики
фоновых jobs.

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| команда | есть `command` | действие + `observation` (`command` + `exitCode`); `mutate` на каждый изменённый файл | версии; старые чтения устаревают | `repeated_action` | `OP-AP-RUN-1` |

- **Projection** (`PRJ-AP`): узел результата — `lastResult`; stdout (`output`) и
  stderr (`error`) раздельны; крах добавляет `signal`/`core`/`backtrace`; запись в
  `calls` несёт `id` для последующего `query`.

#### 2.2.6 `write` (`OP-AP-WRITE`)

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| создание | `path` не существует | добавить `action` (`path`/`content`); `mutate`; версия файла задана | — | — | `OP-AP-WRITE-1` |
| перезапись | файл прочитан и не менялся с того чтения; не запрещён | добавить `action`; `mutate`; версия меняется | зависимые факты устаревают | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-WRITE-2` |
| запрещённый путь | запрет constraint | — | — | `constraint_violation:<pattern>` | `OP-AP-WRITE-3` |
| устаревшая база | файл изменился после последнего чтения | — | — | `stale_base` | `OP-AP-WRITE-4` |
| непрочитанный файл | файл существует, но не читался | — | — | fail-observation (`read it first`) | `OP-AP-WRITE-5` |
| путь вне workspace | — | fail-observation (записанный отказ, без краха) | — | — | `OP-AP-WRITE-6` |

- **Projection** (`PRJ-AP`): исполненный узел `action` с ребром `mutates` и событием
  `mutate`, несущим новую версию.

#### 2.2.7 `fetch` (`OP-AP-FETCH`)

Получает внешние референсные данные (upstream/опубликованную/соседнюю копию) в
workspace, чтобы их можно было читать и диффить (B9, `docs/system_prompt_ru.md`).

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| fetch | URL достижим; цель не существует; не запрещена | действие; записать файл; `mutate` + `mutates`; наблюдение (`url`/`path`/`bytes`) | версия файла задана; старые чтения устаревают | — | `OP-AP-FETCH-1` |
| сбой загрузки | не-2xx / таймаут | fail-observation | — | — (fail) | `OP-AP-FETCH-2` |
| цель существует / путь вне workspace | — | fail-observation (`choose another path` / записанный отказ) | — | — | `OP-AP-FETCH-3` |
| запрещённый явный путь | запрет constraint | — | — | `constraint_violation:<pattern>` | `REF-FETCH-CONSTRAINT` |

Цель по умолчанию принадлежит движку (`refPathFor`, `.skein/ref/<hash>-<slug>`), поэтому
проверяется по constraint только явный `path`.

#### 2.2.8 `apply_patch` (`OP-AP-PATCH`)

Применяет unified diff в корне workspace (`patch -p<strip>`, по умолчанию 1), например
upstream-изменение, полученное через `fetch`.

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| примененимо | патч применяется чисто | действие; `mutate` на каждый изменённый файл (`patch -p<strip>`) | изменённые версии; старые чтения устаревают | — | `OP-AP-PATCH-1` |
| не применяется | конфликтующий/уже применённый hunk | fail-observation | — | — (fail) | `OP-AP-PATCH-2` |
| запрещённая цель | constraint запрещает путь `---`/`+++` | — | — | `constraint_violation:<pattern>` | `REF-PATCH-CONSTRAINT` |

### 2.3 `decline` (`OP-DC`)

Докса предполагает, что намерение запроса **не действенно** (болтовня, нет задачи) и
отказывается формулировать цель — вместо выдумывания цели. Доступно только пока у
запроса ещё нет интерпретации; записывает узел `unactionable` под запросом (ребро
`no_goal`) и завершает прогон (`docs/plans/archive/request_goal_plan.md`).

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| отклонить запрос | фокус — запрос без интерпретации и без узла `unactionable` | добавить узел `unactionable` и ребро `no_goal` от запроса; прогон завершается | запрос терминален (`request_unactionable`) | — | `OP-DC-1` |
| не у запроса | фокус — цель | — | — | `not_request` | `REF-DC-NOTREQ` |
| уже интерпретирован | у запроса уже есть интерпретация | — | — | `interpreted` | `REF-DC-ADDR` |

- **Projection** (`PRJ-DC`): опция `decline` предлагается у свежего запроса рядом с
  `create_goal`.

### 2.4 `stop` (`OP-ST`)

Терминальный ход доксы и **единственное закрытие**. На **цели** он завершает кадр
(движок возвращается к родителю на следующей проекции и продолжает); на **запросе**
завершает прогон. Критерия и проверки нет: докса решает в процессе.

| Случай | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| завершить открытую цель | фокус — цель | добавить узел `stop` как **последний пункт плана** и ребро `has_stopped` от цели | цель закрыта; движок возвращается | — | `OP-ST-1` |
| закрытие записано в плане | цель с планом | узел `stop` — **последний пункт плана** цели; `has_stopped` направлен goal → stop | закрытие и его причина лежат в плане | — | `OP-ST-2` |
| запрос завершается | у цели запроса есть ребро `has_stopped` | прогон завершается | stopReason `request_addressed` | — | `OP-ST-3` |
| не у цели | фокус — запрос | — | — | `not_addressed` | `REF-ST-STATE` |

- **Projection** (`PRJ-STOP`): узел `stop` — последний пункт плана цели.
- Цель закрывается только через `stop` (ребро `has_stopped`). На запросе `stop` нет;
  запрос завершается, когда его цель остановлена.

### 2.5 `query` (`OP-QR`)

| Случай | Pre | Effects | ID |
|---|---|---|---|
| по id, тело | id адресует результат (наблюдение или тело inline/`Ref`) | узла нет; тело возвращено; id закреплён в `shown` (TTL) | `OP-QR-1` |
| по id, без тела | id — действие/цель/и т.п. | строка узла + инцидентные рёбра | `OP-QR-2` |
| по id, окно | `start`/`end` | строчное окно; продолжается новым `query` | `OP-QR-3` |
| состояние: `kind` | — | подходящие узлы (ограничено) | `OP-QR-4` |
| состояние: `edgesOf` | — | инцидентные рёбра узла | `OP-QR-5` |
| избыточно | id уже в `shown` | отказ `repeated_action` | `OP-QR-6` |

- **Projection** (`PRJ-QR`): тело из запроса входит в `shown` в полном виде на
  несколько ходов и выпадает из явного удержания по истечении; запросы состояния не
  закрепляются.

### 2.6 Обход и контейнеры (`TR`)

| Случай | Правило | ID |
|---|---|---|
| фокус | фокус — `branch[last]`, иначе корень | `TR-1` |
| descend | `focusEvents` спускается в цель запроса (`has_goal`) или в последнюю опцию `alternatives` пункта | `TR-2` |
| return | завершённый верх снимается; `return` допустим | `TR-3` |
| обрезка под завершённым предком | если любой предок (кроме корня) завершён, ветка обрезается — не только когда завершается верх (инвариант 17 расширен) | `TR-4` |
| выбор контейнера | контейнер пунктов цели — `plan` (`has_plan`); интерпретация запроса — ребро `has_goal`; ответвлённый пункт использует `alternatives` (`has_alternatives`) | `TR-5` |
| порядок пунктов и курсор | пункты идут по порядку рёбер `item` (ПОСЛЕДНИЙ текущий); курсор — первый не `itemFulfilled`; пункт выполнен, когда его действие исполнено или новейшая опция завершена | `TR-6` |
| ветвление вариантов | неисполненный action-пункт с той же командой переиспользуется; иначе новое действие становится новейшей опцией `alternatives` текущего невыполненного action-пункта; прежние опции становятся невыбранными | `TR-7` |
| frontier | `applicable` вычисляет create_goal/apply/stop/decline из тех же фактов, что и гейты; докса выбирает среди них | `TR-8` |
| история пункта | `alternatives` пункта плана (история пункта) рендерится в проекции | `TR-9` |

### 2.7 Производные факты (`DER`)

Состояние всегда выводится из инцидентных событий, никогда не хранится.

| Предикат | Правило | ID |
|---|---|---|
| цель закрыта | у цели есть ребро `has_stopped` к узлу `stop` | `DER-GOAL-1` |
| действие `executed` | у него есть ребро `produces` или `mutates` | `DER-ACT-1` |
| witness прогона | наблюдение прогона несёт `witness` (основа устаревания) | `DER-STALE-1` |

---

## 3. Каталог отказов (`REF`)

Гейт `classify` (`src/loop/classify.ts`). Отказ эмитит `record_rejection` и **обязан
изменить проекцию** (инвариант).

| Причина (токен) | Триггер | Оператор | ID |
|---|---|---|---|
| `empty_what` / `empty_sketch` / `empty_command` | некорректный `create_goal` | `create_goal` | `REF-CG-EMPTY` |
| `no_current_goal` | фокуса нет | create_goal | `REF-NO-FOCUS` |
| `interpreted` | второй `create_goal` у запроса, уже имеющего цель | create_goal | `REF-INTERPRETED` |
| run без команды | пустой `run` | run | `REF-RUN-EMPTY` |
| `repeated_action` | идентичные read/grep/run или повторный запрос уже показанного тела | read/grep/run/query | `REF-REPEAT` |
| `stale_base` | edit по файлу, изменившемуся после чтения | edit | `REF-EDIT-STALE` |
| `constraint_violation:<pattern>` | edit запрещённого пути | edit | `REF-EDIT-CONSTRAINT` |
| `stale_base` | write поверх файла, изменившегося после чтения | write | `REF-WRITE-STALE` |
| `constraint_violation:<pattern>` | write запрещённого пути | write | `REF-WRITE-CONSTRAINT` |
| `not_addressed` | `stop`, когда фокус — не цель (запрос) | stop | `REF-ST-STATE` |
| `not_request` | `decline` вне фокуса-запроса | decline | `REF-DC-NOTREQ` |
| `interpreted` | `decline` у запроса, уже имеющего цель | decline | `REF-DC-ADDR` |

**Провалы инструментов** (fail-observation, не отказ): отсутствующий файл (`read`),
плохой scope (`grep`/`list`), `find` отсутствует (`edit`), ненулевой код/таймаут/сигнал
(`run`).

---

## 4. Инварианты

- цель закрывается только через `stop` (ребро `has_stopped`, и узел `stop` — последний
  пункт плана цели); прогона критерия и гейта по exit code нет.
- запрос завершается, когда его цель остановлена (на запросе `stop` нет); запрос
  интерпретируется один раз (`has_goal`) или отклоняется (`no_goal`).
- прогон — обычная `observation`; её `exitCode` — вывод, не вердикт.
- `stale`-факт никогда не показывается как активный; устаревший факт не есть активное содержимое.
- `project` детерминирован: те же события → тот же `Context`.
- структурные рёбра (`has_goal`/`has_plan`/`item`/`has_alternatives`/`has_stopped`/`no_goal`)
  образуют DAG (узел `stop` — и последний пункт плана, и цель `has_stopped`, так что
  структура не дерево).
- каждая не-корневая цель привязана ребром `has_goal` или `item`.
- отказ/провал меняет проекцию.
- завершённая цель (и её потомки) не остаётся фокусом (`TR-4`).
- секреты живут только в `.env`; малые результаты могут инлайниться, секреты — никогда.

Первые четыре реализуют хелперы: `tests/invariants.ts`.

---

## 5. Матрица покрытия

У каждого ID спеки есть минимум один offline-тест; у семейств операций есть и онлайн-проверка.
Свойства случайных деревьев (`tests/ops/ir_properties.test.ts`) подкрепляют инварианты
на 400 сгенерированных деревьях. Живые пошаговые тесты
(`tests/live/ir_operations_step.test.ts`, запуск вручную:
`SKEIN_LIVE=true npx vitest run ...`) строят проекцию offline и проверяют форму
следующего хода живой модели (каждый шаг повторяется `SKEIN_STEP_REPEATS=3`).

| ID спеки | Offline-тест | Live |
|---|---|---|
| `OP-CG-1..4` | `tests/ops/create_goal.test.ts` | шаг `interpret-request`; сценарий `multi-step-plan` |
| `OP-AP-READ-1..6` | `tests/ops/apply.test.ts` | сценарий `locate-across-files` |
| `OP-AP-GREP-1..4` | `tests/ops/apply.test.ts` | сценарий `locate-across-files` |
| `OP-AP-LIST-1..2` | `tests/ops/apply.test.ts` | сценарий `locate-across-files` |
| `OP-AP-EDIT-1..5` | `tests/ops/apply.test.ts` | сценарии `stale-base`, `two-step-fix` |
| `OP-AP-WRITE-1..6` | `tests/ops/apply.test.ts` | сценарий `command-from-package` |
| `OP-AP-RUN-1` | `tests/ops/apply.test.ts` | шаг `apply-next-action` |
| `OP-AP-FETCH-1..3`, `REF-FETCH-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-AP-PATCH-1..2`, `REF-PATCH-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-QR-1..6` | `tests/ops/query.test.ts` | сценарии `retrieve-at-scale`, `reproduce-then-read` |
| `TR-1..9` | `tests/ops/traversal.test.ts` | шаги `apply-next-action`, `continue-open-goal` |
| `DER-GOAL/ACT/STALE` | `tests/ops/derivation.test.ts` | — |
| `REF-CG`, `REF-NO-FOCUS`, `REF-INTERPRETED` | `tests/ops/create_goal.test.ts`, `tests/ops/applicable.test.ts` | — |
| `REF-RUN-EMPTY`, `REF-REPEAT` | `tests/ops/apply.test.ts`, `tests/ops/query.test.ts` | — |
| `REF-EDIT` | `tests/ops/apply.test.ts` | сценарий `constraint-honored` |
| `REF-WRITE-STALE`, `REF-WRITE-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-ST-1..3`, `REF-ST-STATE` | `tests/ops/stop.test.ts` | шаг `stop-open-goal` |
| `OP-DC-1`, `REF-DC-NOTREQ`, `REF-DC-ADDR` | `tests/ops/decline.test.ts` | — |
| `OP-AP-CONT/ALT` | `tests/ops/apply.test.ts`, `tests/ops/create_goal.test.ts` | шаги `apply-next-action` |
| `TR-8` | `tests/ops/applicable.test.ts` | шаг `stop-open-goal` |
| `TR-9` | `tests/ops/traversal.test.ts` | — |

**Гейт покрытия** (`tests/coverage.test.ts`): каждый ID реестра должен встречаться
токеном минимум в одном тесте, и ни один тест не может ссылаться на ID вне реестра —
документ и тесты не могут разойтись.

---

## 6. Расширение

1. Добавьте пункт спеки с новым стабильным ID и его Pre/Effects/Derived/Refuses
   (и, если новый, токен отказа в §3).
2. Добавьте offline-тест, цитирующий ID в заголовке.
3. Добавляйте live-сценарий только если семейству операций нужна сквозная проверка.
4. Гейт покрытия не пройдёт, пока в матрице нет теста.
