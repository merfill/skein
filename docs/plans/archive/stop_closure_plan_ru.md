# Skein — план: одно закрытие (`stop`), чек как обсервация, без арбитра

> Английский оригинал — `docs/plans/archive/stop_closure_plan.md`.
> Основание — обсуждение дизайна (2026-10-09): машинерия `arbiter` / `check` / `under`
> пришла из статей Ankyra и не подходит кодирующему агенту; кадр должен закрываться
> **только** через `stop`, а любой результат должен быть фактом в журнале.
> Реализуется по шагам; после каждого шага дерево зелёное.

Связанное: `docs/ir_semantics.md` (источник истины — менять вместе с кодом),
`docs/ir_operations.md`, `docs/projection.md`, `docs/plans/traversal_stack_spec.md`,
`docs/system_prompt.md`, `docs/tools.md`. История:
`docs/plans/archive/ir_operations_revision_plan.md` §2.4 (исходное «stop только на
addressed-запросе»), коммит `ad28337` (стоп arbiter-цели, породивший premature stop).

## 1. Контекст (что не так)

Сейчас дерево закрывает кадр двумя разными способами:

- **objective**-цель → прошедший `check` закрывает её сам (`predicateOf = achieved`,
  traversal выталкивает, `src/ir/traversal.ts:40`);
- **arbiter**-цель → доксин `stop` (`has_stopped`), плюс `record_check actor:"user"`
  как «внешняя приёмка» (`src/ir/approval.ts`).

Из `ankyra/docs/doxa_and_logos_ru.tex` (§«Арбитр») и статьи Ankyra, где Арбитр лишь
*выбирает операторы и момент остановки* (это **не** пер-целевая приёмка), пришли три вещи:

1. **Приёмка как событие.** `done_when.kind = "arbiter"` + `record_check actor:"user"`.
   В автономном прогоне пользователя нет → цель не закрывается никогда; коммит `ad28337`
   залатал тупик через `has_stopped` / `request_stopped`.
2. **Условная интерпретация** (`under` / `achieved_under`, `checkHasUnder`,
   `src/ir/graph.ts:83`) — в Ankyra центральна, у кодирующего агента референта нет.
3. **Двойной критерий** `objective` / `arbiter`.

**Наблюдаемый дефект.** `fix-ocaml-gc` (`bench/runs/sandbox-tasks/2026-10-08T19-10-07-157Z-…`)
завершился `request_stopped` за 14 ходов при **нуле мутаций**: модель создала
arbiter-подцель и сразу её остановила; движок принял, прогон закончился (reward 0).
Проблема не в `stop`, а в артефакте: `stop` — это *контроль*, а не критерий.

## 2. Целевая семантика

- **Одно закрытие: `stop`.** Кадр (цель или запрос) закрыт **тогда и только тогда**, когда
  есть ребро `has_stopped`. Докса предлагает `stop`; движок его гейтит. (Позже: пользователь
  может принудительно остановить/приостановить; сейчас — нет.)
- **Чек — это прогон команды-критерия цели.** Никакого узла `check`, `verdict`, ребра
  `verifies`, `inconclusive`. `run` порождает обычную `observation` с `command`, `target?`,
  `exitCode`; **`pass ⇔ exitCode === 0`**, `fail ⇔ exitCode !== 0`. Недеcisive-прогон
  (таймаут / крэш) — просто обсервация **без** `exitCode`.
- **Никаких статусов у целей.** Производные: у действия `executed`; у цели `open | stopped`;
  у запроса `addressed` (выбранная интерпретация `stopped`). Успех/отказ читаются из
  обсервации-критерия, а не хранятся как `achieved` / `refuted`.
- **Логика продолжения читает факты.** Допустимый ход на открытой цели зависит от её
  последней обсервации-критерия:
  - целевого прогона нет → прогнать критерий (`run {target}`);
  - `exitCode 0` (pass) → можно `stop`;
  - `exitCode != 0` (fail) → добавить альтернативу (`create_goal {revises}`); либо, **если
    план исчерпан**, `stop` (честный отказ).
- **Жёсткий гейт для `stop`** (согласовано):
  - на **цели**: принимается **iff** критерий прошёл, **или** (не прошёл **и** нет
    невыполненных пунктов плана — докса действительно прошла свой план);
  - на **запросе**: принимается **iff** выбранная интерпретация `stopped`.
- **Убираем:** `done_when.kind` / `arbiter`, `src/ir/approval.ts`, `under` / `achieved_under`,
  узел `check` + событие `record_check` + ребро `verifies` + `verdict` + `inconclusive`,
  производные предикаты `achieved` / `refuted` / `abandoned`, авто-выталкивание по `achieved`.

## 3. Инварианты (переписаны)

- Цель не закрывается без `stop` (`has_stopped`); запрос заканчивается только на своём `stop`.
- Цель не может быть *остановлена как удовлетворённая* без прошедшей обсервации-критерия
  (`exitCode 0`): провенанс чека сохраняется. `stop` без pass — это отказ, и он виден в
  фактах (последний результат критерия — не pass).
- `project` детерминирован: одни события → один `Context`.
- докса предлагает; логос (движок) гейтит и выводит.

## 4. Модель (формы)

- **payload цели:** `{ what, why?, done_when: string /* команда-критерий */, plan: string /* набросок */ }`.
- **payload обсервации (run):** `{ command, target?, exitCode?, output?/outputRef?,
  error?/errorRef?, witness?, signal?, … }`.
- **рёбра:** `has_plan`, `item`, `chosen`, `has_alternatives`, `produces`, `mutates`,
  `has_stopped` (убрать `verifies`, `under`).
- **хелперы:** `criterionResult(state, goalId)` = последняя обсервация с `target === goalId`;
  `criterionPass` = её `exitCode === 0`; `planExhausted(state, goalId)` = нет невыполненных
  пунктов плана.

## 5. Шаги (каждый шаг зелёный)

После каждого: `npm run typecheck` и `SKEIN_LIVE=false npx vitest run`.

### Шаг 1 — гейт `stop` (сам фикс, только движок)
- `src/ir/graph.ts` (или хелпер): `criterionPass(state, goalId)` и `planExhausted(...)`
  (критерий читается из текущего `check`/обсервации).
- `src/loop/classify.ts` `stop`: принимать цель **iff** `criterionPass` **или**
  `planExhausted`; сохранить сообщения отказов (`check_not_run` для objective-цели, которая
  ещё может работать, `not_addressed` для запроса). Добавить `focusHint`.
- `src/ir/traversal.ts` `applicable`: `stop` предлагается при том же условии, чтобы фронтьер
  и гейт совпадали.
- Тесты: расширить `tests/ops/stop.test.ts` — цель без работы отклоняется
  (`check_not_run`); цель, чей критерий провалился **и** план исчерпан, принимается;
  прошедшая цель принимается.

**Проверка:** typecheck + offline зелёные. Цель с неисчерпанным планом больше нельзя
остановить (стоп без работы исчезает). Наблюдаемый отказ `fix-ocaml-gc` был при
**исчерпанном** плане, поэтому один этот гейт тот прогон не меняет — полный фикс это гейт
**плюс** шаг 2 (убрать лазейку `arbiter`) и промт (шаг 5).

### Шаг 2 — убрать `arbiter` (и `under`)
- `src/llm/schemas.ts` / `src/llm/tools.ts` / `create_goal`: `done_when` становится
  **строкой-командой**; убрать ветку `arbiter` и `under`.
- `src/ir/types.ts`: `GoalPayload.done_when: string`; убрать `under` из payload'ов узлов/чеков.
- `src/ir/graph.ts`: убрать `checkHasUnder`, `achieved_under`.
- удалить `src/ir/approval.ts`; убрать путь приёмки `actor`-`user`.
- `src/loop/classify.ts` / `src/tools/index.ts`: убрать ветку
  `arbiter_goal_needs_acceptance`, принятие `stop` на arbiter-цели и `request_stopped` как
  «передано арбитру».
- промт B6 (запрос называет команду ⇒ objective) теряет arbiter-пару.
- Тесты: `tests/ops/create_goal.test.ts`, `tests/ops/stop.test.ts`, `tests/loop.test.ts`.

**Проверка:** typecheck + offline зелёные.

### Шаг 3 — свернуть `check` в `observation`
- `src/tools/index.ts` `run`: всегда писать `observation` с `{ command, target?, exitCode,
  output/error }`; без `record_check`, без id `chk:`, без `verdict` / `inconclusive`;
  перенести `witness` прогона на обсервацию.
- `src/ir/events.ts` / `src/ir/types.ts`: убрать событие `record_check`, вид узла `check`,
  `verdict`, `under` и поля чека на ребре `produces`.
- `src/ir/graph.ts`: убрать `latestClosingCheck`, `goalPredicate`, `requestPredicate`;
  `criterionResult` читает обсервации с `target`.
- `src/loop/observe.ts`: читать `witness` из обсерваций.
- `src/loop/classify.ts` / `src/ir/traversal.ts` / `src/ir/project.ts`: переключить на
  `criterionResult` / `has_stopped`; проекция показывает последнюю обсервацию-критерий
  (команда + код выхода) вместо строки чека.
- Тесты: `tests/ops/apply.test.ts`, `tests/ops/derivation.test.ts`, `tests/ops/query.test.ts`,
  `tests/loop.test.ts`, `tests/observe.test.ts`, `tests/crash.test.ts`.

**Проверка:** typecheck + offline зелёные.

### Шаг 4 — traversal: единственное закрытие `has_stopped`
- `src/ir/traversal.ts`: `isFinished` = `hasStopped` (цель/запрос) — убрать ветку
  closed-predicate и `isSettledSuccess`; `itemFulfilled` = действие `executed` / цель
  `has_stopped`; убрать `itemSucceeded`; переключить `cursorOf` / `applicable` / `focusEvents`.
- Следствие: после `pass` докса обязана явно `stop`-нуть цель — лишний ход, но единообразно.
- Тесты: `tests/ops/traversal.test.ts`, `tests/ops/applicable.test.ts`,
  `tests/ops/ir_properties.test.ts`, `tests/loop.test.ts`, `tests/workingset.test.ts`.

**Проверка:** typecheck + offline зелёные.

### Шаг 5 — промт
- `src/loop/prompt/blocks.ts` + `docs/system_prompt{,_ru}.md`: убрать текст про арбитра;
  сказать, что у каждой цели командный критерий; что после `pass` идёт `stop`; что `stop`
  без pass допустим **только когда план исчерпан** (честный отказ); что запрос стопается,
  когда его интерпретация закрыта.

**Проверка:** `tests/prompt.test.ts` + offline зелёные.

### Шаг 6 — документация (**обязательно**, не пропускать)
Обновить в том же коммите, что и код, чтобы не потерять достижения:

- `docs/ir_semantics{,_ru}.md` — §2 виды узлов (без `check`), §4.2 команда/чек, §4.3 `stop`
  (единственное закрытие + гейт), §6 завершение (факты, без приёмки), инварианты.
- `docs/ir{,_ru}.md` — as-built: `done_when` как команда, `run {target}`, факты-обсервации.
- `docs/ir_operations{,_ru}.md` — `OP-ST` (гейт), `OP-AP-RUN` (прогон критерия), убрать id
  `record_check` / `arbiter_goal_needs_acceptance`.
- `docs/projection{,_ru}.md` — обсервация-критерий вместо строки чека.
- `docs/concepts{,_ru}.md`, `docs/logos_ir{,_ru}.md` — арбитр больше не пер-целевая приёмка;
  докса предлагает, движок гейтит, `stop` закрывает.
- `docs/tools{,_ru}.md` — `run {target}` (критерий фокусной цели) и код выхода как факт
  pass/fail.
- `docs/plans/traversal_stack_spec{,_ru}.md` §9 — верификация = код выхода целевого прогона.
- `docs/plans/implementation_plan{,_ru}.md` — отметить работу сделанной; обновить §3.
- `docs/benches/bench_report{,_ru}.md` — отметить фикс premature stop и повторный прогон
  `fix-ocaml-gc` в песочнице.
- `AGENTS.md` (корень репозитория) — переписать инвариант «an arbiter goal only by external
  acceptance» на «goal закрывается только `stop`; `stop` без прошедшей обсервации-критерия —
  это отказ».
- Переместить этот план в `docs/plans/archive/` по завершении.

### Шаг 7 — smoke в песочнице и отчёт
- Перепрогнать `fix-ocaml-gc` и ещё одну задачу в песочнице (один осознанный прогон), чтобы
  подтвердить отсутствие premature stop и что прогон критерия виден как обсервация.
- Обновить `docs/benches/bench_report{,_ru}.md` §4.8/§4.9 результатом.

## 6. Тесты

- `tests/ops/stop.test.ts` — гейт (pass, fail+исчерпанный план, отказ без работы).
- `tests/ops/derivation.test.ts` — только `executed` / `stopped` / `addressed`; без
  `achieved`/`refuted`/`achieved_under`.
- `tests/ops/apply.test.ts` — `run {target}` даёт обсервацию с `exitCode`; pass/fail производны.
- `tests/ops/traversal.test.ts`, `tests/ops/applicable.test.ts` — фронтьер предлагает `stop`
  ровно тогда, когда гейт принимает.
- `tests/ops/ir_properties.test.ts` — фронтьер не предлагает оператор, который гейт отвергает.
- `tests/loop.test.ts` — цель выходит из стека только по `stop`; запрос заканчивается только
  на своём stop.
- `tests/coverage.test.ts` — id реестра согласованы с `docs/ir_operations.md`.

## 7. Карта файлов

- Ядро: `src/ir/{types,events,graph,traversal,project}.ts`, `src/loop/{classify,observe}.ts`,
  `src/tools/index.ts`, `src/llm/{schemas,tools}.ts`, `src/loop/prompt/blocks.ts`,
  удалить `src/ir/approval.ts`.
- Тесты: `tests/ops/{stop,derivation,apply,traversal,applicable,ir_properties,create_goal}.test.ts`,
  `tests/{loop,observe,crash,workingset,prompt}.test.ts`, `tests/live/ir_operations_step.test.ts`.
- Документация (§6): файлы оттуда плюс `docs/README.md` (индекс) и перенос этого плана в архив.

## 8. Открытые вопросы

- **`revises`.** Сейчас требуется, когда фокусная цель `refuted`. Переключить на «обсервация
  критерия провалилась» — или упростить `revises` вообще (оставить только механизм
  альтернатив)? Решить на шаге 2.
- **`request_stopped`.** Оставить как терминальную причину отказа (выбранная интерпретация
  закрыта без pass) для отчёта прогона, или сообщать только `request_addressed`? Склоняюсь
  оставить обе, производные.
- **`run {target}`.** Оставляем (согласовано): различает вложенные цели с одинаковой командой
  и помечает обсервацию, заменяя `verifies` обычным полем.
