# Skein — план: строго пошаговое исполнение и представление плана

> Английское зеркало — `docs/plans/archive/plan_stepwise_redesign.md`.
> Основание — разбор бенча `docs/benches/bench_report_ru.md` §4.4 (прогон `2026-10-07__16-42-30`,
> Skein 0/9, `llm_error`) и обсуждение представления плана.
> Реализуется **пошагово**, каждый шаг оставляет дерево зелёным.

> **Шаг 0 решён: вариант (a)** — A1 (objective-замыкание) уходит; закрытие всегда
> своим чеком. `OP-AP-RUN-7` переписывается под закрытие своим чеком. Шаг 2.5 не
> добавляется.
>
> **Прогресс.** Шаг 1 (убрать A4) — сделано. Шаг 2 (схема `plan`-строка + `step`) —
> сделано. Шаг 2.5 (§3(a), снять A1) выполнен вместе с шагом 2: смена схемы сделала
> A1-тесты невыразимыми, поэтому `closeAncestors`/`ownerGoalOfPlan`/`itemSettled` из
> `src/ir/graph.ts` удалены, DER-CLOSE-1…5 и OP-CG-5 сняты. Дополнительно (сверх плана,
> ради консистентности): `GoalPayload.plan` проецируется как `PathNode.planHint`; спека
> и `ir{,_ru}.md` синхронизированы. Шаг 3 (подцель — альтернатива текущему шагу) —
> сделано; `OP-CG-2` переписан. Шаг 4 (промпт B3/B4/B7/B11 + `system_prompt{,_ru}.md`) —
> сделано. Шаг 5 (доки: `ir_semantics{,_ru}`, `ir{,_ru}`, `projection{,_ru}`,
> `context_design{,_ru}`, `concepts{,_ru}`, `traversal_stack_spec{,_ru}`) — сделано.
> **План выполнен** (шаги 0–5). Offline: 235 passed / 30 skipped.
>
> **Follow-up (после бенча).** По разбору `defeasible-rules`: (a) правило команды в B6
> (запрос называет команду ⇒ `objective`, не `arbiter`) и переписанные сообщения отказов
> `unknown_revision` / `no current step to decompose`; (b) в цикл добавлен опциональный хук
> внешнего арбитра `AgentDeps.arbiter`, синтетический раннер играет программу-арбитра
> (`check.sh` → `record_check actor:"user"`). Весь синтетический набор — **10/10 reward=1**
> (`docs/benches/bench_report_ru.md` §4.6). Offline: 236 passed / 30 skipped.

## 1. Контекст (что случилось)

На длинных terminal-bench задачах (high) Skein провалился системно: **все 9 триалов —
`llm_error: "model returned no tool call"`** (`src/llm/structured.ts:309`). В трейсе
`fix-ocaml-gc` модель построила **6 вложенных `arbiter`-целей**:

```
w:goal:2  arbiter; plan=[action ls ✓, action sed ✓, w:goal:18]
  w:goal:18 arbiter; plan=[…, w:goal:35]
    … → w:goal:65 arbiter; plan=[…, w:goal:82]
               w:goal:82 arbiter; plan=[3 действия ✓] cursor=3 (план исполнен, цель open)
```

Механика тупика: у `arbiter`-цели с **исчерпанным** планом `applicable`
(`src/ir/traversal.ts`) не даёт ни `apply` (нет `nextAction`, не `checkReady`), ни
`return` (не закрыта) — только `create_goal`. Модель вынуждена создавать следующую
цель → воронка.

Корни:
1. **A4** («авто-прогон ведущих пунктов», `src/tools/index.ts` `AUTO_RUN_ACTIONS`)
   исполняет план в том же ходу → состояние «план исчерпан» наступает мгновенно.
2. **План необязателен** (`src/llm/schemas.ts:114` `plan … optional()`,
   `src/loop/classify.ts` `planOk`).
3. **Пункт плана может быть целью** (`planItemSchema`, `kind:"goal"`) — модель лепит
   абстрактные подцели.

Гипотеза-причина, под которую переписывался `traversal_stack_spec`: «в узле цели —
план как строка; обход — пошаговый ReAct; подцель — только альтернатива пункту».

## 2. Правила (инварианты IR)

- **I1.** Цель всегда создаётся с непустым планом (`has_plan → plan`, ≥1 пункт).
  Нет плана → отказ.
- **I2.** На создании пункт плана — **только `action`** (конкретная команда,
  исполнима сейчас). `goal`-пункт на создании запрещён.
- **I3.** Узел цели хранит **изначальный план строкой** (`goal.payload.plan`) —
  неизменная подсказка.
- **I4.** Обход **строго пошаговый** (ReAct): исполняем текущий пункт → отдельным
  ходом модель решает «следующий / хватит». Никакого авто-прогона.
- **I5.** Закрытие — **только критерием**: objective → чек команды; arbiter → вопрос
  человеку и ожидание. Движок сам не закрывает, не авто-закрывает.
- **I6.** Подцель появляется **только как альтернатива** существующему пункту
  (append-only), не при создании и не как пункт плана.

## 3. Следствие для A1 (решить до шага 2)

`closeAncestors` (`src/ir/graph.ts`) обходит контейнеры-**планы** и ищет
предков-цели с совпадающим `done_when.command`. Если в планах только действия,
`closeAncestors` практически не срабатывает → **A1 («один чек закрывает цепочку»)
становится мёртвым**; вложенные objective-цели закрываются только своим чеком.

Варианты:
- **(a) принять уход A1** (закрытие — всегда своим чеком; «экономию шага» получить
  иначе);
- **(b) перенести замыкание на alternatives**: `closeAncestors` идёт и по контейнерам
  `alternatives` (подцель-альтернатива с тем же `command` закрывает владельца).

**Решение: (a)** — принять уход A1. При пошаговом ReAct вложенные objective-цепочки с
одинаковым критерием не возникают, а поддержка (b) тянет связанность без выигрыша в
шагах. Код `closeAncestors`/`itemSettled`/`ownerGoalOfPlan` в `src/ir/graph.ts`
удаляется вместе с A1 (мёртвые ветки). `OP-AP-RUN-7` (`tests/ops/apply.test.ts`) —
единственное покрытие — переписывается под «закрытие своим чеком».

## 4. Пошаговый план (каждый шаг — зелёный)

Порядок: **0 → 1 → 2 → 3 → 4 → 5**. После каждого — `npm run typecheck` и
`SKEIN_LIVE=false npx vitest run` (сейчас норма: 240 passed / 30 skipped).

### Шаг 0 — дизайн-решение по A1 (сделано)
Принят вариант **(a)** из §3: A1 уходит, закрытие своим чеком; шаг 2.5 не нужен.

### Шаг 1 — убрать A4 (изолированно)
- `src/tools/index.ts`: удалить `AUTO_RUN_ACTIONS` и цикл авто-прогона в
  `case "create_goal"` (комментарий «A4: …»), вернуть простой
  `return { events, turn: proposalTurn(...), done:false, stopReason:null }`.
- Убрать неиспользуемый импорт `fold` (если станет лишним).
- Тесты, предполагавшие авто-прогон (`tests/loop.test.ts`, где план исполнялся в том
  же ходу), переписать на пошаговое исполнение.
- `docs/plans/step_reduction_plan{,_ru}.md`: пометить A4 как **отменённый** (рядом с
  A5), с причиной (нарушает пошаговость; породил воронку).

**Проверка:** typecheck + offline зелёные.

### Шаг 2 — схема `create_goal`: план-строка + первый шаг
- `src/llm/schemas.ts`: убрать `GoalItem`/`ActionItem`/`PlanItem`/`planItemSchema`;
  добавить `ActionStep { command; label? }` и `stepSchema`. В `create_goal`:
  `plan: z.string()` + `step: stepSchema` (+ `revises`).
- `src/loop/classify.ts`: убрать `planOk`; отказы `empty_plan` (план-строка пуста),
  `empty_step` (команда пуста).
- `src/ir/types.ts`: `GoalPayload.plan?: string` (набросок-строка).
- `src/llm/tools.ts`: `createGoalParams` → `plan` строка + `step`; обновить описание.
- `src/tools/index.ts`: `buildGoal` создаёт план ровно с **одним** пунктом — первым
  действием из `step`; кладёт `plan` в payload.
- Тесты: `tests/ops/create_goal.test.ts` (OP-CG-4 «единственный пункт-шаг»;
  REF-CG-EMPTY на `empty_plan`/`empty_step`; убрать OP-CG-5 «nested plan»),
  `tests/ops/helpers.ts` (`interpretation(what, command?, step?)`), `loop.test.ts`,
  `workingset.test.ts`, `tests/live/ir_operations_step.test.ts` (убрать `PlanItem`,
  передавать первый шаг).

**Проверка:** typecheck + offline зелёные.

### Шаг 3 — подцель как альтернатива
- `src/tools/index.ts` `case "create_goal"`: ветка «иначе» (фокус — открытая цель)
  вместо «добавить пункт в план» делает **альтернативу текущему шагу**:
  `firstUnfulfilledItem(current)`; если это `action` — `ensureAlternatives(step)` +
  `item`+`chosen`; если текущего шага нет — `fail("no current step to decompose")`.
- Тест: `create_goal` на открытой цели кладёт новую цель альтернативой текущему шагу,
  фокус уходит в неё (заменить OP-CG-2).

**Проверка:** typecheck + offline зелёные.

### Шаг 2.5 (§3(a)) — снять A1
- `src/ir/graph.ts`: удалить `closeAncestors` и `ownerGoalOfPlan`; из `fold` убрать
  второй вызов (`derivePredicates; closeAncestors; derivePredicates` → один
  `derivePredicates`). `itemSettled` оставить только если ещё нужен другим
  потребителям, иначе тоже удалить (проверить ссылки).
- `tests/ops/apply.test.ts` `OP-AP-RUN-7`: переписать под «цель закрывается своим
  чеком» (без неявного замыкания предка-цели).
- `tests/ops/derivation.test.ts`: удалить кейсы, покрывавшие A1-замыкание.

### Шаг 4 — промпт (B3/B7)
- `src/loop/prompt/blocks.ts` B3: «plan — список STAGES (под-целей)» → «plan — это
  **строка-набросок**; в дереве на создании материализуется **только первый
  конкретный шаг**; обход пошаговый».
- B7: пример переписать на `{ plan: "<строка>", step: { command } }`; явно: шаги —
  **действия по одному**; подцель — **только как альтернатива**; «делай один шаг, по
  результату решай следующий».
- Проверить `tests/prompt.test.ts` (сборка блоков) и при необходимости обновить
  документ `docs/system_prompt{,_ru}.md`.

**Проверка:** typecheck + offline зелёные.

### Шаг 5 — документация
- `docs/ir_semantics{,_ru}.md`: I1–I6 в §2 (узлы/план), §4 (операторы), инварианты.
- `docs/ir{,_ru}.md` §2/§5: `done_when`, план, `create_goal`, «пункт — только action».
- `docs/plans/traversal_stack_spec{,_ru}.md`: I1–I6 явно; пошаговый обход.
- `docs/concepts{,_ru}.md`: при необходимости «план = строка + первый шаг».

## 5. Карта файлов

- Ядро: `src/llm/schemas.ts`, `src/llm/tools.ts`, `src/ir/types.ts`,
  `src/loop/classify.ts`, `src/tools/index.ts`, `src/ir/traversal.ts`,
  `src/ir/graph.ts` (если §3(b)).
- Тесты: `tests/ops/create_goal.test.ts`, `tests/ops/helpers.ts`,
  `tests/ops/apply.test.ts`, `tests/ops/traversal.test.ts`, `tests/loop.test.ts`,
  `tests/workingset.test.ts`, `tests/live/ir_operations_step.test.ts`,
  `tests/prompt.test.ts`.
- Доки: `docs/ir_semantics{,_ru}.md`, `docs/ir{,_ru}.md`,
  `docs/plans/traversal_stack_spec{,_ru}.md`, `docs/plans/step_reduction_plan{,_ru}.md`,
  `docs/system_prompt{,_ru}.md`, `docs/concepts{,_ru}.md`.

## 6. Статус бенча (пауза)

- Базовый прогон §4.4 не сошёлся по режиму: сохранённый job `2026-10-06__17-31-37` —
  **high** (оба агента), а текущие шаблоны были сведены к **low** коммитом `ee24be9`.
- Решение: длинные задачи гонять на **high** у обоих.
- Сделано: `bench/harbor/skein.template.yaml` и `bench/harbor/compare.template.yaml`
  переведены на `high`; `compare-offline.yaml` (локальный датасет с
  `[agent] network_mode="no-network"`, `/tmp/opencode/tb-offline`) создан и добавлен в
  `.gitignore`.
- Прогоны (черновые, до фикса): online-high `2026-10-07__16-42-30` (Skein 0/9,
  `llm_error`); offline — не завершился корректно (SIGTERM на egress-control).
- После реализации этого плана — перезапустить online-high (Skein) и offline-high
  (оба агента), обновить `docs/benches/bench_report_ru.md` §4.4.

## 7. Открытые вопросы

- **§3**: решено — **(a)**, A1 уходит (см. шаг 2.5).
- **I2**: подтверждено — план это **только действия**; терминал — `done_when` цели.
- **A4**: подтверждено — убрать (нарушает пошаговость).
- **arbiter в автономном прогоне**: сейчас хватает для тестов; вопрос «человек как
  программа со стд-потоками» отложен.

## 8. Состояние репозитория

- HEAD `7bab53e` — база. Рабочее дерево: шаги 1, 2 и 2.5 сделаны; typecheck чист,
  offline 234 passed / 30 skipped (минус 6 тестов A1/OP-CG-5).
- Незакоммичены: правки шаблонов Harbor (`high`) и `.gitignore` (бенч) — из прошлой
  сессии, к переделке не относятся.
