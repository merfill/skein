# Handoff — текущее состояние

> Рабочий документ передачи. Английского зеркала нет. История изменений по датам удалена:
> она остаётся в git. Здесь — только текущее состояние и последняя выполненная работа.

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
