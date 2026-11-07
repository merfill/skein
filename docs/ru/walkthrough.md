# Skein — сквозной пример: состояния и динамическая лента

> **Актуально на 2026-11-06.** Состояние — единица работы. Контекст — детерминированная
> проекция IR; движок собирает её заново на каждом ходу. Журнал только дополняется, а лента
> меняется: закрытое состояние исчезает из неё, но остаётся в журнале и доступно по `id`.
>
> Пример ниже обновлён под текущую проекцию: запрос стартует прямо в Patch, а цель, критерий и
> план приходят завершающим working-ходом `user` (`Goal`, догадка, `Done when`, `Plan`, запрос
> как reference). `Orientation` и `Recovery` удалены; `Research` завершает запрос в `End`,
> проверка результата входит в его собственный критерий.
>
> Источник истины — `docs/ru/ir.md`; проекция — `docs/ru/projection.md`;
> состояния — `docs/ru/states.md`; as-built — `docs/ru/ir.md`. Английское зеркало —
> `docs/en/walkthrough.md`.

## Преамбула

**Как работает обычный агент.** Почти все LLM-агенты устроены одинаково: у модели есть
лента сообщений (system, user, assistant, tool), и эта лента служит памятью. Агент добавляет
в неё новый ход, следующий вызов модели читает всю ленту, и так по кругу. Всё, что агент
«знает», лежит в этой переписке: прочитанные файлы, вывод команд, прошлые рассуждения,
ошибки. Когда лента становится слишком длинной, её сокращают или резюмируют — и часть знания
теряется или искажается. Модель видит всю историю, но не может выбрать, что нужно ей сейчас:
старое и уже неверное остаётся рядом с новым.

**Как устроен Skein.** Skein хранит знание иначе. Источник истины — журнал (IR): неизменяемый
список событий о том, что произошло (запрос, состояния, вызовы, результаты, правки). Лента
сообщений — не память, а проекция журнала: её собирают заново на каждом ходу и показывают
модели только то, что относится к текущему состоянию. Поэтому одни и те же события всегда
дают одну и ту же ленту, а смена фокуса меняет вид, не переписывая историю. Всё, что ушло из
ленты, остаётся в журнале и достаётся по `id`.

**Что такое состояние.** Работа агента разбита на состояния. Состояние — это не шаг и не
команда, а состояние знания: например, «найти дефект в существующем артефакте и внести
изменение, которое он требует» или «проверить изменение против приёмки». У каждого состояния
есть цель (что должно быть известно), критерий (по какому наблюдаемому признаку видно, что цель
достигнута) и способ действовать (какие инструменты доступны и как себя вести). Модель входит
в состояние ходом `move`, работает в нём и закрывает его ходом `stop`, когда критерий выполнен.
Набор состояний фиксирован: Research, Patch, Construction, Verification, End.
Текущее состояние задаёт, что видно в ленте: его цель,
сведения о материале, инструкцию и план. Когда состояние закрыто,
лента оставляет от него только `Start`/`Finish`, а фокус переходит к следующему.

**Принципы.** Отсюда следуют три вещи, на которых держится документ:

1. Модель предлагает ходы, движок решает и записывает результат (докса/логос).
2. Состояние — единица работы: у него есть цель, критерий и способ действовать.
3. Лента динамична: она показывает текущее состояние, а не весь путь; закрытое состояние
   оставляет в ней только след.

## 1. Журнал, IR, состояние и лента

Skein держится на четырёх понятиях:

| Понятие | Что это |
|---|---|
| **журнал** | список событий; только дополняется; единственный источник истины |
| **IR** | граф состояний и переходов, построенный по журналу |
| **состояние** | `move` с целью, критерием и планом |
| **лента** | то, что видит модель: запрос, текущее состояние целиком и следы закрытых состояний |

В IR состояние — это `move`: имя острова, цель и критерий. Состояния не вложены друг в друга:
это последовательность шагов запроса, которые идут по очереди. Внутри состояния есть план:
пункты и альтернативы у пунктов. Альтернатива — это конкретный вызов инструмента; рядом с
вызовом записывается рассуждение, а результат исполнения попадает на ленту. Закрывает
состояние отдельный `stop`.

Лента собирается из графа состояний заново на каждом ходу. Одни и те же события дают одну и
ту же ленту. Устройство IR (узлы, рёбра, операторы) описано в `docs/ru/ir.md`,
`docs/ru/ir.md` и `docs/ru/ir.md`.

### 1.1 Как устроена лента

Лента начинается с двух сообщений:

1. `system` — базовый промпт: общие правила и описание состояний и переходов.
2. `user` — запрос пользователя.

Если в запросе есть ограничения, между промптом и запросом идут отдельные `system`-сообщения
с ними.

Дальше идут состояния. Открытое состояние выглядит так:

```
system   Start state <label>
system   <карта workspace или факты окружения>
assistant [id] <вызов инструмента> + reasoning
tool      [id] <результат>
assistant [id] <следующий вызов> + reasoning
tool      [id] <результат>
user     Goal: <island.what>
         Your earlier guess (may be wrong): <догадка>   ← если модель её задала
         Done when: <criterion>. When it holds, reply with the result as text only — no tool call.
         Plan: <island.instruction>
         The original user request is context for this state, not its goal.
```

Вызовы и результаты накапливаются: это то, что модель уже сделала в этом состоянии.
Working-промпт добавляется после них, пересобирается каждый ход и не хранится.

Пример открытой Patch после двух вызовов:

```
system   Start state Patch
system   Workspace root: /app / Workspace repository: ... / environment
assistant [a1] grep "def parse" + reasoning
tool      [o1] src/parse.py:63 ...
assistant [a2] read src/parse.py 40-90 + reasoning
tool      [o2] ... окно 40-90 ...
user     Goal: apply the change the suspected cause implies to the existing artifact.
         Your earlier guess (may be wrong): the sweep advances by the wrong size
         Done when: "the target is named with its coordinates, the sibling that performs the same
         operation and the differing expression are named; that expression is applied at the
         target; the edited lines read back". When it holds, reply with the result as text only —
         no tool call.
         Plan:
         1. Find the target and the sibling that performs the same operation. Name the target's
            coordinates and the expression, step, or encoding that differs. A suspected cause is enough.
         2. Apply that difference at the target, read the edited lines, and finish with the result:
            the target, the change, and the suspected cause.
         The original user request is context for this state, not its goal.
```

Когда состояние закрыто, от него остаются два `system`-сообщения — след:

```
system   Start state Patch
system   Finish state Patch — line 63 drops the last token ...
```

Инструкция, карта, цель, вызовы и результаты закрытого состояния из ленты уходят. Сами данные
остаются в IR и достаются через `recall`/`search`, пока открыто какое-то состояние.

### 1.2 Переход

После `stop` доступен только `move`; других инструментов нет. На ленту дописывается временная
`system`-инструкция:

```
system   The engine recorded this state's result on the `Finish state Patch — …` line above.

         Choose exactly one next state:
         - Verification — the change is applied, and the edited lines read back.
         - Research — the work turns out to be a situation, not a defect to locate and fix.

         Call `move` alone with `what` = the object or situation the next state works on
         (≤20 words), not the task; leave `done` out, and do not do that state's work on this turn.
```

Состояния в списке заданы **условием входа** (`next[].when`), а не описанием работы: список —
единственный источник, `transitionRule` больше нет. После `move` эта инструкция стирается.
Следующее состояние открывается своим `Start state`, своим брифом и своей целью; план
предыдущего не переносится. Коррекционные рёбра (`P ↔ R`, `V → P`) видны только здесь, в
условиях; на поведение внутри состояний они не влияют.

## 2. Состояние — единица работы

Состояние — это не шаг и не команда, а состояние знания. У него есть **цель**, **критерий** и
**способ действовать**. Модель объявляет состояние ходом `move`:

```
move { state, what?, done? }
```

- `state` — остров из закрытого словаря. Состояние и есть его цель.
- `what` — необязательная догадка доксы о конкретном предмете; это не цель.
- `done` — необязательное переопределение критерия острова.

В ленте цель состояния показывается строкой `Goal: <island.what>`. Если модель задала `what`,
рядом появляется догадка: `Your earlier guess (may be wrong): …`.

Состояние закрывается **только** явным `stop`; проверки критерия движок не делает. `stop`
записывает строку `Finish state <label> — <why>`: это след состояния и передача следующему.

### 2.1 Острова — это состояния

Остров — это вид работы; `state` в `move` называет остров, а сам `move` — конкретное состояние
в журнале. В тексте «состояние» — конкретный шаг, «остров» — вид работы.

| Остров | Цель (`island.what`) | Критерий (кратко) | Сведения о материале | `next` |
|---|---|---|---|---|
| **Research** | решить ситуацию: вывести требуемый результат из материала или спецификации | результат есть в объявленной форме, выведен из материала или спецификации и совпадает с тем, что содержит материал или запрос | координаты + environment | End, P¹ |
| **Patch** | найти дефект в существующем артефакте и внести изменение, которое он требует | цель и координаты; сиблинги исключены; причина названа как подозрение; полное изменение (найденный артефакт + остальные нужные файлы) в объявленной форме | координаты + environment | V, R¹ |
| **Construction** | построить новый артефакт из спецификации или поведения материала | артефакт есть; acceptance-проверка прошла | координаты + environment | End, R |
| **Verification** | проверить изменённый артефакт против приёмки | приёмка держится (команда или ограничения) | environment | End, P¹ |
| **End** | завершить запрос | нет: текстовый отчёт завершает запрос | — | — |

Координаты — это `Workspace root`, статус `Workspace repository` и `Working directory`, когда
шелл стартует вне корня.

¹ Коррекционные рёбра. `Patch → Research` выбирают, если работа оказалась ситуацией, а не
дефектом для локализации и правки; `Research → Patch` — если ситуация оказалась дефектом кода;
`Verification → Patch` после проваленной приёмки, потому что провал может быть и в изменении, и
в причине, на которую оно опиралось. Так исправляют неверную стартовую классификацию или
неверную причину; обычным выходом эти рёбра не являются.

Verification проверяет **изменённый артефакт** после Patch; у Research проверка результата
входит в его собственный критерий, поэтому `Research → Verification` нет.

Кроме цели и критерия, остров задаёт `instruction` (как действовать; показывается один раз при
входе) и `applies` (какие apply-инструменты доступны). Инструкция не заменяет цель: цель — это
`island.what`.

### 2.2 Маршруты

- **Repair:** `P → V → End`.
- **Research:** `R → End` (проверка результата — в критерии Research).
- **Construction:** `C → End`; неудачный Construction может уйти в `R` при провале метода.
- **Hybrid:** `R → P → V → End` для задачи, где сначала добывается секрет, а потом меняется
  артефакт (`git-leak-recovery`); шаг `R → P` — явный `move`, а не подсказанное ребро.
- **Коррекционные:** `V → P` при провале; `P ↔ R` при неверной стартовой классификации;
  `C → R` при провале метода.

У запроса нет своего `stop`. Он интерпретируется один раз (`move` или `decline`), а прогон
завершается, когда закрыто терминальное состояние `End`.

## 3. Детали ленты

### 3.1 Сведения о материале

Сведения о материале зависят от острова: координаты + environment (Research, Patch,
Construction), только environment (Verification). Само дерево не
перечисляется: состояние, которому нужны файлы, запрашивает их через `list`. Это уже записанные
факты; перепроверять их не нужно.

### 3.2 Рассуждения

Прошлые рассуждения доксы видны на её assistant-ходах (`payload.reasoning`). Сырой `thought`
не хранится: его смысл остаётся в `why`. Отключается через `SKEIN_REASONING_TAPE=false`.

### 3.3 Что не показывается и как это достать

- `move.what` — не цель, а догадка на ходе `Goal:`;
- планы, блоки факта и инструкции закрытых состояний не показываются;
- предположения запроса не переносятся в состояние как факты.

Адресуемость: любой узел либо показан, либо достаётся одним `recall`/`search` по `id`, пока
состояние открыто. Поэтому затирка меняет вид, а не уничтожает знание.

## 4. Сквозной пример

### 4.1 Задача

В `/app` — небольшой проект на Python: `src/parse.py`, `Makefile`, `tests/`. В `src/parse.py`
сломали разбор строки, поэтому `make test` падает. Пользователь просит:

> «Я сломал сборку; сделай так, чтобы `make test` проходил.»

Действует ограничение `k1` — не трогать тесты. Приёмка — `make test`.

### 4.2 Начало: стартовый блок

Первый ход ещё не выбрал состояние. На ленте базовый промпт, запрос и request-инструкция:

```
system   # Role ... ## How you work ... ## General instructions ...
user     «Я сломал сборку; сделай так, чтобы `make test` проходил.»
user     Choose exactly one of three values:
         - Patch when the task is to find an error in the existing code and fix it by editing an existing file.
         - Construction when the task is to write new file(s) explicitly.
         - Research in all other cases.
         The original user request is context for this choice, not the goal.
```

Доступны только `move` и `decline`. Запрос — найти и исправить ошибку в существующем файле,
поэтому первый шаг — Patch. (Для ситуации был бы Research, для нового артефакта — Construction.)

### 4.3 Patch

Докса вызывает `move {state:"patch", what:"the parse loop that breaks on the last token"}`.
На ленте — запрос и открытая Patch:

```
system   Start state Patch
system   Workspace root: /app / Workspace repository: ... / environment
assistant [a1] grep "def parse" + reasoning
tool      [o1] src/parse.py:63 ...
assistant [a2] read src/parse.py 40-90 + reasoning
tool      [o2] ... (окно 40-90) ...
assistant [a3] edit {path:"src/parse.py", find:..., replace:...} + reasoning
tool      [m] mutated src/parse.py
user     Goal: find the defect in the existing artifact and make the change it needs.
         Your earlier guess (may be wrong): the parse loop that breaks on the last token
         Done when: "the plan is complete: the error is found and fixed". When it holds,
         reply with the result as text only — no tool call.
         Plan:
         1. Find the file with the coordinates and the cause of the error.
         2. Fix the error and stop with a report about it.
         The original user request is context for this state, not its goal.
```

Цель и причина найдены, изменение внесено; ход —
`stop {why:"line 63 drops the last token — off-by-one in the loop, boundary moved"}`.

След:

```
system   Start state Patch
system   Finish state Patch — line 63 drops the last token ...
```

### 4.4 Verification

Дальше — приёмка. Patch уже сделал изменение целиком: не только найденный артефакт, но и
остальные файлы, которые нужны задаче.

```
... Finish state Patch ...
system   Start state Verification
system   Probe ...
user     Goal: check the changed artifact against the goal's acceptance
assistant [a4] bash {command:"make test"}
tool      [o4] exit 1 — IndexError: list index out of range
... (stop → Finish state Verification — make test: exit 1 — IndexError: list index out of range)
```

Что случилось: правка сдвинула границу цикла, и теперь на последней итерации код читает
`tokens[i + 1]` за концом списка. Тест падает с `IndexError`. Сам объект — цикл разбора — найден
верно; неверно именно изменение. Поэтому по правилу перехода `V → Patch` (провал в изменении
или в причине, на которую оно опиралось) возвращаемся в Patch, а не завершаем запрос.

Перед возвратом движок пишет `revert`: файлы возвращаются к состоянию до первой правки. В ленте
провал остаётся только в `Finish`-строке Verification; план провалившейся Verification не
показывается.

Второй Patch применяет другой diff — с проверкой границы, — и Verification проходит:

```
system   Finish state Verification — make test: exit 1 — IndexError: list index out of range
system   Start state Patch
system   Workspace root: /app / Workspace repository: ...
user     Goal: find the defect in the existing artifact and make the change it needs
assistant [a5] edit {path:"src/parse.py", ...}   ← другой diff
tool      [m] mutated src/parse.py
... (stop → Finish state Patch — ...)
system   Start state Verification
system   Probe ...
user     Goal: check the changed artifact against the goal's acceptance
assistant [a6] bash {command:"make test"}
tool      [o6] exit 0
... (stop → Finish state Verification — ...)
```

### 4.5 End

Когда приёмка прошла, остаётся завершить запрос:

```
system   Start state End
system   This is End.

         The work is done; complete the request. Reply with the final report as text only,
         with no tool calls.

         Read the tape — the request, the states the task passed, what each of them did,
         the files it changed, and how the result was checked — and write the report from
         those records in GitHub-flavored Markdown: what was done and where, how it was
         verified, and what is still open. Your reply is shown to the user as-is.
```

У End нет критерия и нет следующего состояния, поэтому его инструкция и есть цель хода.
Инструментов на End нет: докса отвечает текстом (без tool call), и движок записывает этот
текст как `stop {why:<отчёт>}`. Прогон завершён (`request_addressed`). В IR остались все
состояния, включая провалившуюся Verification; на ленте — только их следы (`Finish`-строки),
поэтому отчёт собирается из них, а не из сырых ходов.

### 4.6 Что осталось в IR

Состояния — это отдельные шаги запроса. Каждое соединено с запросом ребром `move`, а план
висит на самом состоянии. Лента убрала их из вида, но IR сохранил всё:

```
R  request
├─ I1 patch         stopped   plan: a1 grep, a2 read, a3 edit (v1→v2)
├─ I2 verification  stopped   plan: a4 bash (exit 1)     ← провал
│  ┆ revert v2→v1 (на переходе I2→I3)
├─ I3 patch         stopped   plan: a5 edit (v1→v3)
├─ I4 verification  stopped   plan: a6 bash (exit 0)
└─ H  end           stopped
```

Поэтому `recall`/`search` и нужны: закрытого состояния не видно в ленте, но его результаты
доступны по `id`.

### 4.7 На что обратить внимание

- **Состояние — единица работы.** Цель — `island.what`; `move.what` — догадка; `move.done` —
  переопределение критерия.
- **Затирка после `stop`.** В ленте от закрытого состояния остаются только `Start`/`Finish`;
  план и сведения о материале уходят, но остаются в IR.
- **`Finish` — след и передача.** Следующее состояние не наследует план. Оно получает сведения
  о материале заново и читает `Finish`-строку как результат.
- **Хвост удерживает цель.** `Done when` и требование закрыть состояние живут в записи состояния.
  Это не память, а запись состояния в начале ленты.
- **Рассуждения на ленте.** Докса видит свои прошлые рассуждения на assistant-ходах; сырой
  `thought` не хранится, его смысл остаётся в `why`.
- **Проверки критерия нет.** `stop` принимает докса; провал инструмента — факт, а не закрытие.
- **Поверхность — фронтир.** На запросе доступны `move`/`decline`; в открытом состоянии —
  apply-инструменты, `stop`, `recall`/`search`; в закрытом — только `move`; в терминальном —
  ни одного инструмента: докса отвечает текстом, а `stop` пишет движок.
- **Провал Verification ведёт в Patch.** `revert` откатывает последний Patch; провал может быть
  и в изменении, и в причине, на которую оно опиралось, — и то и другое пересматривается в
  Patch.

## 5. Особые случаи

### 5.1 Недейственный запрос (`decline`)

| Ход | Состояние | Предложение | Лента | Журнал |
|---|---|---|---|---|
| 0 | request | — | base + запрос + request-инструкция | `+ request R` |
| 1 | request | `decline {why:"there is no actionable task"}` | сессия завершается | `+ unactionable U`; `R→U` |

`decline` принимается только на свежем запросе. Провал команды — не `stop`: докса продолжает
работу в том же состоянии, добавляет пункты и проверяет снова.

### 5.2 Провал Verification: `revert` и возврат

Провал приёмки не закрывает Verification сам — её закрывает `stop` доксы. На переходе
`Verification → Patch` движок:

1. записывает `revert` для последнего Patch (файлы возвращаются к состоянию до правки, версии
   обновляются);
2. добавляет новое состояние к запросу как ещё один шаг;
3. оставляет провал в `Finish`-строках закрытых `Patch`/`Verification` (буквальный `stop.why`).

План провалившегося состояния из ленты убран; отдельного блока `Previous failed attempt` нет.
Если откат невозможен (`write`/`apply_patch` без preimage), изменение остаётся в файлах — это
известный пробел.

### 5.3 Таймаут

| Ход | Состояние | Предложение | Лента | Факт |
|---|---|---|---|---|
| 1 | V working | `bash {command:"make test", timeout:60000}` | `tool` с `{command, error:"… timed out…"}` | нет `exitCode`; вердикта нет |
| 2 | V working | повтор той же команды | новый `tool` | таймаут не принёс знания |

`exitCode` — сигнал «прошло/нет», но не гейт. Если его нет, состояние остаётся открытым, и
команду можно повторить. Запуск никогда не закрывает состояние.

### 5.4 Мир, версии и адресация

| Ход | Предложение | Лента | Факт |
|---|---|---|---|
| r | `read src/parse.py [10-80]` | `tool` с окном | `observed(file)=v1` |
| e | `edit src/parse.py` | `tool mutated <path>` | `currentVersion=v2`; чтение `v1` устарело |
| v | `stop` → `move` после провала | провал в `Finish`-строках | `revert` вернул версии |
| q | `recall {id:"obs:…"}` | тело приходит временным `tool` | узел не создаётся |

Актуальность вычисляется по версии, а не хранится флагом. Устаревшее чтение не показывается
активным. `recall`/`search` доступны только в открытом состоянии.

## 6. Почему так и сколько это стоит

- **Состояния изолированы.** Модель работает с целью и материалом текущего состояния, а не со
  всем прошлым путём; закрытое состояние её не отвлекает.
- **Цель — в записи состояния.** `Done when` и требование закрыть состояние держат критерий
  на виду и не оставляют мусора в журнале.
- **Фокус немонотонен.** Лента — это вид, а не транскрипт. Смена фокуса убирает лишнее, но
  знание остаётся доступным по `id`.
- **Переходы стоят денег.** Промах кэша префикса (предзаполнение), лишний ход на переход и
  рассуждения на переосмысление. Последняя часть переменная и показывает качество спеки
  состояния. Подробнее — `docs/ru/projection.md` §8. Считать надо цену результата
  (₽ на задачу, ходы на задачу), а не цену перехода. Шум провайдера (разные субподрядчики,
  ходы без рассуждений) — статистическая флуктуация, а не свойство дизайна.

Что показывает пример:

1. Контекст — проекция, а не переписка. Лента собирается заново каждый ход.
2. Состояние — единица работы: цель, критерий, поведение и набор инструментов.
3. Закрывает состояние только `stop` доксы; проверки критерия нет.
4. После закрытия в ленте остаются только `Start`/`Finish`, а данные — в IR.
5. `Finish`-строка — след состояния и передача следующему.
6. Хвост удерживает цель, а не хранит её.
7. Рассуждения доксы возвращаются на ленту, но сырой `thought` не хранится.
8. Всё адресуемо: закрытое не видно, но достаётся по `id`.
