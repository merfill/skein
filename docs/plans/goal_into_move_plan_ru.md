# Skein — план «цель внутрь move» (состояние несёт свою цель)

> Русское зеркало `docs/plans/goal_into_move_plan.md`.
> Статус: **согласовано с владельцем (2026-10-13); идёт реализация.** Узел `goal` и оператор
> `create_goal` удаляются; состояние (`move`) несёт свой текст цели и владеет планом.
> Документ самодостаточен: работу можно продолжить по нему после сброса контекста.

## 0. Как читать

§1 — доказательство. §2 — согласованная концепция. §3 фиксирует прогулку (операторы,
ситуации, тул-сеты). §4–§6 — изменения IR / движка / проекции. §7 — порядок фаз, §8 — тесты,
§9 — доки, §10 — риски. Открытого нет: дальнейшие правки идут обычным semantics-first путём.

## 1. Почему — доказательство

Живой прогон `fix-ocaml-gc` на прошлой схеме (узел цели + `create_goal`), 2026-10-13:

| прогон | reward | stop | ходов | что произошло |
|---|---|---|---|---|
| net on | 0 | `no_progress` | 46 | после `stop` на t26 доxa 19 ходов чередовала `create_goal`/`apply` |

Из трейса (`bench/runs/sandbox-tasks/2026-10-13T08-15-40-551Z-fix-ocaml-gc`):

- за весь прогон **одна** смена состояния (t0, `move` → reconnaissance) и **одно** закрытие
  цели (t26, `stop`); reconnaissance переработано (relief — «at most two rounds», критерий
  достигнут ~t6, `stop` только на t26);
- после `stop` состояние было завершено — но `create_goal` всё ещё предлагался, доxa вызвала
  его, получила `state_finished` и чередовала `create_goal`/`apply` до конца бюджета. Реплей
  пост-`stop` контекста: **5/5 `create_goal`** на полном реестре против **5/5 `move`**, когда
  поверхность сужена до фронта.

Корень: цель была **отдельным узлом** со своим оператором, поэтому «состояние завершено» и
«начать его работу» — разные вещи, и поверхность продолжала предлагать второе после того, как
первое улажено. Лечение — сделать состояние своей же целью.

## 2. Концепция (согласовано)

**Состояние — это цель.** `move` объявляет и фазу (остров), и конкретный исход фазы (`what`);
план вешается прямо на `move`. Узла `goal` и оператора `create_goal` нет.

Две фазы остаются **разными вызовами с разными контекстами и тул-сетами** (согласовано):

1. **Переход** (`request` / завершённое состояние): доxa выбирает следующее состояние —
   предложен только `move` (и `decline` на request).
2. **Конкретизация** (только что вошли в состояние): **второй** вызов LLM даёт первый пункт
   плана. Отдельного оператора нет — первый обычный `apply` создаёт план и его первый пункт.
   `move` и конкретизация никогда не в одном ходу.

То есть текст цели приходит с `move`, а первое действие плана — сразу за ним, как обычный
вызов инструмента.

## 3. Прогулка (фиксировано)

Операторы: `move { state, what, note? }`, `apply`, `stop`, `decline`, и read-only
`recall` / `search`. `create_goal` нет; `what` обязателен, кроме `handoff`.

| ситуация | фокус | инструменты | промт |
|---|---|---|---|
| `request` | запрос | `move`, `decline` (+recall/search) | выбери первое состояние или decline |
| `plan` | `move`, план пуст | apply-набор, `stop` (+recall/search) | дай первый пункт плана |
| `working` | `move`, есть пункты | apply-набор, `stop` (+recall/search) | продолжай / stop |
| `transition` | завершённый `move` | `move` (+recall/search) | выбери следующее состояние |
| `terminal` | `move`=`handoff` | `stop` (+recall/search) | stop, чтобы завершить запрос |

Поверхность И ЕСТЬ фронт (`applicable`), поэтому недопустимый ход никогда не предлагается —
цикл после `stop` невозможен по построению, а не по тексту промта.

Цепочка:

```
request ─move{state,what}▶ state(plan) ─первый apply▶ state(working) ─apply▶ …
state(working) ─stop▶ state(transition) ─move{state,what}▶ …   handoff ─stop▶ конец
```

## 4. Изменения IR

- `WORK_KINDS`: убрать `goal`. `EDGE_KINDS`: убрать `goal`.
- `MovePayload`: добавить `what: string` (текст цели состояния); оставить `state`, `note`.
  Удалить `GoalPayload`.
- Рёбра `plan`/`items`/`alts`/`stop` висят на `move`.
- Traversal: убрать `goalOf`; `isMoveFinished(state, move) = hasStopped(state, move)`;
  `stopOf(state, move)`; `desiredPath = [request, move?]`; `applicable` по §3.
- `Applicable`: убрать `createGoal`; оставить `move`, `apply`, `stop`, `decline` (+ `return`).
- `Context.situation`: `request | plan | working | transition | terminal` (было
  `request | move | goal | transition | terminal`).
- `Context.applicable`: фронт, по нему биндятся предлагаемые инструменты (поле уже добавлено
  в рамках правки поверхности; `createGoal` убрать).

## 5. Движок / classify

- `tools/index.ts`: убрать `buildGoal` и ветку `create_goal`; `buildMove` пишет `what`; ветка
  `move` добавляет только узел move + ребро `move` (без плана/seed). `ensurePlan(moveId)`,
  `buildItem(moveId)`, `placeMove(moveId, …)`. `stop` на открытом не-терминальном `move`
  закрывает его (далее переход); на терминальном `move` — завершает запрос.
- `classify.ts`: убрать ветку `create_goal` и её причины (`no_state` / `state_worked` /
  `state_finished` / `terminal`). `move` валидирует непустой `what` (`empty_what`), кроме
  `handoff`; допустим на request или на завершённом `move`, иначе `state_open`. `apply` и
  `stop` требуют открытого (не-терминального) `move`; `stop` также принимает терминальный
  `move`.

## 6. Проекция / промт

- `project.ts`: `situationOf` по §3; `renderState` рисует вызов `move` (с `what`) +
  подтверждение, затем план (`plan`/`working`) или строку закрытия для текущего завершённого
  состояния; оставленное завершённое состояние — одна строка компакции.
  `observationInstruction` берёт цель из `move.what` (напоминание сохраняет
  `State`/`Goal`/`Done when`/`Constraints` в позиции максимальной свежести).
- `prompt/blocks.ts`: ключи `NODE_INSTRUCTIONS` — пять ситуаций; текст прогулки (`B4`) без
  `create_goal`; блок `plan` — «дай первый пункт плана»; блок `working` — «продолжай / stop»;
  `transition` и `terminal` — по смыслу как прежде.
- `llm/schemas.ts` + `llm/tools.ts`: убрать оператор/тул `create_goal` и вложенный
  `goalActionParams`; `move` получает `what`; `toolNamesFor` без `createGoal`.

## 7. Порядок фаз

0. Этот план (EN + RU).
1. IR types/graph/traversal.
2. Движок (`tools/index.ts`).
3. Classify.
4. Проекция + промт + schemas/tools.
5. Тесты (ops, traversal, classify, tape, prompt, islands, coverage, live-харнесс).
6. Доки (semantics, operations, ir, projection, system_prompt, concepts, tools, plans,
   инвариант в `AGENTS.md`) + `_ru`.
7. `npm run typecheck` + офлайн-сьют зелёные.
8. Живые синтетические шаговые тесты под случаи (по ок владельца).

Каждая фаза оставляет `tsc` и офлайн-сьют зелёными.

## 8. Тесты

- `tests/ops/create_goal.test.ts` растворяется в `tests/ops/move.test.ts` (move несёт `what`,
  плана нет до первого `apply`) и `tests/ops/apply.test.ts` (первый `apply` создаёт план +
  первый пункт).
- `applicable` / `traversal` / `ir` / `islands` / `ir_properties` / `coverage`: убрать `goal`
  и `create_goal`; добавить пять ситуаций и фронт.
- `tape` / `tape_render` / `tape_contract` / `messages` / `prompt`: вызов move несёт `what`;
  пары `create_goal` нет.
- Loop / stop / decline / workingset: фокус — `move`.
- Живые шаговые тесты (`state_transitions_step`, `ir_operations_step`, `fix_ocaml_step`) +
  sandbox-раннер: обновить словарь операторов.

## 9. Доки / инварианты

`docs/ir_semantics{,_ru}.md`, `ir_operations{,_ru}.md`, `ir{,_ru}.md`,
`projection{,_ru}.md`, `system_prompt{,_ru}.md`, `concepts{,_ru}.md`,
`prompt_state_machine_concept{,_ru}.md`, `tools{,_ru}.md`, `testing{,_ru}.md`,
`walkthrough{,_ru}.md`, `docs/README.md`, и `AGENTS.md` — инвариант «цель закрывается только
`stop` доxa (ребро `has_stopped`)» становится «состояние закрывается только `stop` доxa
(ребро `has_stopped` на `move`); критерийного гейта нет».

## 10. Риски

- `what` и первый `apply` — два хода; расплывчатый `what` поправляется первым действием.
  Приемлемо.
- Рефактор всего движка: механический, но широкий (types → engine → traverse/classify →
  projection/prompt → tests → docs). Снижается порядком фаз и зелёным на каждой.
- Старые трейсы `contexts.ndjson` под новым IR не реплеятся (нет узла `goal`); проверка — на
  свежих прогонах.
