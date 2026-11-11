# Handoff — текущее состояние

> Рабочий документ передачи. Английского зеркала нет. История изменений по датам удалена:
> она остаётся в git. Здесь — только текущее состояние и последняя выполненная работа.

## 2026-11-11 — `general`/`plan` без `move`; агенты в документации

### Что сделано

- **`move` убран из `general`/`plan`.** Обе единицы теперь request-anchored, как `document`:
  `request → turns`, `plan`/`stop` — рёбра от request. `seedGeneral`/`seedPlanner` создают
  `request`+`turns`; история и `messagesOf` читают request как якорь; `recordPlan` вешает `plan`
  и `stop` на request. `executeAction("stop")` замыкает request-якорь, `unitCompleted` для
  `general/plan/document` читает `stopOf(request)`. `session_outline.generalEnding` и
  `tui/view_model` тоже читают request; общая единица в TUI рендерится одной синтетической
  request-стадией (сохраняет ходы и токены), `plan` в общий TaskView не входит — у него PlanPanel.
- **Документация EN/RU синхронизирована.** `sessions.md` («сессии и агенты»): `document` в §1,
  пять операций, §9 «Агент общей задачи», §10 «Агент записи документа», observer §11; план —
  `kind general|task|document`, `document`-пункт открывается напрямую. `concepts.md`: шесть
  агентов и единиц, включая planner/document, пять операций. `ir.md`: тип «документ», пять
  операций, §1.4 «Документ», observer §1.5; убрана legacy «Чтение». `projection.md`: пункт
  `document` в блоке плана. Индексные README EN/RU.
- **Снят вопрос про отдельную TaskView-панель `document`:** не нужна.
- **Request-anchored единицы видны в памяти.** `unit`/`state`/`turns` трактуют
  `general`/`plan`/`document` как одно состояние с id единицы: `unitOutline` печатает якорь,
  `stateDetail` принимает request-якорь, описания инструментов session-агента обновлены; тест в
  `general_unit.test.ts`.
- **`general-live`**: убрана строгая проверка `## `-заголовка — ответ модели не переписываем.
- **Доки-скоуп.** `testing.md`/`system_prompt.md`/`tools.md`/`states.md` явно ограничивают себя
  агентом задачи и ссылаются на request-anchored единицы; `sessions.md` §2/§9/§10 называет их
  одним состоянием на request.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **654 passed / 40 skipped**
  (включая обновлённый `tests/general_unit.test.ts` с памятью request-anchored единиц).
- **Live `general-live`** (синтетический проект): маршрут `general`, 6 ходов, `done`, `stop=answered`,
  `completed`, без `move`; `stop`/`turns` на request. Единственный FAIL харнесса —
  ответ модели без `## `-заголовка (проверка стиля, не якоря).
- **Live `session-live`**: `routes=["general","respond","task"]`, `general` completed, task
  отработал — OK.
- **Live план `log-summary-date-ranges`** (Docker, 40 turns): plan 1/1, **reward=1**,
  acceptance pass, 9 ходов task — request-anchored план и закрытие по `stop` работают.
- **Live документ, полный путь** (временный скрипт вне репо, ~63 с): агент сессии сам выбрал
  `document`; 8 ходов, `done/summarized`, 5/5 секций, 21.3 KB; без `move`, `turns`+`stop` на
  request, `completed`, заголовки совпадают с outline — OK.

### Открыто

- Роутинг `document` — нужна серия live-прогонов (см. ниже, 2026-11-10).
- Новые правки (память request-anchored единиц, `general-live`, скоуп-заметки в доках) не
  закоммичены.
- Дальше — функциональные дыры плана (retry `abandoned`, отмена, rework, бюджет) и live-проверка
  авто-выбора `plan` агентом сессии.

## 2026-11-10 — юнит `document` (запись большого файла секциями)

### Что сделано

- **Новый юнит `document`.** Одна цель, без `move`/островов: лента висит на `request`
  (`turns`-контейнер и `stop` — рёбра прямо от request). Фазы: (1) `submit_plan` с `{path, items}`
  (read-only инспекция допустима), (2) по одному ходу на пункт — модель отдаёт **markdown-тело**
  секции, экзекутор дописывает `## <title>` в файл, (3) финальное summary из плана и файла.
  Число секций известно из JSON — остановку решает экзекутор, не модель.
- **Без тула `write_item`/append.** Тело секции — обычный text-reply; большой JSON-аргумент
  инструмента не эмитится, поэтому обрезка по `maxTokens` не превращается в `Unterminated
  string in JSON`. Обрезка секции (`finishReason=length`) → continuation-запрос (bounded).
- **Интеграция.** `PlanItemKind += "document"` (планировщик помечает пункт и называет путь);
  `executePlan` открывает юнит напрямую, без переинтерпретации session-агентом; добавлена
  прямая операция сессии `document`. `PausedState`/resume/cancel, progress/telemetry, outline.
- **Wiring.** `src/session/document.ts` (runner), `src/llm/document.ts` (outline- и text-агенты),
  `src/cli.ts` (deps). Тест `tests/document_unit.test.ts`.
- **Роутинг.** Первый live-прогон ушёл в `document`, второй на тот же запрос — в `general`
  (модель решает сама). Промпт session-агента и описания операций усилены: файл как deliverable
  → `document`, `general` файлов не создаёт, `task` — для кода/мелких правок.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — зелёный (включая
  `document_unit`: outline→секции→summary, continuation, plan-item, прямая операция, resume).
- **Live (deepseek-v4-flash, `/tmp/opencode/doc-live`).** Запрос «Создай большой Markdown-документ
  `docs/guide.md` по `spec.md`» → операция `document`: outline из 4 секций (Introduction,
  Overview, API, Example), 10 вызовов, файл 18.4 KB / 275 строк, заголовки чистые (`##` секции от
  экзекутора, `###` подразделы от модели). Токены: input 44 369 (cache 18 560 → fresh 25 809),
  output 10 695, reasoning 2 462. До фикса модели писала собственные `#`/`##` внутри тела —
  заголовок дублировался (`## Example` + `# Example`); в промпте секций теперь запрещены `#`/`##`.

### Открыто

- Роутинг `document` — модельный; после усиления промпта один live-прогон попал верно, но нужна
  серия прогонов (или явная эвристика «есть путь к файлу»), чтобы оценить стабильность.

## 2026-11-10 — план в TUI, бюджет, единый лимит, диффы, планировщик

### Что сделано

- **TUI: план в правой панели.** `PlanPanel` (building/ready/executing) с пунктами,
  прогрессом и активным пунктом; текущая задача — юнит активного пункта (`unit.planItem`);
  меню плана — командами `/execute` / `/rework` / `/plan` (без модального перехвата клавиш),
  подсказки в футере. Отчёты пунктов и acceptance рендерятся отдельными Markdown-блоками.
- **Бюджет ходов.** На пределе task-юнита — пауза `budget` (не обрыв): `[c]ontinue +N`
  (`SKEIN_BUDGET_EXTEND`, дефолт 10) и `[f]inish & report` (финальный отчёт). Headless
  (`runAgent` без `budgetPause`) сохраняет жёсткий `max_turns`. `plannerMaxTurns` 12→24;
  в `.env` задачи — `SKEIN_MAX_TURNS=48` (дефолт в коде 80, .env не коммитится).
- **Acceptance плана.** Перед `plan_finished done` read-only general-юнит проверяет исходный
  запрос и `done` каждого пункта, требует финальную строку `VERDICT: PASS`; FAIL/нет вердикта →
  план `aborted` с отчётом (`PlanExecutionResult.acceptance`, видно в TUI/REPL).
- **Единый inline-бюджет 8K** (`INLINE_LIMIT`): инспекция (`read`, `grep`, `list`, `recall`,
  `search`) — голова, команды (`bash`) — хвост; `read` 32K→8K, `recall` 64K→8K (листание
  `offset`/`start-end`). Убрана повторная обрезка до 2K в `planner.ts`/`general.ts`. Доки EN/RU
  (`projection.md`, `tools.md`) обновлены.
- **Диффы.** `edit`/`write`/`apply_patch` несут whole-file `before`/`after`
  (`ExecOutcome.diffs` → `tool_finished.diffs`); TUI рисует opencode-style unified diff (путь,
  номера старых/новых строк, цвета, контекст, `…`), мутации авто-разворачиваются. Остальные
  инструменты — тизер первых 5 строк + разворот по клику.
- **Планировщик.** Промпт: реализация обязана быть `coding`-пунктами, `general` — только
  read-only; запрет «собери факты, чтобы потом написать» без шага записи; язык плана = язык
  запроса. Финальный `submit_plan` запускается всегда при отсутствии плана; при обрезании по
  лимиту — ретрай с **выключенным reasoning** (тот же `maxTokens`), не bump.
- **TUI perf.** `traceLines`/`buildTuiView` мемоизированы; ввод/перемещение курсора больше не
  пересчитывают трейс и view.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **649 passed / 40 skipped**.
- Новые тесты: `tests/budget_pause.test.ts`, `tests/planner_model.test.ts`; обновлены
  `plan.test.ts`, `tui_app.test.tsx`, `tui_view_model.test.ts`, `tui_trace.test.ts`,
  `general_unit.test.ts`, `ops/apply.test.ts`, `budget_grace.test.ts`.

### Открыто

- Тяжёлые Docker/live прогоны не запускались (нужен go-ahead): live plan-исполнение,
  бюджет-пауза, planning с reasoning-off, acceptance.
- `abandoned`-пункт (`llm_error`, `no_decision`, `max_turns` старого пути) всё ещё останавливает
  план как `aborted`; retry/skip/возврат решения агенту сессии не сделаны. Бюджет-лимит теперь
  пауза, но остальные `abandoned` — нет.
- Отмена плана, rework с фидбеком/версиями, политика pause/leave/suspend пункта, общий бюджет
  плана, полный метеринг (planner/session/general) в `tests/sandbox/session-plan.ts`.
- Acceptance — model-verdict: free-text `done` не проверяется машинно; FAIL/отсутствие вердикта
  трактуется как abort. Стоит решить, нужен ли строгий формат / `toolChoice`.
- `.deep-memory/`, `.opencode/` — untracked, не наши, не коммитятся.

## 2026-11-08 — режим планирования (`plan` unit)

### Что сделано

- Новая единица `plan` — read-only разработка плана: `shell` разрешён, изменения при выходе
  откатываются (`rollback`, reason `plan-read-only`). Агент и цикл — `src/session/planner.ts`,
  провайдер — `src/llm/planner.ts`; терминальный инструмент `submit_plan`.
- IR: виды узлов `plan`/`plan_item`, связи `plan`/`plan_item`; пункт несёт `title`, `detail`,
  `kind` (`general|task`), `done`, `order`. Markdown плана — рендер узлов.
- Операция сессии `plan`; событие `plan_started`/`plan_finished`; связь `open_unit.planItem`.
  Режим, курсор и статусы пунктов выводятся из журналов (`src/session/plan.ts`).
- Драйвер: `executePlan` идёт по пунктам по порядку; на каждый пункт агент сессии вызывается
  заново и выбирает `task`/`general`, переформулируя наряд. Пункт — обычная единица с
  `planItem`; `completed` закрывает пункт, `abandoned` останавливает план (`plan_finished`
  `aborted`), после последнего — `plan_finished` `done (n/N)`.
- UI: план показывается Markdown-ом, меню `[e]xecute/[r]ework/[q]uit` в REPL и TUI; `rework`
  возвращает в диалог (новую `plan`-единицу открывает агент сессии); пауза пункта продолжает
  план после resume.
- Планировщик: если упёрся в `plannerMaxTurns`, делается финальный вызов только с `submit_plan`
  (иначе на большом дереве он читает все ходы и не успевает сдать план). Пункт ограничен
  `title ≤ 200`, `detail ≤ 4000`, `done ≤ 1000`, пунктов ≤ 12.
- Новый live-harness `tests/sandbox/session-plan.ts` (session-level): принудительный `plan`,
  `executePlan`, реальные агент сессии/планировщик/task/general, затем собственный verifier
  задачи; `--virtual` для дешёвого прогона спеки, `--turns`/`--net`/`--dir`.
- General-юнит, исполняющий пункт плана, получает отдельный бюджет
  `planGeneralMaxTurns` (`SKEIN_PLAN_GENERAL_MAX_TURNS`, дефолт 30) вместо обычного
  `generalMaxTurns` (9/10). Обычные general-вызовы не меняются; resume пункта тоже берёт
  план-бюджет.
- Доки RU/EN: `sessions.md`, `ir.md`, `projection.md`, `testing.md`.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **632 passed / 40 skipped**
  (включая 8 тестов `tests/plan.test.ts`: план-единица, авто-исполнение, abandoned-пункт,
  restore шелла, меню REPL, rework, план-блок в контексте, форсированный финальный `submit_plan`,
  увеличенный бюджет general-пункта).
- Live, виртуальный `fix-ocaml-gc`: план построен и исполнен; первый task-юнит завершился
  `llm_error` → план `aborted`, но правка легла и verifier дал reward=1.
- Live Docker `fix-ocaml-gc` (60 turns): **plan done 4/4, reward=1** (2 general → аудит → task
  фикс → general testsuite).
- Live Docker `custom-memory-heap-crash` (80 turns): **plan done 3/3, reward=1** (general → task →
  general verification). Трассы — `bench/runs/session-plan/`.

### Открыто

**Функциональные дыры (по приоритету):**

- `abandoned`-пункт (`llm_error`, `max_turns`, `no_decision`) останавливает план как `aborted`
  и навсегда блокирует план. Нужен retry пункта (новый unit с тем же `planItem`, статус по
  последней попытке), skip или возврат решения агенту сессии. Виртуальный `fix-ocaml-gc` это
  показал: reward=1, но план `aborted`.
- Живая проверка, что агент сессии **сам выбирает `plan`**: в harness первая операция
  форсируется, реальный route-choice не проверен. Это первое, что надо прогнать.
- Отмена плана (отложена): отмена текущего пункта, `plan_finished.aborted`, судьба уже
  сделанных пунктов и rollback.
- Rework UX: `[r]ework` лишь возвращает в диалог; нет явной «переработки с фидбеком» и
  понятия активной версии плана (старый план остаётся `started` без `finished`).
- Pause/leave/suspend посреди плана: resume пункта продолжает план, но `suspended`-пункт
  (leave) блокирует план без `PausedState` — меню пропадает. Нужна политика.

**Контроль и UX:**

- Бюджет плана целиком (суммарные ходы/пункты), а не только per-unit.
- Финальный отчёт по плану после `plan_finished` (сейчас только итоги юнитов).
- TUI: план-оверлей/прогресс в панели, явный режим `plan`, нормальный prompt для rework.
- У общего юнита вне плана остаётся `generalMaxTurns=9`; пункт плана получает
  `planGeneralMaxTurns=30`. Живой перепрогон с новым бюджетом не делался (деньги/время);
  офлайн-тест на override есть.

**Тесты и наблюдаемость:**

- Полный метеринг в `tests/sandbox/session-plan.ts`: сейчас считаются только task-юниты;
  planner/session/general не входят в токены/стоимость.
- Офлайн-кейсы: TUI-меню плана, pause/resume пункта, blocked/reply/no_decision, resume с
  план-бюджетом general, unit-тест `operationOf("plan")`.

**Процесс:**

- Рабочее дерево не закоммичено; в нём же прежние изменения (удалён `langgraph/graph.ts`,
  untracked `.deep-memory/`, `.opencode/`).
- `docs/en|ru/ir_operations.md` намеренно не расширялись: план — session-level артефакт, а не
  оператор задачи; coverage-реестр не менялся.

## 2026-11-08 — ревизия документации и чистка legacy

### Документация

- Концепции переписаны вокруг двух главных идей: **немонотонный контекст** и **состояния и
  переходы**. Убраны докса/логос, `acceptance`-идеология и старые термины.
- `ir.md` разделён на два документа:
  - `ir.md` — концептуальная модель: журнал, состояния, переходы, записи, контекст, инварианты;
  - `ir_operations.md` — справочник: поверхность модели, операторы, таблицы инструментов, отказы,
    реализация и матрица покрытия. Coverage-гейт читает `docs/en/ir_operations.md`.
- `projection.md` переписан под текущую ленту: запрос, краткая справка, `Start`, ходы, рабочий
  промпт, `Finish` + `Artifacts:`, `recall`/`search` как обычные ходы.
- `sessions.md` заменил `session_concepts.md`: сессия как контейнер единиц работы, следы, операции
  `respond`/`general`/`task`, изоляция, переформулировка, пауза/возврат/отмена, наблюдатель.
- `states.md` приведён к `src/ir/islands.ts`: текущие `what`, `Done when`, инструкции, переходы,
  поверхность инструментов.
- `system_prompt.md` очищен от фаз и старых блоков; описаны текущие `B1`/`B2` и ситуации
  `request`/`working`/`transition`/`terminal`.
- `testing.md` объединил `state_testing.md`; убраны Harbor и дублирующий раздел, исправлен дефолт
  `--turns` (80, у `fix-ocaml-gc` — 60).
- `tools.md` переписан как контракт модельных имён и параметров; `stop` больше не инструмент.
- `walkthrough.md` переписан под текущую проекцию; сквозной пример Patch → Verification (провал) →
  revert → Patch → Verification (успех) → End.
- `README.md`, `docs/README.md`, `docs/en|ru/README.md` и `AGENTS.md` осовременены; ссылки на
  удалённые документы убраны.

### Код

- Операция сессии `start` переименована в `task` (код, промпт, TUI, тесты, доки).
- `doxa`/`logos` заменены на `model`/`executor` в комментариях и provenance-значениях.
- Удалён legacy reading-юнит: `src/session/reading.ts`, тип `"reading"`, `readFile`-проброс через
  `session_agent`/`session_memory`, обработка в `session.ts`/`session_outline.ts` и тесты.
- `session_workspace.ts` урезан до production-части: `generalFactsText` и
  `projectInstructionsText`.
- Удалены неиспользуемые экспорты: `stackOf`, `isFinished`, `probeBrief`, `workspaceBrief`,
  `noopTelemetry`, `contextTimeline`, `noopProgress`.
- Удалён shim `tests/sandbox/checkpoint.ts`; импорты переведены на `src/tools/checkpoint`.
- Удалены мёртвые bench-инструменты: `bench/minimal.ts`, `bench/reasoning-breakdown.ts`,
  `bench/opencode-prompts/`.
- Удалены Harbor и LangGraph: `bench/harbor/`, `langgraph/`, `langgraph.json`,
  `bench/agents_compare.ts`, скрипт `bench:compare`. Текущий runner — `tests/sandbox/**`.
- Удалён `fixtures/synthetic/` (ссылок не было).
- В тестах и комментариях `tests/sandbox/**` заменены упоминания Harbor на benchmark/task cache.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **624 passed / 40 skipped**.
- Виртуальная песочница — **10 passed**.
- `tests/coverage.test.ts` — 2/2, все 95 ID сохранены.

### Открыто

- Тяжёлые Docker/live прогоны не запускались: нужен явный go-ahead владельца.
- В `src/ir/islands.ts` и цитатах критериев остаётся слово `acceptance` — это фактический текст
  текущих критериев; отдельно решить, переименовывать ли его.
- `bench/step_compare.ts` оставлен как офлайн-анализ метрик, но не документирован.
- Рабочее дерево не закоммичено; коммит не делался.
- Исторические записи handoff удалены из файла и остаются в git.
