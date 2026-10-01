# Skein — IR: операции, состояние и управление

> Английское зеркало — `docs/ir.md`.

Концептуальный обзор — `docs/concepts.md`. Этот документ смотрит на ту же
систему со стороны IR: какие операции он фиксирует, что каждая операция делает
с состоянием, как состояние становится контекстом и как этот контекст управляет
агентом.

## 1. Четыре уровня

IR — это не один объект, а конвейер из четырёх уровней:

```
                 append-only              pure            pure
  действия ─▶ журнал (Event[]) ──fold──▶ State ──project──▶ Context ──▶ LLM
     ▲                                                             │
     └──────────────── предложение (одно действие за ход) ◀────────┘
```

1. **Журнал** — `Event[]`, append-only. Это истина. Ничего не удаляется и не
   переписывается (`src/ir/events.ts`).
2. **State** — `fold(events)`, производное представление в памяти: узлы, рёбра,
   статусы, чеки (`src/ir/graph.ts`).
3. **Context** — `project(state)`, детерминированный срез для LLM
   (`src/ir/project.ts`).
4. **Лента сообщений** — диалог с LLM. Только I/O: системный промпт плюс текущий
   `Context`. Это не память.

Ключевая инверсия: **контекст — проекция IR, а не расшифровка истории**. LLM не
видит предыдущие проекции, только текущее состояние. Журнал растёт, `State`
пересчитывается из него, `Context` — из `State`. Ничто не «запоминается»
накоплением.

Перед `project` движок сверяет факты, от которых зависит текущая активность, с
файловой системой (`src/loop/observe.ts`): замеченный дрейф становится событием
`mutate`, поэтому изменение, сделанное вне движка, всё равно фиксируется с
источником.

Везде действует разделение докса/логос: LLM (докса) только предлагает; каждое
предложение — `provenance.kind = "llm"`, `status = "open"`. Движок (логос)
классифицирует и исполняет, и только арбитр может повысить claim.

## 2. Операции, которые фиксирует IR

У IR **закрытый словарь**. Изменить его можно, только дописав одно из шести
событий (`src/ir/events.ts`):

| Событие | Смысл |
|---|---|
| `add_node` | ввести узел (любой kind, любое пространство) |
| `add_edge` | ввести типизированное ребро с provenance |
| `set_status` | сменить статус узла или ребра (без причины) |
| `mutate` | файл `ref` изменился до версии `version` (крючок немонотонности) |
| `record_check` | арбитр выполнил `command` с вердиктом для `claimIds` |
| `record_rejection` | врата отказали предложенному действию (`tool`, `target`, `reason`) |

Узлы и рёбра типизированы закрытыми enum-ами (`src/ir/types.ts`). У узла есть
`space` (`work` | `artifact`), `kind`, однострочный `label`, необязательный
`payload` и `seq`. У ребра есть `provenance` — *откуда известно*: `llm`, `user`,
`read` (с `version` файла), `grep`, `check`.

Словарь — это протокол. Новое поведение — это новое событие или новое правило
проекции, но никогда — правка `State` в обход. Так держится первый принцип
(`docs/concepts_ru.md`): состояние меняется только через события, поэтому каждое
знание прослеживается до породившего его опыта.

### Инструмент → события

Инструменты и собственные шаги движка — единственные производители событий
(`src/tools/index.ts`, `src/loop/graph.ts`, `src/loop/observe.ts`). Что
фиксирует каждый:

| Инструмент | Пишет события | Результат в состоянии |
|---|---|---|
| seed (`runAgent`) | `add_node` goal; `add_node` constraint на входе | `g1` open; `k*` `must` |
| `read(path)` | `add_node` file (в первый раз) + `add_node` observation + `add_edge` `locates` (`provenance.read` + `version`) | артефакт-факт, привязанный к версии файла |
| `grep(pattern)` | `add_node` observation | одноразовое наблюдение (содержимое эфемерно) |
| `edit(path, find, replace)` | `add_node` action + `mutate` | action `applied`; прежние факты чтения помечаются `stale` («устаревшими») |
| `run(command, claims?)` | `add_node` observation + `record_check` + `add_edge` `verifies` на каждый claim, каждое со свидетельством (`ref → version`, снятым при прогоне); при длинном выводе — спил и `outputRef`; `mutate` на каждый отслеживаемый файл, который изменила команда | claims `verified`/`refuted` по арбитру |
| `run` (гард constraint) | `add_node` observation `constraint violation` | запрещённый файл откатывается; **без** `record_check` |
| `classify` (врата логоса) | `record_rejection` при отказе | `RejectionRecord` в `state.rejections` (без узла) |
| `track(kind, label, …)` | `add_node` claim/decision/constraint | `open` / `active` / `must` |
| `query(selectors)` | ничего | одноразовый ответ (`id`/`kind`/`status`/`edgesOf`/`verdictOf`), ничего не фиксируется |
| `finish(summary)` | `add_node` action | цикл останавливается (`stopReason = "finish"`) |

Четыре следствия, которые стоит сказать прямо:

- **Содержимое не хранится в IR.** Вывод `read`/`grep`/`run` живёт в эфемерных
  ходах `recent` (`Turn`), но не в payload узла. Артефакты — указатели плюс одна
  строка.
- **Длинный вывод — за пределами IR.** Если вывод `run` превышает лимит выдержки,
  он целиком пишется в `.skein/logs/`, а в IR остаётся `outputRef` и выдержка
  head+tail; достаётся оконным `read`.
- **Только арбитр верифицирует.** `verified` достижим только через
  `record_check` с `verdict = "pass"` (`src/ir/graph.ts:109`). Проверка несёт
  версии файлов, которые наблюдала, поэтому поздний `mutate` может её
  обесценить — но выдумать вердикт не может.
- **Отказ фиксируется, а не просто показывается.** Когда врата отвергают
  предложение, движок пишет `record_rejection` с сигнатурой действия (`tool`,
  `target`, `reason`, необязательный `constraintId`) в `state.rejections`; узел
  не создаётся, полное предложение не хранится.

### Что объявлено в Tier 0, но пока не производится

Модель шире текущего поведения. Объявлено в `types.ts`, но в Tier 0 не пишется:

- kinds узлов `subgoal`, `symbol`, `test`;
- виды рёбер кроме `locates` и `verifies`;
- событие `set_status` (смена статуса сейчас всегда побочный эффект
  `record_check` или `mutate`, не явное событие);
- статусы `superseded`, `achieved`, `abandoned`, `confirmed`, `reverted`.

Это зарезервировано, а не мёртво: проекция уже понимает `refuted`/`superseded`
(`src/ir/project.ts:114`). Документ держит это различие, чтобы спецификация не
обещала больше, чем реализовано.

## 3. Переходы статусов

Статусы **производные**, их не ставят руками:

- `add_node` назначает дефолт по kind (`src/ir/graph.ts:33`): `open` для
  goals/claims/observations, `active` для decisions, `applied` для actions,
  `must` для constraints, `believed` для артефактов.
- `record_check` переводит каждый названный claim в `verified` (pass) или
  `refuted` (fail) (`src/ir/graph.ts:119`).
- `mutate` помечает `stale` («устаревшими») и рёбра чтения с тем же `ref` и
  другой `version`, и рёбра `verifies`, в чьём свидетельстве есть изменившийся
  `ref` с другой `version` (`src/ir/graph.ts:89`). Прежние события не трогаются;
  меняется лишь их **производный статус**.

Так журнал остаётся монотонным, а знание о коде — немонотонным. Ручного отката
нет: факт о старой версии файла просто перестаёт быть активным.

**Производный** статус — не запись. `fold` заново строит `statuses` и
`edgeStatuses` из журнала при каждом вызове, поэтому смена статуса — например,
пометка ребра `stale` — перезаписывает вычисленное значение, а не историю.
Исходные поля `add_edge` / `record_check` остаются в журнале, и воспроизведение
событий даёт прежний статус. Монотонной записью является только журнал: он лишь
растёт, и лишь производный вид теряет силу. Исходный факт не переписывается
никогда.

## 4. Проекция: как состояние становится контекстом

`project(state)` (`src/ir/project.ts:75`) чист и детерминирован: одни и те же
события всегда дают один `Context`. У него фиксированные секции:

- `header` — цель и все constraints (стабильный префикс);
- `frontier` — `claims` (`open`), `decisions` (`active`), последнее действие,
  последнее наблюдение на каждый активный claim, подтверждённое /
  инвалидированное / отвергнутое одной строкой каждое, а также `refusals` —
  действия, которые врата уже отклонили, схлопнутые по сигнатуре со счётчиком
  повторов. Подтверждённое утверждение, у которого все проверки устарели,
  попадает в `invalidated`, но никогда в `verified`;
- `artifacts` — только индекс (id + label + флаг `stale` («устарел»));
- `index` — ограниченная сводка: `counts` по видам плюс новейшие `tail` узлов как
  `{ id, kind, label }`; полный список достаётся через `query`;
- `recent` — последние ходы дословно, для связности.

Гарантия — адресуемость: каждый узел либо показан, либо доставаем через `query`,
поэтому ограничение `index` никогда не делает узел неназываемым.

Релевантность — **по происхождению, а не по похожести**: активно то, что лежит на
пути от открытой цели через активные решения/действия к открытым claims. Индекс
присутствует всегда, поэтому агент видит, что нечто существует, и может
запросить это, даже когда содержимого нет в контексте.

Что сознательно отсутствует: содержимое файлов, устаревшие факты в виде активного
содержимого и предыдущие проекции. Устаревший артефакт показывается как
устаревший, никогда как текущий (инварианты `docs/plans/tier0_plan_ru.md` §6).

## 5. Как IR управляет агентом

Управление — не отдельный слой, а прямое чтение `State`:

- **Что видит LLM.** `propose` отправляет ровно текущий `Context`
  (`src/loop/propose.ts:33`). Меняешь проекцию — меняешь поведение.
- **Врата логоса.** `classify` читает constraints из `State` и отклоняет `edit`
  по запрещённому пути (`src/loop/classify.ts`).
- **Эффект-гард.** Перед `run` движок снимает снапшот файлов, подпадающих под
  `payload.forbid`; если команда изменила такой файл, он откатывается и
  записывается как `constraint violation`, а чек не пишется — значит, ничто не
  верифицируется (`src/tools/index.ts:295`). Запрет держится по эффекту, а не
  разбором shell.
- **Наблюдение перед проекцией.** В начале хода движок сверяет `ref`, от которых
  зависит текущая активность (свидетели живых проверок и живые факты чтения), с
  файловой системой (`src/loop/observe.ts`); дрейф становится `mutate`, поэтому
  ничего релевантного не строится на ненаблюдённом изменении. Кэш отпечатков
  `mtime`/`ctime`/размер избавляет от повторного хэширования файлов, чей
  отпечаток не изменился (`docs/plans/watcher_plan_ru.md`).
- **Истина только от арбитра.** Ни один путь к `verified` не минует
  `record_check`.
- **Бюджеты и стоп.** Цикл маршрутизируется по `done`, лимиту ходов и
  `stopReason` (`src/loop/graph.ts:86`). Бюджет — часть контекста
  (`header.budget`: `turn` / `maxTurns` / `remaining`), чтобы модель могла
  планировать; бухгалтерии токенов сознательно нет.
- **Закрытие цели — извне.** Движок не ставит цели `achieved`; харнесс/арбитр
  проверяет, что тесты проходят и запрещённые файлы не изменены
  (`tests/gate.test.ts`). Узел цели остаётся `open` даже после успешного прогона
  (`tests/loop.test.ts`).

## 6. Примеры

Id и `seq` ниже — иллюстративные; формы и поля совпадают с кодом.

### A. Починка, ход за ходом (`fixtures/bugfix/off-by-one`)

Seed (`src/loop/graph.ts:107`):

```json
{ "type": "add_node", "node": { "id": "g1", "space": "work", "kind": "goal",
  "label": "make node --test pass", "seq": 0 } }
{ "type": "add_node", "node": { "id": "k1", "space": "work", "kind": "constraint",
  "label": "do not edit tests", "payload": { "forbid": ["\\.test\\.mjs$"] }, "seq": 1 } }
```

Ход 1 — `read src/sum.mjs` фиксирует артефакт-факт, привязанный к версии:

```json
{ "type": "add_node", "node": { "id": "file:src/sum.mjs", "space": "artifact",
  "kind": "file", "label": "src/sum.mjs" } }
{ "type": "add_node", "node": { "id": "obs:3", "space": "work", "kind": "observation",
  "label": "read src/sum.mjs",
  "payload": { "ref": "file:src/sum.mjs", "version": "<sha1>", "bytes": <n> } } }
{ "type": "add_edge", "edge": { "id": "e:4", "from": "file:src/sum.mjs", "to": "obs:3",
  "kind": "locates", "provenance": { "kind": "read", "ref": "file:src/sum.mjs",
  "version": "<sha1>" }, "status": "believed" } }
```

Ход 2 — `track` гипотезы (докса входит со `open`):

```json
{ "type": "add_node", "node": { "id": "w:claim:5", "space": "work", "kind": "claim",
  "label": "loop stops one short", "payload": { "rationale": "" } } }
```

Ход 3 — `edit src/sum.mjs` мутирует мир:

```json
{ "type": "add_node", "node": { "id": "act:6", "space": "work", "kind": "action",
  "label": "edit src/sum.mjs",
  "payload": { "path": "src/sum.mjs", "find": "i < n", "replace": "i <= n" } } }
{ "type": "mutate", "ref": "file:src/sum.mjs", "version": "<new sha1>", "actionId": "act:6" }
```

`mutate` помечает `e:4` как `stale` («устаревшее») — старое чтение больше не активно. Журнал не
меняется; сдвинулся производный статус.

Ход 4 — `run node --test` отдаёт решение арбитру:

```json
{ "type": "add_node", "node": { "id": "obs:8", "space": "work", "kind": "observation",
  "label": "run node --test",
  "payload": { "code": 0, "verdict": "pass",
    "witness": [ { "ref": "file:src/sum.mjs", "version": "<new sha1>" } ] } } }
{ "type": "record_check", "command": "node --test", "verdict": "pass",
  "output": "…",
  "witness": [ { "ref": "file:src/sum.mjs", "version": "<new sha1>" } ],
  "claimIds": ["w:claim:5"] }
{ "type": "add_edge", "edge": { "id": "e:9", "from": "obs:8", "to": "w:claim:5",
  "kind": "verifies",
  "provenance": { "kind": "check", "command": "node --test", "verdict": "pass",
    "witness": [ { "ref": "file:src/sum.mjs", "version": "<new sha1>" } ] },
  "status": "open" } }
```

`record_check` переводит `w:claim:5` в `verified`.

Ход 5 — `finish` фиксирует одно действие и останавливает цикл.

Проекция после хода 4 примерно такая:

```json
{
  "header": { "goal": { "id": "g1", "label": "make node --test pass" },
              "constraints": [ { "id": "k1" } ],
              "budget": { "turn": 4, "maxTurns": 24, "remaining": 20 } },
  "frontier": { "claims": [], "decisions": [], "lastAction": { "id": "act:6" },
                "observations": [], "verified": ["w:claim:5: loop stops one short"],
                "invalidated": [], "rejected": [], "refusals": [] },
  "artifacts": [ { "id": "file:src/sum.mjs", "label": "src/sum.mjs", "stale": true } ],
  "index": {
    "counts": { "goal": 1, "constraint": 1, "file": 1, "observation": 2, "claim": 1, "action": 1 },
    "recent": [ /* новейшие tail узлов как { id, kind, label } */ ]
  },
  "recent": [ /* последние ходы */ ]
}
```

Верифицированный claim ушёл из `frontier.claims` и теперь виден в
`frontier.verified`; артефакт показан, но помечен `stale` («устаревшим»), потому что его
последнее чтение старше правки.

### B. Запрещённое изменение через `run`

Вместо `edit` LLM запускает `printf '15\n' > test/sum.test.mjs`. Движок
(`src/tools/index.ts:295`):

1. снимает снапшот каждого файла под `\.test\.mjs$` (содержимое теста);
2. выполняет команду;
3. видит, что файл изменился, возвращает снапшот и добавляет:

```json
{ "type": "add_node", "node": { "id": "obs:7", "space": "work", "kind": "observation",
  "label": "constraint violation (\\.test\\.mjs$): reverted test/sum.test.mjs",
  "payload": { "pattern": "\\.test\\.mjs$", "paths": ["test/sum.test.mjs"],
  "reverted": true } } }
```

`record_check` не пишется, поэтому ни один claim не становится `verified`.
Shell-строка не разбирается; запрет держится по эффекту.

### C. Монотонность в одной строке

`mutate` не удаляет прежний `read`; он лишь переключает производный статус ребра:

```
e:4  locates  file:src/sum.mjs → obs:3   believed → stale
```

Воспроизведи те же события — получишь тот же `State` и тот же `Context`. Код
изменчив; журнал — нет.

### D. Отказ через врата

LLM предлагает `edit test/sum.test.mjs`; врата отказывают *до* любого исполнения.
Движок дописывает:

```json
{ "type": "record_rejection", "tool": "edit", "target": "test/sum.test.mjs",
  "reason": "constraint_violation:\\.test\\.mjs$", "constraintId": "k1", "turn": 3 }
```

Узел не создаётся, но проекция теперь несёт его:

```json
"refusals": ["edit test/sum.test.mjs — constraint_violation:\\.test\\.mjs$ (k1)"]
```

Следующая проекция пересобирает это из состояния, поэтому отказ переживает
вытеснение из хвоста `recent` и реплей; повтор схлопывается в одну строку с `×2`.

## 7. Инварианты и границы Tier 0

Гарантируется IR и проверяется тестами (`tests/invariants.ts`,
`tests/gate.test.ts`):

- claim становится `verified` только с `check`-provenance;
- устаревший факт (`stale`) никогда не подаётся как активное содержимое;
- отклонённое предложение фиксируется с причиной (`record_rejection`) и никогда
  не хранится как вера;
- адресуемость: каждый узел показан или доставаем через `query`;
- `project` детерминирован: одни события → один `Context`;
- докса только предлагает (`status = open`); логос решает.

Сознательно вне Tier 0: содержимое файлов в IR, явное событие `set_status`,
узлы `subgoal`/`symbol`/`test`, неиспользуемые виды рёбер, закрытие цели внутри
движка и shell-песочница (гард для `run` — пост-фактум, с откатом).
