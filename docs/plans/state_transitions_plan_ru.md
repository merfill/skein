# Skein — план переходов состояний (create_goal как ход смены состояния)

> Русское зеркало `docs/plans/state_transitions_plan.md`.
> Статус: **вытеснено `docs/plans/state_protocol_plan_ru.md`** (живые прогоны `fix-ocaml-gc`
> 2026-10-13 показали, что инкрементальный фикс не заставляет доксу переходить; редизайн делает
> состояние первоклассным ходом). Хранится ради свидетельств P1–P5 и ревью промпта.

## 1. Контекст

Промпт-машина состояний вошла (`docs/prompt_state_machine_concept_ru.md`): докса задаёт
`state` цели при `create_goal` (id острова из `src/ir/islands.ts`), базовый промпт
(преамбула `B0` + граф `B4`) описывает острова и переходы, а `project` добавляет
`ISLAND_INSTRUCTIONS[state]` на открытой цели. Все офлайн-гейты зелёные
(`npm run typecheck`, 296 офлайн-тестов, офлайн sandbox-тесты).

Живая проверка на `fix-ocaml-gc` (2026-10-12):

- попытка 1, `2026-10-12T05-48-08-483Z` — **reward 0**, `max_turns` (60). Причина: текст
  промпта (`B6`/`B7`) всё ещё говорил `create_goal { what, command }`, тогда как схема
  перешла на `{ what, state, action }`; рассинхрон сбил модель (локализовала на t25 и не
  правила). Словарь в промпте исправлен.
- попытка 2, `2026-10-12T06-12-37-722Z` — **reward 1**, `max_turns` (60). Решено, но правка
  пришла поздно (один `edit` на t57), и прогон ни разу не вызвал `stop`.

В **обоих** прогонах докса создала **ровно одну цель** (`state: reconnaissance`) и ни одной
подцели. Карта островов была инертна: ни один мост не пройден.

Далее последовало критическое ревью инжектируемого промпта состояний; его итог сведён в §2
(P4, P5) и §4 (C, D). Опорные документы по словарю состояние/переход/ограничение —
`docs/prompt_state_machine_concept_ru.md` §4.2–4.4, §5–6.

## 2. Проблемы

### P1 — переход заблокирован в движке (главная)

`create_goal` на открытой цели требует **невыполненного пункта плана**, чтобы его разложить:

- `src/loop/classify.ts` отклоняет с `no_current_item: the plan is already fulfilled; apply
  an action to add the next item`;
- `src/tools/index.ts` падает так же (`create goal failed: no current plan item to
  decompose …`).

Но пункт **выполнен**, как только его текущая альтернатива — исполненное успешное действие
(`itemFulfilled`). Значит, после **успешного** действия план исчерпан и `create_goal`
отклоняется. Следствие: **смена состояния возможна только после провала.** Пока работа идёт
хорошо, докса физически не может перейти в следующее состояние — а именно тогда и должна.

Это ещё и **расхождение фронтьера и гейта**: `applicable` (`src/ir/traversal.ts`) выставляет
`createGoal: true` для любой открытой цели, а `classify` отказывает при исчерпанном плане.
Проекция говорит доксе, что ход допустим; гейт его отклоняет.

### P2 — промпт подаёт `create_goal` как ветвление, а не как переход

Описание инструмента ведёт с «add a sub-goal that moves the work to a new state **or
branches the current plan item**», а `B7` помещает фразу о состоянии внутрь списка способов
выхода из провала. Докса читает `create_goal` как «восстановление после провала», а не как
«ход, которым работа меняет состояние». Нет одной заметной фразы: *чтобы сменить состояние,
вызови `create_goal` с новым `state` — провал не нужен*.

### P3 — состояние — один замороженный ярлык

Раз докса не создаёт вторую цель, `state` фокусной цели остаётся тем, что выбрал
интерпретатор (`reconnaissance`). Тогда инструкция острова каждый ход повторяет один и тот
же остров. Значит, даже хороший критерий/рельеф не работает: модель не «в» Локализации и не
«в» Правке.

P3 — следствие P1 (+P2): если переход невозможен, то и замораживать/двигать нечего.

### P4 — в промпте состояния нет «что это за работа», а у переходов нет условия

Инжектируемая инструкция острова (`src/loop/prompt/blocks.ts:92-103`) несёт только
**критерий** и **ограничения**; она никогда не говорит, *в чём* заключается работа состояния.
Граф `B4` (`blocks.ts:15-19`) перечисляет `done when <criterion>. → <next>` без
**предусловия**, делающего ребро применимым, и ни **начальные** состояния-кандидаты, ни
**терминальное** состояние не объявлены. Модель не может понять, *когда* мост допустим, —
только *куда* он ведёт.

### P5 — нет бюджета состояний и давления

Граница есть только у Reference, и она расплывчата («a small budget»). Чтение в
Reconnaissance, перечитывание в Localization и повторы в Verification не ограничены, а
движок ни разу не подгоняет застрявшую цель. Наблюдаемые дрейфы: 89% рассуждений до первой
правки, ~26 туров реинвенции, 9×403 на `webfetch`, `max_turns` без `stop`.

## 3. Гипотезы

- **H1 (главная):** модель не может переходить (P1). Починим движок — модель сможет двигаться
  между островами.
- **H2:** формулировка промпта (P2) усугубляет дефект — модель даже не *пробует* переход (в
  обоих прогонах `refused 0`). Поправим текст так, чтобы смена состояния читалась как обычный
  следующий ход, а не как восстановление.
- **H3 (проверять, не предполагать):** после H1+H2 докса начнёт создавать цели по состояниям и
  мосты реально поведут (меньше потраченных ходов, более ранняя правка). Это надо *измерить*,
  а не принимать на веру.
- **H4 (проверять):** `What` у состояния + обусловленные переходы + бюджеты + пинок по застою
  (P4/P5) дополнительно снижают дрейф — более ранняя первая правка, чистый `stop` вместо
  `max_turns`. Меряется живьём, один прогон на ветвь.

## 4. Предлагаемые изменения

Порядок: семантика → код → промпт/данные → тест → доки.

### A. Семантика (`docs/ir_semantics{,_ru}.md` §2.7, §4.1; `docs/ir_operations{,_ru}.md` OP-CG)

Подцель на открытой цели может **также начинать новый пункт плана**, когда план исчерпан
(сиблинг ветки «исчерпания» в `placeAction`), а не только заменять текущий пункт. Отказ
`no_current_item` для `create_goal` убирается. Фокус спускается, как прежде.

### B. Код движка

- `src/loop/classify.ts` — снять отказ `no_current_item` для `create_goal` (допустим на любой
  открытой цели).
- `src/tools/index.ts` — обобщить `placeAction` в `placeMove(goalId, nodeId)` (текущий пункт →
  новейшая `alts`; пункта нет → новый `plan` `item`), использовать для `apply` и вызвать из
  `case "create_goal"` (ветка + спуск фокуса как прежде).

### C. Промпт

#### C1. `B1` — убрать внутренности движка, оставить батчинг

Убрать «records every result on the tape — your whole context. Nothing off the tape is known to
you» (лента — дело движка; `docs/ir_semantics_ru.md` §3). Оставить правило батчинга (это
поведение, а не факт о движке):
`... Each turn you reply with tool calls; the engine executes them and returns the results.
Batch calls whose arguments do not depend on a sibling's result.`

#### C2. `B2` + `FRAGMENT` — убрать

`B2` («What you can do: …») дублирует поле `tools`. Убрать его и ставший ненужным
`src/ir/fragment.ts` (`FRAGMENT`); убрать импорт в `blocks.ts`.

#### C3. `B4` — преамбула-механизм, `Start`, `Transitions`

Добавить **механизм** перехода один раз (не в каждом состоянии), список `Start` и секцию
`Transitions` как **рёбра с условием, сгруппированные по источнику** (покрывает ветвления и
циклы):

```
You are always in exactly one state — the state of the goal you are focused on; its work, its
closing criterion and its constraints are shown to you each turn. When the current state's work
is done (its criterion holds), move on by calling `create_goal` with the next `state`. Moving
is cheap: once a criterion is met, do not re-check it — move now.

Start — a goal starts in the state whose criterion already holds:
- Reconnaissance — the default: the entry point, the build/test commands and the touched files
  are not known yet.
- Localization — the request already names the file and the exact change (a one-line fix).
- Reproduction — the request hands a command that must first be seen to fail.
- Design — the task is a feature or a multi-step change, not a defect.
The state is named at `create_goal`; there is no fixed first step.

Transitions — move as soon as the condition holds; the order is not fixed:
Reconnaissance leads to:
  1. Reproduction — there is a command that fails observably.
  2. Localization — the cause is findable by reading.
  3. Design — a feature or many edits.
Reproduction leads to:
  4. Localization — the failure is the goal's, not the environment's.
Localization leads to:
  5. Patch — the file, the line and the exact change are named.
  6. Reference — external truth is needed (an upstream change, docs).
  7. Design — the change spans many edits.
Reference leads to:
  8. Localization — the reference refined your derivation.
  9. Patch — the reference confirms the change.
Design leads to:
 10. Patch — the first item is executable now.
Patch leads to:
 11. Verification — the change is in the workspace.
Verification leads to:
 12. Hand-off — the acceptance command passes.
 13. Localization — it fails: go back with the new evidence (corrective cycle).
Any state leads to Environment triage when a command fails for environmental reasons; it returns
to the state you came from.
Hand-off is terminal: call `stop`.
```

#### C4. Инструкция состояния — `What / Done when / Constraints`

Заменить нынешнее `State: <label> — done when … / Constraints: … / When done, create the
goal for the next state: …` на:

```
State: <label> — <what this work is>
Done when: <criterion>
Constraints: <constraints>
```

Строка `When done …` убирается (маршруты — в `B4`). Тексты состояний (задаются в
`islands.ts`, рендерятся `blocks.ts`):

| Состояние | What | Done when | Constraints |
|---|---|---|---|
| Reconnaissance | build the project map: the entry point, how it builds and runs, where the relevant code and data are | the entry point, the build/test commands and the files the change touches are known | batch independent reads/greps; wide first, then narrow; at most two rounds of inspection, then move |
| Reproduction | obtain an observable failure tied to the goal | a command fails observably and the failure is the goal's, not the environment's | tell "not found" from "not built"; if the failure is environmental, move to Environment triage |
| Localization | find the exact cause: the file, the line and the expression, or the missing symbol/contract | you can name the file, the line and the exact change to make | if the target lines are already on the tape, name the exact replacement and edit now — do not re-read or re-derive; read only what you still need; move to Patch in the same move |
| Reference | obtain external truth — an upstream change, a diff, documentation | the reference is on disk, or one attempt failed and you derive it yourself | at most one fetch; an unavailable reference is a fact, not a reason to retry |
| Design | choose the approach and the sequence; for a design, the interface/structure | the set of changes, or the sequence, is concrete and its first item is executable now | the first item is a literal action, not a description; plan no more than the task needs — a single edit needs no design |
| Patch | make the change | the exact change is in the workspace | edit for a targeted change; oldString must be unique; after the edit, verify — do not re-read the file you just changed |
| Verification | confirm the change with the acceptance command/tests | the acceptance command that failed now passes | run builds/tests in the foreground; never repeat a failed command — on failure change the approach and return to Localization with the new evidence; do not re-verify what passed |
| Environment triage | tell an environmental failure (missing config/deps) from a failure of the goal | the failure is named as environmental or the goal's, and the environment is prepared if it is environmental | building the project is setup, not the defect; this is a detour — return to the state you came from |
| Hand-off | close the work | the goal is closed with `stop` | call `stop` now — the work is verified; do not re-verify and do not start new work |

#### C5. Бюджеты состояний (`islands.ts`)

Бюджет — это **стоп-сигнал**, а не квота работы; держать маленьким и в одном месте. Стартовые
значения (калибровать живьём):

| Состояние | Бюджет | Почему |
|---|---|---|
| Reference | 1 fetch | живой дрейф 9×403 |
| Reconnaissance | 2 раунда батч-осмотра | 89% рассуждений до первой правки |
| Localization | 0 доп. чтений, если строки уже на ленте | 26 туров реинвенции |
| Verification | 0 повторов той же команды; 1 повтор после изменения | повторы упавших прогонов |
| Environment triage | 1 раунд, затем возврат | блуждание в плавающем состоянии |

#### C6. Описание `create_goal` и `B7`

- `src/llm/tools.ts` — вести с перехода: *move the work to the next state (or interpret the
  request)*; ветвление/декомпозицию — вниз; убрать ставшее неверным «A sub-goal replaces the
  current plan item». Оставить правило `WORKSPACE ROOT`/`cd <dir> &&`.
- `B7` — одна явная фраза: *to change state, call `create_goal` whose `state` names it; a
  failure is not needed*; убрать рамку «после провала».

#### C7. Пинок по застою на уровне проекции

Движок уже считает `stall` (`src/loop/graph.ts:315-318`, `src/ir/progress.ts`). Добавить
**мягкий аттрактор** перед жёстким `no_progress`, рендеря его как `SystemMessage` после
инструкции острова — **не** фейковый assistant-ход (лента — проекция IR):

- `projectNode` передаёт `state.stall` в `project(...)`; `Context` получает `nudge`;
  `buildMessages` добавляет его (детерминированно, производно от состояния цикла).
- Формулировка — **вопрос-решение**, а не приказ (чтобы не поймать дрейф-имитацию §7/B12):
  `You have made no progress for {n} turn(s) in {State}. Decide now: name the exact change and
  edit; move to another state with `create_goal`; or `stop`.`
- Эскалация: мягко при `n=1`, жёстче при `n=2`; жёсткий стоп остаётся за `no_progress`.

### D. Данные (`src/ir/islands.ts`)

- добавить `what: string` в `Island`;
- `next: readonly IslandId[]` → `next: readonly { to: IslandId; when: string }[]` (мосты как
  предусловия — закрывает соответствующий открытый вопрос);
- `Start` остаётся статическим блоком в `blocks.ts` (без поля в модели данных), если ревью не
  предпочтёт поле.

### E. Тесты

- `tests/ops/create_goal.test.ts` — новый кейс **`[OP-CG-5]`**: `create_goal` **после успешного**
  действия принимается, создаёт новый пункт плана, цель — его новейшая альтернатива, фокус
  спускается.
- `tests/loop.test.ts` — заменить «refuses to decompose an open goal with no current plan item»
  на «starts a new plan item when the plan is exhausted».
- `tests/ops/applicable.test.ts` — зафиксировать, что `classify` принимает `create_goal` на
  исчерпанном плане (фронтьер и гейт согласны).
- `tests/islands.test.ts` — адаптировать проверки `next` к `next[].to`; требовать непустой `what`.
- `tests/prompt.test.ts` — рендер состояний (`What/Done when/Constraints`), секции `Start`/
  `Transitions` и (если C7 войдёт) пинок.

### F. Документы

- `docs/ir_operations{,_ru}.md` — OP-CG-2 `Pre`/`Effects`/`Refuses`, добавить `OP-CG-5`, заметки
  и карту покрытия (`OP-CG-1..5`).
- `docs/ir_semantics{,_ru}.md` §2.7, §4.1.
- `docs/ir{,_ru}.md` — пункт `create_goal` и список отказов (`no_current_item` убран).
- `docs/system_prompt{,_ru}.md` — строки B1/B2/B4/B7 и инвентарь блоков.
- `docs/prompt_state_machine_concept{,_ru}.md` §5 — заметка о сборке (состояния рендерятся как
  `What/Done/Constraints`; переходы — рёбра с условием).
- `docs/README.md` уже ссылается на этот план.

### G. Синтетический live-гейт (перед дорогим бенчем)

Дешёвые проверки в один вызов модели, что модель реально **переходит** и **реагирует на
пинок**. Запускаются до любой дорогой задачи и служат **гейтом**: если падают — бенч тратить
незачем. Носитель — онлайн-слой шагов (образец `tests/live/ir_operations_step.test.ts`):
проекция строится **офлайн** (ровно то, что показал бы движок), а проверяется **форма**
следующего хода, с повтором `SKEIN_STEP_REPEATS` (по умолчанию 3). Это проверка *готовности*
модели; приём перехода движком покрыт офлайн — `OP-CG-5`.

Новый `tests/live/state_transitions_step.test.ts`:

- `localized-edit-now` — фокус на цели Localization, строки бага уже на ленте: ожидаем
  `apply { edit }` (или `create_goal { state: "patch" }`); очередное чтение/recall/grep — это
  и есть дрейф, против которого правка.
- `recon-transition` — фокус на цели Reconnaissance, карта проекта на ленте: ожидаем
  `create_goal` с **другим** `state` или конкретное действие, а не ещё один листинг.
- `verified-stop` — фокус на цели Verification, приёмочная команда прошла: ожидаем `stop` (или
  `create_goal { state: "handoff" }`).
- `handoff-stop` — фокус на цели Hand-off: ожидаем `stop`.
- `nudge-stalled` (с C7) — фокус на Localization после нескольких чтений без правки, **с**
  пинком: ожидаем решающий ход (`edit` / `create_goal` / `stop`); печатать контроль без пинка,
  чтобы сдвиг был виден.

Плюс один **сквозной** синтетический смоук на крошечной фикстуре (через сценарный харнесс,
`tests/live/scenarios.test.ts`): жёстко — прогон решён и закрыт
`stopReason=request_addressed`; мягко — печать посещённых `state` целей. Новый хелпер
`statesOf(events)` читает заданный доксой `state` целей из журнала.

Стоимость ≈ 5 шагов × 3 повтора + один крошечный прогон ≈ доля одного прогона. Только если
этот гейт зелёный, тратим два прогона `fix-ocaml-gc` ниже.

### H. Проверка (живьём, бенч)

- Перезапустить `fix-ocaml-gc`, net `on` и `off` (один прогон на ветвь = направление, не
  статистика, `docs/prompt_state_machine_concept_ru.md` §7).
- Признак успеха (кроме reward): докса создаёт **больше одной цели** с **разными `state`**, и
  прогон доходит до `reward 1` — в идеале с чистым `stop`, а не `max_turns`.

## 5. Решения из ревью промпта

- `B1`: убрать предложения про ленту/контекст; правило батчинга — **оставить**.
- `B2` и `FRAGMENT`: убрать.
- Состояния рендерятся как `What / Done when / Constraints`; строка `When done …` убрана —
  механизм живёт один раз в `B4`.
- Переходы — **рёбра с условием, сгруппированные по источнику** (ветвления и циклы явные);
  `Start` называет начальные состояния-кандидаты; `Hand-off` назван терминальным.
- Бюджеты: Reference 1 / Reconnaissance 2 / Localization 0 если на ленте / Verification без
  повторов / Env_triage 1 и возврат.
- Пинок по застою — `SystemMessage` на уровне проекции, производный от `stall`, сформулирован
  как решение, а не приказ.

## 6. Открытые вопросы

- **`next` у `env_triage`.** Держать список соседей в данных (граф его рендерит), но в тексте
  писать «вернись в состояние, откуда пришёл», или ввести явную семантику возврата?
- **`Start`** — статический текст в `B4` или поле у `Island`.
- **Отсутствующий остров `Interpretation`** (шаг request→goal) и мост из него.
- **`max_turns` против `stop`.** Попытка 2 решила, но не остановилась. Достаточно ли Hand-off
  (императивное «call `stop` now») + пинка, или нужен явный толчок «проверено → stop»?
- **Формулировка/эскалация пинка** и пороги (взаимодействие с `noProgress`).

## 7. Риски и стоимость

- Правки промпта и движка дешёвы и офлайн-тестируемы; живое подтверждение — нет (~9₽/прогон;
  из 10 разрешённых осталось 8).
- Правка гейта `create_goal` — это изменение семантики: сначала документ, и снятие
  `no_current_item` не должно воскресить гейт по критерию (закрытие остаётся `stop`).
- Реворк промпта — поведенческое изменение, измеряемое только живьём; бюджеты и пинок —
  стартовые значения для калибровки, не факты.
- Удаление `B2`/`FRAGMENT` и переработка графа трогают стабильный, кэшируемый текст промпта —
  одна правка на A/B, обе сети.
- Синтетический live-гейт (§4 G) ограничивает траты: переходы и пинок проверяются дешёвыми
  проверками в один вызов модели до двух прогонов `fix-ocaml-gc`.
