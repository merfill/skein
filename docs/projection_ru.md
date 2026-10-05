# Skein — проекция состояния в контекст (спецификация)

> Английское зеркало — `docs/projection.md`.

Связанные: `docs/ir_semantics_ru.md` (§2.8 — негатив/сводка, §8 — место проекции),
`docs/ir_ru.md` (as-built), `docs/tools_ru.md` (контракт инструментов),
`docs/fix_ocaml_gc_run_report_ru.md` (контрпример по контексту).

Это источник истины о **составе** проекции. Код (`src/ir/project.ts`) следует за
ним. Правка проекции: сперва здесь, затем код, затем тест.

## 1. Назначение

Проекция — это **контекст для следующего оператора**, а не дамп состояния. Для
модели проекция — **вся её память**: чего в ней нет, того модель не знает.

Долговременная память — **дерево** (запрос, цели с `what`/`why`/`done_when`,
план и состояния пунктов, альтернативы, закрытия). Результаты инструментов —
**не дерево**: полностью показывается только последний, а предыдущие сводятся к
сигнатурам.

**Принцип:** показывается **ветка обхода** плюс ровно шесть вещей, без которых
оператор не решает:

1. **`path`** — стек: `request → выбранная интерпретация → … → текущий узел`;
2. **контейнеры узлов пути** — их `plan` (пункты + состояния) и `alternatives`
   (интерпретации/варианты + `chosen`) — это то, на что опираются `create_goal`,
   `revises`, `apply`, `complete`/проверка;
3. **`constraints`** — глобальны, нарушать нельзя;
4. **`lastResult`** — **полный** результат последнего вызова (в пределах честно
   объявленных лимитов инструмента), чтобы принять следующее решение;
5. **`shown`** — **рабочее множество**: результаты, запрошенные через `need`/`query`,
   полностью, с TTL (§8 `docs/context_design_ru.md`);
6. **`calls`** — дедуплицированная **сводка предыдущих вызовов без результатов**:
   что вызвано, статус (`ok`/`fail`/`refused`) и причина. Даёт память о том, что уже
   делалось, не раздувая контекст (инвариант 21, §2.8 семантики).

Всё остальное вне ветки **не показывается по умолчанию** и достаётся по `query`.

## 2. Что входит

```
Projection = {
  path:        PathNode[],        // стек, верх — фокус
  constraints: { id, forbid[] }[],
  lastResult?: ResultView,        // полный результат последнего вызова
  shown:       ResultView[],      // результаты, удержанные по `need` (гипотеза)
  calls:       Call[],            // сводка предыдущих (может быть пуст)
  applicable:  string[],          // имена применимых операторов
  checkReady:  boolean,           // сейчас ожидается run {target: фокус} = check
  nextAction?: string,            // action-пункт, на который указывает курсор плана
  budget:      { turn, maxTurns, remaining }
}

PathNode = {
  id, kind: "request" | "goal",
  state,
  text?,                    // request
  what?, why?, done_when?,  // goal
  plan?:         { cursor?, items: Item[] },   // собственный план узла
  alternatives?: { chosen?, items: Alt[] }     // собственный контейнер узла
}

Item = { id, kind: "goal" | "action", label, state, why? }
Alt  = { id, label, state, chosen: boolean, why? }

ResultView = {                 // вид, а не узел
  id, kind: "observation" | "check" | "action",
  command?,                    // run / check
  ref?,                        // read / edit — тронутый файл
  verdict?,                    // check
  label?,                      // action
  output?,                     // stdout последнего вызова (не склеен со stderr)
  error?                       // stderr, отдельно; главный сигнал сбоя
}

Call = {                       // агрегат, а не событие
  id?: string,                 // адрес последнего результата (для `need`)
  action: string,              // read f [1-100]; grep sweep 5/5; run make; tool target
  status: "ok" | "fail" | "refused",
  note?: string,               // fail/refused: причина (последняя строка вывода / reason)
  count: number                // число повторов с той же сигнатурой (≥1)
}
```

- `path[last]` — фокус; отдельного `focus` нет.
- У `request` нет `plan`/`done_when`; его интерпретации — в `alternatives`.
- У `goal` может быть `plan`, `alternatives` или ничего.
- Пункт `plan`/`alternatives` несёт `why?`: для `refuted`/`abandoned` это провалившаяся
  гипотеза, чтобы следующая попытка её не повторяла.
- `applicable` перечисляет имена операторов; `checkReady` говорит, ожидается ли сейчас
  **check** (`run {target: path[last]}`) — это объективная цель с выполненным планом.
  `apply` может быть в списке при `checkReady: false`: тогда доступен голый
  исследовательский `run`, а не проверка фокуса; проверка возможна только по
  **объективной** цели (субъективная цель отклоняется).
- `nextAction`, если есть, — action-пункт, на который указывает курсор плана: применяй
  его дословно.
- `lastResult.output` — полный (не обрезается проекцией); лимиты задаёт сам
  инструмент и **объявляет** их в результате (см. `docs/tools_ru.md`).

## 3. Что не входит

- **`artifacts`** (список файлов) — нет. Файл — ссылка, нужен только как
  `ref`/`output` действия.
- **Версии файлов** — нет. Версия — деталь движка (`stale_base`); история версий
  модели не нужна.
- **`index.counts`** — нет.
- **`recent`** (лента ходов) — нет. Но **`calls`** — не лента: это
  дедуплицированный агрегат сигнатур, а не история каждого хода.
- **Сырые payload событий целиком** — нет: ни `witness` проверки, ни полное
  содержимое файла; результат показывается, только если его вернул инструмент
  (`lastResult`), а `calls` хранит одни сигнатуры.
- **Ветки вне стека** — нет; доступны по `query`.

### 3.1 Правила `calls`

- **Источники.** `refused` — из `record_rejection`; `ok`/`fail` — исполненные
  действия (`action` с произведённым `observation`/`check`), а также
  материализованные сбои без `action`-узла.
- **Дедуп и счёт.** Записи с равной `(status, action)` склеиваются, `count` растёт.
  Повторная неудача **не** создаёт знания.
- **Фокус.** Запись показывается, когда её фокус (узел в момент появления) лежит в
  **поддереве текущей выбранной интерпретации** **или на текущем `path`**. Путь
  включён потому, что корень-запрос — родитель этого поддерева: отказ, записанный при
  фокусе на запросе (например, отклонённая новая интерпретация), обязан быть виден,
  иначе проекция не меняется после отказа (инвариант 21).
- **Инвалидация.** Мутация после записи снимает `fail`/`refused` (в другом
  состоянии мира то же могло бы сработать). `ok` сохраняется как история.
  Исключение — отказы по ограничениям (`constraintId`).
- **Порядок.** Новейшие первыми.
- **`note`.** `refused` — `reason`; `fail` — самая информативная строка тела
  **stderr** (сигнал сбоя), иначе stdout: последняя строка, называющая крах
  (`segmentation`, `panic`, `traceback`, `assertion`, `fatal`, …), иначе последняя
  строка, называющая ошибку (`error`, `failed`, `cannot`, `no such file`, …), иначе
  последняя непустая строка; до ~120 символов.

## 4. Пределы

- **Общего бюджета контекста нет.** `SKEIN_CTX_TOTAL`/`SKEIN_CTX_EXCERPT` не
  применяются: инструмент честно возвращает результат в своих объявленных лимитах
  (`MAX_READ_LINES`, `MAX_GREP_MATCHES`, `MAX_RUN_OUTPUT`), а проекция его не режет.
- `SKEIN_CTX_ITEMS` ограничивает число элементов в `plan`/`alternatives` (20).
- Один и тот же журнал и параметры дают одну и ту же проекцию (§9‑4).
- Бюджет **ходов** (`budget.turn/maxTurns/remaining`) — не про символы; остаётся.

## 5. Операторы и что им нужно

| Оператор | Что читает в проекции |
|---|---|
| `create goal` | `path` (фокус, его `done_when`), `alternatives` фокуса (для `revises`), `constraints`, `calls` (не повторять провал) |
| `apply` (read/grep/edit/run) | `path` (текущая цель), `lastResult` (решение), `calls` (что уже пробовал), `constraints` |
| `complete` | `path` (фокус, его `done_when`) |
| проверка (`apply run { target }`) | `path` + объективный `done_when` цели |
| `query` | адресация: достаёт любой узел/ребро по id/kind/predicate |

## 6. Пример: off-by-one, ход за ходом

Запрос: «make `node --test` pass; do not edit tests». Ограничение `k1`.

**Ход 0 — только запрос.**
```json
{ "path": [ { "id": "r1", "kind": "request", "state": "open",
              "text": "make node --test pass; do not edit tests" } ],
  "constraints": [ { "id": "k1", "forbid": ["\\.test\\.mjs$"] } ],
  "calls": [],
  "applicable": ["create_goal"],
  "budget": { "turn": 0, "maxTurns": 24, "remaining": 24 } }
```

**Ход 1 — `create_goal` интерпретация `g1` с планом; фокус спустился в `g2`.**
```json
{ "path": [
    { "id": "r1", "kind": "request", "state": "open",
      "text": "make node --test pass; do not edit tests" },
    { "id": "g1", "kind": "goal", "state": "open",
      "what": "make the suite pass",
      "done_when": { "kind": "objective", "command": "node --test" },
      "plan": { "cursor": 0, "items": [
        { "id": "g2", "kind": "goal",   "label": "reproduce",  "state": "open" },
        { "id": "g3", "kind": "goal",   "label": "locate+fix", "state": "open" },
        { "id": "g4", "kind": "goal",   "label": "verify",     "state": "open" } ] },
      "alternatives": { "chosen": "g1", "items": [
        { "id": "g1", "label": "make the suite pass", "state": "open", "chosen": true } ] } },
    { "id": "g2", "kind": "goal", "state": "open",
      "what": "reproduce", "done_when": { "kind": "subjective", "text": "see it fail" } } ],
  "constraints": [ { "id": "k1", "forbid": ["\\.test\\.mjs$"] } ],
  "calls": [ { "action": "run make test", "status": "ok", "count": 1 } ],
  "applicable": ["apply", "create_goal"],
  "budget": { "turn": 1, "maxTurns": 24, "remaining": 23 } }
```

**Ход 2 — `apply run node --test`; результат показан полностью; предыдущий вызов ушёл в `calls`.**
```json
"lastResult": { "id": "obs:12", "kind": "observation", "command": "node --test",
                "verdict": "fail", "output": "not ok 1 - sumTo(5) is 15\n…" },
"calls": [ { "action": "run make test", "status": "ok", "count": 1 } ]
```
Заметь: полный вывод, без версий и `witness`.

**Ход 3 — `read src/sum.mjs [1-400]`; окно кода показано целиком.**
```json
"lastResult": { "id": "obs:14", "kind": "observation", "ref": "src/sum.mjs",
                "output": "export function sumTo(n) {\n  let total = 0;\n  …" },
"calls": [
  { "action": "run node --test", "status": "fail", "note": "not ok 1", "count": 1 },
  { "action": "run make test",   "status": "ok", "count": 1 } ]
```

**Ход 4 — `edit src/sum.mjs`; содержимое уже не нужно, нужен факт правки.**
```json
"lastResult": { "id": "act:16", "kind": "action", "ref": "src/sum.mjs",
                "label": "edit src/sum.mjs" }
```

**Ход 5 — проверка цели `g1`; witness не показывается.**
```json
"lastResult": { "id": "chk:18", "kind": "check", "command": "node --test", "verdict": "pass" }
```
После этого `g1` — `achieved`, запрос `addressed`, цикл останавливается
(`request_addressed`).

Обрати внимание: ни в одном ходу нет списка файлов, версий, `index` или ленты;
файл появляется как `ref`/`output` тронувшего его действия либо как сигнатура в
`calls`.

## 7. Контрпример: fix-ocaml-gc

В прогоне `~/.skein-bench/harbor/2026-10-03__11-00-06` контекст скакал
`37k → 802k → 35k` и снова `803k`. Причина: `frontier.lastResult` отдавал узел
`check` **целиком**, а в его payload лежал `witness` — по версии **на каждый файл
воркспейса** (~7000 записей ≈ 767k символов). Как только появлялся более свежий
результат (`read`), скачок пропадал.

Правильная проекция на том же ходу:
```json
"lastResult": { "id": "chk:536", "kind": "check",
                "command": "cd /app/ocaml && make", "verdict": "pass" }
```
Witness целиком — только по `query`, если докса специально спросит.

## 8. Границы и открытые вопросы

- **Статические части в системный промпт.** `request.text` и `fragment` не
  меняются ход от хода; их выгодно держать в системном промпте (стабильный
  префикс для кэша). Решение — отдельно.
- **Точность свидетеля.** Спека не отменяет задачу сузить `witness` у источника;
  проекция лишь перестаёт его инлайнить.
- **Возврат бюджета.** Если контекст снова станет проблемой — решим, в каком виде
  (сейчас не применяется).
