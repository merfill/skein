# Skein — ревизия операций IR: фронтьер и три вида узлов доксы

> Английское зеркало — `docs/plans/ir_operations_revision_plan.md`.
>
> Основание — принцип руки (`docs/concepts.md`, «Рука — это ReAct на месте») и аудит
> `docs/ir_operations.md`, `docs/ir_semantics.md`, `docs/projection.md`,
> `docs/plans/traversal_stack_spec.md` против `src/ir/*`, `src/tools/index.ts`,
> `src/loop/classify.ts`, `src/ir/project.ts`.

Связанные: `docs/ir_semantics.md` (источник истины — этот план меняет его первым),
`docs/ir_operations.md` (реестр операторов и покрытие), `docs/projection.md`,
`docs/plans/traversal_stack_spec.md`, `docs/system_prompt.md`, `docs/tools.md`.

## 1. Контекст: что нашёл аудит

Принцип (`docs/concepts.md`): внутри руки Skein — это ReAct на месте: цель создаётся с
планом ровно из одного пункта-команды, пункт исполняется, результат записывается и
уходит доксе, а докса добавляет следующий узел; альтернатива превращает руку в дерево.
Каждый шаг — событие IR.

Код повторяет *форму* (план из одного пункта: `buildGoal` `src/tools/index.ts:591`;
под-цель как альтернатива шага `src/tools/index.ts:718`; check закрывает только свою
цель `src/tools/index.ts:1375`; детерминированный фокус `src/ir/traversal.ts:110`), но
аудит нашёл пробелы:

- **F1 — фронтьер и гейт расходятся.** `applicable` выставляет `create_goal` для любой
  открытой цели (`src/ir/traversal.ts:222`), а `classify` отклоняет его, когда план
  objective-цели выполнен (`all_plan_fulfilled`, `src/loop/classify.ts:261`) или
  нечего декомпозировать (`src/tools/index.ts:688`).
- **F2 — воронка на арбитере.** Для открытой арбитер-цели, единственный шаг которой
  исполнен, `applicable` = `["create_goal"]` (`nextAction` нет, `checkReady` нет,
  `plan !== undefined`), и этот `create_goal` гарантированно провалится — а легальный
  `apply` (новая команда) скрыт (`docs/plans/plan_stepwise_redesign.md` §1).
- **F3 — две копии фронтьера.** `traversal.applicable` и `classify.focusHint`
  (`src/loop/classify.ts:183`) независимо и по-разному считают одни правила.
- **F4 — остановка скрыта.** Остановка чисто производна (`request_addressed` /
  `no_progress` / бюджет); у доксы нет для неё узла, а `applicableNames`
  (`src/ir/project.ts:359`) никогда не показывает `return`.
- **F5 — `chooseVariant` мёртв.** Выставляется в `applicable`
  (`src/ir/traversal.ts:200`), в проекцию не попадает, оператора нет.
- **F6 — реестр неполон.** `ir_operations.md` не описывает, как `apply` привязывается к
  плану (переиспользовать / `chosen`-альтернатива текущего пункта / добавить пункт,
  `src/tools/index.ts:629`), и что check создаёт action и ребро `produces`.
- **F7 — история руки не рендерится.** `traversal_stack_spec.md` §7 требует
  alternatives пункта инлайн; у `ProjectionItem` их нет (`src/ir/project.ts:33`).
- **F8 — `calls` схлопывает разные правки.** Спека хочет короткий дифф в `action`
  (`docs/tools.md` §4.4); код дедупит по `edit <path>`, а дифф держит только в `note`
  (`src/ir/project.ts:536`).
- **F9 — `tools.md` §2.1 устарел** (`plan` как список, без `step`).

## 2. Целевая семантика

### 2.1 Рука и курсор

В фокусе доксе отдают **руку целиком** — упорядоченных сиблингов (`plan`-пункты или
варианты `alternatives`) с их состояниями, — а **курсор отмечает только текущий узел**.
Движок не диктует единственный следующий ход; он говорит, что допустимо в этой точке
(фронтьер). Это и делает руку ReAct: докса выбирает, logos гейтит.

### 2.2 Три вида узлов доксы

Каждый принятый ход доксы **добавляет ровно один узел**; отклонённый добавляет
`record_rejection` и меняет проекцию. Виды:

- **continue** — `apply` команды: исполнить следующий шаг. Движок привязывает её к
  плану (переиспользовать невыполненный action-пункт с той же командой; иначе стать
  `chosen`-альтернативой текущего невыполненного пункта; иначе новый `item`) —
  `ir_semantics` §4.2.
- **alternative** — «давай другое»: `create_goal` (новая интерпретация на request,
  вариант refuted-цели или под-цель, декомпозирующая текущий шаг) либо `apply` другой
  команды (записывается как `chosen`-альтернатива текущего пункта).
- **stop** — `stop`: заявить, что request выполнен. Принимается только если производный
  предикат уже `addressed`; иначе — отказ.

`query` остаётся только чтением (узла не добавляет). Это должно быть закреплено в
семантике и в промпте (B3/B7/B15), а не подразумеваться.

### 2.3 Фронтьер (одно вычисление, общее)

`frontier(state, focus)` заменяет `applicable` и питает и проекцию, и `classify`
(чинит F1–F3):

```
frontier = {
  goalId,
  canCreateGoal,   // request (не addressed) | refuted-цель | открытая цель с текущим
                   // невыполненным action-шагом
  canApply,        // фокус — открытая цель: команду можно исполнить сейчас
  canCheck,        // objective-цель с завершённым планом (== checkReady)
  canStop,         // фокус — корневой request и производный предикат addressed
  current?         // текущий узел руки (курсор), информационно
}
```

- `canApply` истинно для любой открытой цели (exploratory-команда всегда легальна), а
  не только когда случайно выставлены `nextAction`/`checkReady` (чинит F2).
- `canCreateGoal` повторяет гейт точно (никаких сюрпризов `all_plan_fulfilled`).
- `return` — внутренний для движка (никогда не оператор доксы) и больше не входит во
  фронтьер, который видит модель.
- `chooseVariant` удаляется (F5): выбор варианта — это просто «alternative».

`Context.applicable` перечисляет действительно допустимые имена операторов: `["stop"]`,
`["apply"]`, `["create_goal"]` или их комбинации; `checkReady = canCheck`.

### 2.4 Оператор `stop`

- **Вход:** `{ why? }`.
- **Pre:** фокус — корневой request; производный предикат request — `addressed`
  (выбранная интерпретация `achieved`/`achieved_under`).
- **Эффекты:** `add_node` вида `stop` (payload `{ why? }`); цикл останавливается с
  `request_addressed`.
- **Отказы:** `not_addressed` (фокус не request или request не addressed), с
  `focusHint`.
- **Проекция:** узел `stop` — терминальный; принятие request остаётся внешним —
  `addressed` производен, `stop` не ставит статус.
- **Цикл:** на addressed-request фронтьер `["stop"]`, поэтому докса не может блуждать;
  прогон останавливается, когда записан узел `stop`.

### 2.5 Инварианты (изменения)

- инвариант 20 уточняется: докса по-прежнему никогда не закрывает цель; `stop` — это
  *предложение*, проверяемое производным `addressed`.
- новый: каждый принятый ход доксы добавляет узел (continue/alternative/stop) или
  отклоняется.
- инвариант 4 (детерминизм) сохраняет оговорку: `project` нужен ещё и транзиентный
  результат последнего хода (`ProjectOptions.lastOutput`).

## 3. Правки спецификации (шаг 1 — до кода)

1. `docs/ir_semantics.md`
   - §2.1/§2.5: добавить work-узел `stop`; `addressed` оставить производным.
   - §2.6: переписать «применимое в точке» вокруг руки + курсора + фронтьера; добавить
     три вида узлов.
   - §4: добавить `stop` (§4.3) по шаблону §0; обновить число операторов (два → три).
   - §4.2: сделать случаи привязки `apply` к дереву явными (в тексте они есть, но не
     как определённый эффект оператора).
   - §9: уточнить инвариант 20; добавить «каждый принятый ход добавляет узел».
2. `docs/ir_operations.md`
   - §1.1: добавить `stop`.
   - §2: новое семейство `OP-ST`; расширить `OP-AP-*` эффектами привязки к плану
     (`OP-AP-*-CONT` continue, `OP-AP-*-ALT` alternative); отметить check → action →
     `produces`.
   - §3: отказ `not_addressed` (stop); согласовать с общим фронтьером.
   - §5: записи матрицы покрытия.
3. `docs/projection.md`: имена операторов включают `stop`; `PathNode.plan.items[]`
   несёт `alternatives` (история ревизий пункта); форма `Item` обновлена.
4. `docs/system_prompt.md` (+ `src/loop/prompt/blocks.ts`): B3/B7/B15 задают три вида
   узлов и «всегда добавлять узел»; условие остановки — `stop` доксы.
5. `docs/tools.md`: починить §2.1 (`plan`-строка + `step`); отметить инструмент `stop`.

## 4. Правки кода (шаг 2)

- `src/ir/traversal.ts`: заменить `applicable` на `frontier`; убрать `chooseVariant`;
  `focusEvents` оставить как нормализацию движка.
- `src/loop/classify.ts`: гейт из общего `frontier`; добавить гейт `stop`
  (`not_addressed`).
- `src/tools/index.ts`: обработать предложение `stop` (добавить узел); задокументировать
  привязку `ensureAction` как путь continue/alternative.
- `src/llm/schemas.ts` / `src/llm/tools.ts`: добавить инструмент `stop`.
- `src/ir/types.ts` / `src/ir/events.ts`: добавить work-вид `stop` (через `add_node`).
- `src/ir/project.ts`: рендерить `stop`; `alternatives` уровня пункта; `applicable` из
  `frontier`; починить ключ дедупа правок (F8).
- `src/loop/graph.ts`: останавливаться на записанном `stop`; производный `addressed`
  сохранить.

## 5. Тесты (шаги 3–4)

**Оффлайн (`tests/ops/`)**

- новый `tests/ops/applicable.test.ts` (`TR-8`): для каждой формы фокуса (request
  open/addressed; goal open со свежим шагом; objective-план завершён; арбитер-план
  завершён; refuted с вариантами/без) проверить фронтьер и что `applicable` равен
  допустимому множеству гейта.
- `tests/ops/create_goal.test.ts`: привязка `apply` continue/alternative с новыми ID
  (`OP-AP-*-CONT`/`-ALT`); покрыть `all_plan_fulfilled`.
- новый `tests/ops/stop.test.ts` (`OP-ST-1..`, `REF-ST-STATE`): принимается тогда и
  только тогда, когда addressed; иначе отказ; цикл останавливается.
- `tests/ops/traversal.test.ts`: `alternatives` уровня пункта в проекции
  (`TR-9`/`PRJ-ITEM-ALT`).
- `tests/ops/ir_properties.test.ts`: свойство на 400 сидах — `canCreateGoal`/`canApply`/
  `canStop` фронтьера никогда не приводят к отказу `classify` этого оператора (`TR-8`).
- `tests/coverage.test.ts`: реестр получает `OP-ST`; у каждого нового ID есть тест.

**Онлайн (`tests/live/ir_operations_step.test.ts`)**

- objective-цель с исчерпанным планом → модель предлагает **check**, а не `create_goal`;
- арбитер-цель после шага → модель предлагает **continue/alternative**, а не воронку;
- addressed-request → модель предлагает **stop**.

## 6. Порядок работ (каждый шаг зелёный)

0. (Опционально) снять baseline (`docs/testing.md`).
1. Спека: `ir_semantics` → `ir_operations` → `projection` → `system_prompt`/блоки →
   `tools`. Новые ID зарегистрированы; к шагу 3 на каждый ID должен быть тест.
2. Код: унифицировать фронтьер (F1–F3, F5) → добавить `stop` (F4) → alternatives уровня
   пункта и ключ правок (F7–F8). Проверка: `npm run typecheck` +
   `SKEIN_LIVE=false npx vitest run`.
3. Оффлайн-тесты.
4. Онлайн-шаги (`SKEIN_LIVE=true npx vitest run tests/live/ir_operations_step.test.ts`).
5. Матрица покрытия и синк `docs/ir.md`.

## 7. Открытые вопросы

- **Решено:** на **addressed** request фронтьер строго `["stop"]`; новая интерпретация
  (`create_goal`) там отклоняется. Ревизия после addressing — будущая работа.
- Нужен ли `stop` payload (`why`) в проекции, или производного `addressed` достаточно?
- F8 (ключ правок в `calls`) можно отложить: это деталь проекции, а не баг фронтьера.
