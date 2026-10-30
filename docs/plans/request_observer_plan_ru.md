# Tier 4a — RequestObserver: триггеры, observer-unit, hint/memo/halt

> Английское зеркало — `docs/plans/request_observer_plan.md`.
>
> Статус: **4a реализован** и проверен на синтетических live-сценариях (`entry`, `long`);
> реальные задачи и калибровка порогов ещё впереди. Объём — только 4a. Не входит:
> операции и статусы сессии (4b), прерывание пользователем.

## 1. Цель

Собрать минимальный контур управления: детерминированный триггер → observer-unit → `hint`,
`memo` или `halt`, поверх минимальной сессии. Семантика дерева задачи не меняется:
состояние закрывается только `stop` доксы, журнал только растёт, проекция детерминирована.
Заодно убираются `nudge` и терминальный `no_progress`.

## 2. Зафиксированные входы

- `docs/controllability_ru.md` §8: слои разведены; минимальная сессия в 4a; стек unit'ов;
  посев обзора — событие журнала; пороги переписываются; `nudge` удалён; реакции — `hint`,
  `memo`, `halt`.
- `docs/session_concepts_ru.md` §2/§10: `Session = (J_s, U, stack, pending)`, `focus` —
  вершина стека; для 4a нужен только каркас, без операций и статусов внимания.
- Инварианты: журнал только дописывается; `project` детерминирован; закрытие — только
  `stop`; никаких хранимых вердиктов и статусов истины; `hint`/`memo` — не `user`-turn и не
  считаются знанием задачи.

## 3. Объём

**Входит:**

- контейнер сессии: журнал сессии, unit'ы, стек, `pending`; без операций сессии;
- детерминированный детектор триггеров: `budget`, `state_cycle`, `state_long`;
- observer-unit: свой журнал, свой промпт, read-only-инструменты обзора, посеянный движком
  обзор;
- реакции `hint`, `memo`, `halt`; логос проверяет и применяет;
- `hint`/`memo` в журнале задачи, рендер как `system`;
- удаление `nudge` и терминального `no_progress`; `max_turns` остаётся абсолютным
  предохранителем;
- офлайн-тесты и обновление as-built-доков после реализации.

**Не входит:**

- операции сессии `respond`/`resume`/`revise`/`redirect`/`cancel`/`query` и статусы
  внимания — 4b;
- прерывание пользователем — отдельная задача;
- отзыв `memo` и `pin`/`warn`/`constrain`;
- similarity/RAG;
- live/bench-прогоны без явного go-ahead.

## 4. Целевая архитектура

### 4.1. Сессия

- `src/session/types.ts`: `Unit { id, type: "task"|"observer"|"session", journal: Event[], turn }`,
  `UnitRef { unitId, turn }`, `SessionState { journal: SessionEvent[], units: Map, stack:
  UnitRef[], pending?: PendingUtterance }`.
- `SessionEvent` — отдельный закрытый union: `open_unit`, `push`, `pop`, `trigger`,
  `reaction`. Это не `Event` задачи; журналы не смешиваются.
- `src/session/session.ts`: append-only; `focus = stack top`; `push`/`pop`; никаких копий
  контекстов — только id и точки возврата.
- `AgentInput.session?` для возобновления, `AgentResult.session` в результате. Без сессии
  `runAgent` работает как раньше (observer-путь выключен).

### 4.2. Узлы и provenance

- Мета-журнал использует **обычные** `action`/`observation` узлы: payload `{ origin: "engine"
  | "doxa", tool, args, callId, result }`. Отдельных `observer_call`/`observer_result` нет.
- В `WORK_KINDS` добавляются только `hint` и `memo`. `trigger` остаётся событием журнала
  сессии, а не узлом IR.
- Provenance узлов — `payload.origin` (у `Node` нет поля provenance).
- `fold` принимает новых членов; `project` рендерит `hint`/`memo` как `system`.
  Мета-журнал в `project` задачи не попадает.

### 4.3. Детектор триггеров

- `src/session/triggers.ts`: `detectTriggers(state, session, unit) → Trigger[]`; чистая
  функция, без завершений и советов.
- `Trigger { id, kind, anchor, evidence: string[], epoch }`.
- Счётчики — производные поля `State`, а не перезапись узлов: `stateEntries` считается в
  `fold` по `move`, `stateTurns` = текущий ход минус `move.turn`.
- `state_cycle`: третий вход в тот же остров через `move`; один раз на текущий `move`.
  Порог — `SKEIN_STATE_CYCLE_ENTRIES` (по умолчанию 3).
- `state_long`: `stateTurns > 20`; один раз на текущий `move`.
  Порог — `SKEIN_STATE_LONG_TURNS` (по умолчанию 20).
- `budget`: ходов осталось меньше K (`SKEIN_BUDGET_TURNS`, по умолчанию 3). Триггер
  подавляется, если фокус в терминальном острове
  или запрос уже почти закрыт — тогда движок даёт доработать.
- Стагнация по ключу знания **не детектируется**. `repeat`, `reasoning_bloat` — этап 2.

### 4.4. Мета-unit

- `src/session/observer.ts`: `runRequestObserver(deps, trigger, taskState) → { journal, decision }`.
- Посев записывается в журнал observer-unit'а обычными `action`/`observation` узлами с
  `payload.origin: "engine"` и парным `callId`:
  - `system`: observer-промпт и факты триггера (`kind`, `anchor`, evidence id);
  - `assistant`: вызов `outline` → `tool`-результат;
  - `assistant`: вызов `state(anchor)` → `tool`-результат;
  - при необходимости — `body(evidence)`.
- Модель observer-unit'а: отдельная схема (`src/llm/observer_schemas.ts`), инструменты `outline`,
  `state`, `turns`, `attempt`, `body`, `rendered`; решение — `hint`, `memo` или `halt`.
- `buildObserverMessages` переиспользует `TapeMessage`/`toMessage`; у него свой
  `OBSERVER_BASE_PROMPT` и нет task-хвостов ситуации.
- Цикл: не более M ходов (стартово 6), одна реакция за прогон; read-only-вызовы
  исполняются и пишутся в журнал observer-unit'а; отказ логоса — запись, одна повторная
  попытка, затем завершение без реакции.
- Ограничение вложенности: `maxObserverDepth = 1` для 4a; инфраструктура `ObserverDeps.maxDepth`
  и `observerDepth` уже есть, запуск вложенных — будущее.

### 4.5. `hint` и `memo`

- `src/session/apply.ts`: предусловия — evidence id существуют в дереве задачи; текст
  непустой и ограничен; `kind` из закрытого списка.
- `hint` — совет на **текущее состояние**: `add_node` с `kind: "hint"`, `payload: { text,
  evidence, origin: "observer", sourceUnit, scope: "state", state: currentMoveId }`. Рендерится
  как `system` после плана открытого состояния; после `stop` состояния с ленты уходит, но
  остаётся в журнале.
- `memo` — постоянный совет на **unit**: `add_node` с `kind: "memo"`, `payload: { text,
  evidence, origin: "observer", sourceUnit, scope: "unit" }`. Рендерится как `system` в каждом
  открытом состоянии до конца запроса. Отзыва в 4a нет.
- Оба пишут `reaction` в журнал сессии; отказ отклонённой реакции пишется в журнал
  observer-unit'а, а не задачи.

### 4.6. `halt`

- `Decision.halt` → `progress` выставляет `done: true`, `stopReason: "observer_halt"`,
  `stopText: reason`.
- `stop`-узел не пишется, состояние не закрывается, частичный журнал сохраняется.
- Прерывание пользователем позже даст `user_interrupt` через тот же surface результата.

### 4.7. Интеграция в цикл

- `progress` уже вызывается после `execute` и смотрит журнал (`src/loop/graph.ts:206-234`).
  Делаем его **async** и встраиваем observer-путь туда — отдельный узел `supervise` не нужен.
- Порядок в `progress`:
  1. если `state.done` — выйти;
  2. проверить закрытие запроса (`request_addressed`);
  3. `detectTriggers`; если триггер есть и бюджет observer-unit'а не исчерпан — push observer-unit,
     `runRequestObserver`, pop; применить `hint`/`memo`/`halt`;
  4. проверить `max_turns`; если текущий остров `end|patch|recovery|construction`,
     один раз дать ещё `G` ходов (`SKEIN_GRACE_TURNS`); иначе завершить; при `halt` —
     `done`/`observer_halt`.
- `LoopState` получает `session`; `AgentResult` возвращает сессию.
- В live/bench observer включён по умолчанию; `SKEIN_OBSERVER=false` отключает его.
- `progress` остаётся единственной точкой после хода; `stall`/`no_progress` из него
  удаляются.
- Если позже понадобится разделить ответственность, observer-путь можно вынести в отдельный
  async-узел между `execute` и `progress`; семантика та же.

### 4.8. Удаление `nudge` и `no_progress`

- Удалить `Context.nudge`, `ProjectOptions.stall` и текст (`src/ir/project.ts:73-84,
  481-483`), передачу `stall` (`src/loop/graph.ts:105`), `noProgress`/`stall`-логику
  (`src/loop/graph.ts:84, 206-234`), `LoopState.stall`.
- `max_turns` остаётся абсолютным предохранителем; бюджетный триггер срабатывает до него.
- Для `end|patch|recovery|construction` — один раз +`G` ходов при достижении `max_turns`
  (`SKEIN_GRACE_TURNS`, по умолчанию 5), с жёстким потолком `max_turns + G`.
- После реализации обновить as-built-описания `ir_semantics`/`projection`.

## 5. Порядок работ

1. **Каркас сессии.** `src/session/types.ts`, `session.ts`; журнал/стек; тесты. Поведение
   задачи не меняется.
2. **Удаление nudge/no_progress.** Изолированное изменение поведения; поправить
   `tests/prompt.test.ts`, `tests/loop.test.ts`, `tests/state_transitions*`; `max_turns`
   сохранить.
3. **Детектор бюджета, цикла и длинного состояния.** `triggers.ts`, тесты на
   порог/сброс/детерминизм, подавление у терминала и счётчики `stateEntries`/`stateTurns`.
4. **Журнал observer-unit'а и посев.** `action`/`observation` в журнале observer-unit'а,
   `projectObserver`, engine-origin, replay-тесты.
5. **Мета-модель и инструменты.** Схема, `invokeObserverTools` (или обобщение
   `invokeTools`), `outline`/`state`/`turns`/`attempt`/`body`/`rendered`, bounded loop,
   отказ/повтор.
6. **Hint и memo.** Применение, рендер, тесты на свидетельства, закрытие состояния и
   постоянство memo.
7. **Halt и async `progress`.** `AgentResult.session`, интеграционные тесты.
8. **Этап 2.** `repeat`/`reasoning_bloat`; вложенные observer-триггеры поверх уже
   готовой инфраструктуры `maxDepth` — после ревью первого среза.
9. **Доки.** `ir_semantics`, `projection`, README; финальный офлайн-прогон.

## 6. Тест-инварианты

- **Сессия:** журнал только растёт; `focus` — вершина стека; push/pop не переписывают
  unit'ы; `pending` не стек.
- **Детектор:** `state_cycle` — третий вход; `state_long` — больше 20 ходов; `budget` —
  в пределах K, не на жёстком лимите и не у терминала; одинаковые события → одинаковые
  триггеры.
- **Grace:** в `patch|recovery|construction|end` при `max_turns` даётся `G` ходов
  (`SKEIN_GRACE_TURNS`, по умолчанию 5) один раз;
  в остальных состояниях прогон завершается сразу.
- **Мета-unit:** посеянные вызов и результат имеют парные id и `origin: "engine"`; replay
  читает их из журнала; observer-инструменты read-only (не пишут в журнал задачи); одна
  реакция за прогон; отказ логоса не ломает задачу.
- **Hint/memo:** оба записаны в журнал задачи; на ленте — `system`, не `user`; `hint`
  исчезает при закрытии состояния, `memo` остаётся до конца запроса; неверный evidence
  отклоняется.
- **Цикл:** `nudge` в `Context` отсутствует; `no_progress` не терминален; `max_turns`
  работает; `halt` даёт `observer_halt` без `stop`-узла; закрытие запроса не изменилось.
- **Проекция:** детерминирована; порядок hint/memo стабилен; они не попадают в `user`-ход.
- Команды: `npm run typecheck`;
  `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'`.

## 7. Критерии приёмки

- Typecheck и офлайн-набор зелёные; новые тесты покрывают инварианты §6.
- Мета-unit не пишет в журнал задачи ничего, кроме `hint`/`memo`; не создаёт
  `move`/`stop`/`plan`.
- `hint`/`memo` видны задаче на следующем ходу как `system`; `halt` завершает прогон без
  `stop`.
- `nudge`/`no_progress` отсутствуют; `max_turns` и штатное закрытие сохранены.
- Бюджетный триггер срабатывает до `max_turns` и подавляется у терминала; без реакции
  observer-unit'а `max_turns` всё равно завершает прогон, кроме одного grace-окна
  (`SKEIN_GRACE_TURNS`, по умолчанию 5) в `patch|recovery|construction|end`.
- Одинаковый журнал/сессия дают одинаковый триггер и одинаковый observer-контекст (LLM-ответ
  реплеится из записанного журнала).
- Live/bench не запускались.

## 8. Риски и открытые вопросы

- **Форма посева.** `action`/`observation` в журнале observer-unit'а — нужна проверка на
  replay и wire-парность; отдельные kind'ы не вводятся.
- **Async `progress`.** В графе уже есть async-узел `proposeNode`; если async в `progress`
  окажется неудобен, observer-путь выносится в отдельный узел.
- **Жизнь `memo`.** В 4a отзыва нет; если понадобится, это операция 4b.
- **Стагнация.** В 4a не детектируется; `repeat`/`state_chain`/`reasoning_bloat` — этап 2.
- **Стоимость.** Каждый триггер — запуск observer-модели; пороги и observer budget должны это
  ограничивать. Живая оценка — позже и с go-ahead.
- **Обратная совместимость.** Новые kind'ы `hint`/`memo` ломают старый парсер журнала;
  прогоны короткоживущие, но это надо учесть в replay-харнессе.

## 9. Откат

- Сессия и observer-путь добавляются отдельными коммитами; без сессии `runAgent` работает как
  раньше (кроме удалённых nudge/no_progress — это отдельный коммит).
- Удаление nudge/no_progress откатывается revert'ом своего коммита.
- Новые kind'ы не требуют миграции существующих журналов: старые события читаются, новые
  появляются только в новых прогонах.
