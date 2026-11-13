# Handoff — текущее состояние

> Рабочий документ передачи. Английского зеркала нет. История изменений по датам удалена:
> она остаётся в git. Здесь — только текущее состояние и последняя выполненная работа.

## 2026-11-13 — метеринг всей сессии в harness; токены пунктов в PlanPanel

### Что сделано

- **`tests/sandbox/session-plan.ts` метрит всю сессию.** `memoryTelemetry()` проброшен в
  `sessionAgent`/`task`/`general`/`planner` (+ верхний `telemetry`), поэтому `model_call` пишут
  все циклы. `run.json.usage` — `usageTotals` по всем агентам плюс разбивка `byAgent`
  (`session/plan/task/general/revision/document`); `TurnMeter` и комментарий «task only» убраны;
  в финальный лог добавлены `in/out/rsn/cost`.
- **`usageOf` несёт cost.** Если провайдер отдаёт `usage.raw.cost`, он попадает в `Usage.cost`
  (поле и `usageTotals.cost` уже были, но нигде не заполнялись).
- **PlanPanel: ходы и токены пункта.** `PlanItemView` получил `turns/tokensIn/tokensOut`;
  `buildPlanView` агрегирует их по юнитам пункта через `unitStats`; `planItemRow` печатает
  `· Nt in/out` после заголовка (у ещё не открытых пунктов — пусто).

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **650 passed / 40 skipped**.
- `tests/tui_view_model.test.ts`: пункт плана показывает `turns/tokensIn/tokensOut` своего юнита.
- **Live virtual `fix-ocaml-gc`** (20 turns): план done 3/3, reward=1. `usage`: 74 calls,
  in 307701 / out 19303 / rsn 5664 / cache 188416 / cost 7.13; `byAgent` — session 34,
  plan 5, task 18, general 17 (cost заполняется провайдером). Раньше task-only показал бы
  18 calls / 73931 in.

### Открыто

- Реальный Docker-прогон harness'а не делался (только virtual).
- Working tree не закоммичен.

## 2026-11-13 — session-агент: промпты в одном файле, память убрана

### Что сделано

- **Промпты session-агента сведены в один файл.** `SESSION_AGENT_BASE_PROMPT`, описания шести
  операций, `request`-описания, repair/invalid — в `src/session/session_agent_prompts.ts`;
  `src/llm/session_agent.ts` и `src/session/session_agent.ts` импортируют оттуда. Тексты перенесены
  байт-в-байт (сверено с HEAD).
- **У session-агента больше нет памяти.** Удалены тулы `unit`/`state`/`turns`/`body`/`search`,
  `SessionTools`/`createSessionTools`/`defaultSessionTools`, `executeTool`, `toolCalls` в
  `SessionReply`, `tools` в deps, `surveyLimit`/`surveys` и `SESSION_FORCED_DECISION_MESSAGE`.
  Агент сессии — только `respond` + операции `general/revision/write_document/task/plan`, один
  вызов модели на реплику (цикл и `maxTurns` у сессии убраны).
- **Удалён `src/session/session_memory.ts`** и его тест (после удаления тулов не использовался).
  `session_outline.ts` (L0) остаётся — он нужен `sessionOutline` и TUI.
- **Тесты**: memory-тесты удалены/переписаны; `session_scenario` проверяет ответ из L0-трейса;
  `session_pause` — паузу до применения операции; из моков убраны `tools`/`toolCalls`.
- **Доки EN/RU**: `sessions.md` §2/§3/§4, `concepts.md`, `projection.md`, `ir.md`, `README.md` —
  след сессии описан как сводка L0 без инструментов истории.
- **Формулировки операций разнесены по типу работы:** `task` — только код (фича/дефект/рефакторинг/
  поиск причины); `revision` — выполнить команду или операцию (тесты, сборка, пример/демо, git,
  зависимости/lock) и не-кодовые правки; `general` — вопрос/объяснение по рабочей области без
  изменений. Слово «mutable» из описаний убрано; `request` у `revision` — «команда/операция и
  done condition».

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **650 passed / 40 skipped**.
- **Live route matrix** (10 реплик × 5): «запусти пример с z3 и покажи вывод» → `revision` 5/5,
  «прогони тесты» → `revision` 5/5, `task`/`document` — 5/5, «объясни engine/clause.py» → `general`
  5/5. «что изменено в рабочей копии?» — `revision` 2 / `general` 3: обе приемлемы (read-only-запрос).

### Открыто

- Многоходовый REPL-пробник маршрутизации не запускался (только одиночные реплики).
- Working tree не закоммичен; `src/session/session_agent_prompts.ts` — новый файл.
- Sandbox/live-сценарии (`tests/sandbox/**`) не запускались.

## 2026-11-12 — revision: описанные мутации, task — только кодирование

### Что сделано

- **Роутинг сессии выровнен с назначением `revision`.** Причина — лог в `~/dev/ankyra`: сессия
  выбрала `task`, потому что его описание обещало «run side-effecting commands»; внутри `task`
  запрос ушёл в `Research` («all other cases»), сделал dry-run коммита на копии и пошёл искать
  дефект. `revision` сессия рассмотрела и отвергла: «covers edits to existing files; commit and
  push are commands».
- **Описания тулов.** `revision` — «Use it for any mutable operation the request describes on the
  existing workspace, except coding…»; `task` — «Write new code, fix a defect, or find a cause».
  Из `task` убран «run side-effecting commands»; cross-reference на `revision`/`write_document`
  из него убран.
- **`REVISION_BASE_PROMPT`.** «You make the change or run the operation…», команды включая
  side-effecting.
- **Доки EN/RU.** `sessions.md` §1/§3/§10 и `concepts.md` (таблица и абзац) — `revision` описан
  как мутабельная операция, кроме кодирования.
- **Не трогали:** `decline` и request-промпт task'а. `decline` — до-сессионный артефакт; роутинг
  остаётся работой агента сессии.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **657 passed / 40 skipped**.
- Живой probe (5 прогонов, только выбор операции): коммит/пуш → `revision` 5/5; зависимость/lock →
  `revision` 5/5; баг/новый файл → `task` 5/5; документ → `document` 5/5; read-only вопрос →
  `general` 5/5; «прогони тесты» → `revision` 4/5, `task` 1/5.
- **E2E `revision`** на временном репо с bare-remote: 5 ходов, `git add/commit/push`; коммит
  `f498a53` в `origin/main`, дерево чистое, код не менялся.

### Открыто

- «прогони тесты» иногда (1/5) уходит в `task`; наблюдать.
- Пробники `.route-matrix.ts`, `.revision-e2e.ts` — untracked, в коммит не входят.

## 2026-11-12 — session prompts: write_document, verbatim, gather 10+3

### Что сделано

- **Краткость и язык отчётов.** End/B2/general/revision: положительная формулировка «коротко и по
  возможности, детали — только если просили»; язык — «Answer in the same language the user asked
  in». Document: H1 из `title`, скоуп «только по теме/запросу».
- **TUI: document-юнит в панели.** `view_model` не знал `document` (фильтр, requestAnchored,
  агент) — добавлен; регрессионный тест.
- **Document: `start_document`, две фазы, гейт.** `submit_plan` → `start_document`; gather —
  read-only + `webfetch`; write — без инструментов, ответ с tool-разметкой/пустой отбрасывается
  (ретрай, затем `invalid_section`); сбор ограничен 10 шагами, затем предупреждение + 3, затем
  принудительный `start_document` (`toolChoice: "required"`); в описании `start_document` —
  «plan the structure around the request: include only information directly related to it».
- **Session agent: убран workspace system message** (и мёртвые поля/`workspaceIntro`). Модель
  больше не получает «The general agent reads it… route reading/analysis to general».
- **Тул `document` → `write_document`** (model-facing; внутренний `SessionOperation.kind` остался
  `document`). Обновлены `task` (choose `write_document`), repair-сообщение, тесты.
- **Базовый промпт** теперь: роль, «Ask when unclear», язык, «Pass the user's request verbatim;
  if it refers to earlier messages, assemble it from them; add nothing else», «The operations read
  the workspace themselves; you do not need to gather facts first». Описания тулов сокращены
  (general/revision/task/document/plan), без «inspects/reads workspace» и без ТЗ.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **657 passed / 40 skipped**.
- Live (копии ankyra): 5/5 `write_document` на «напиши документ о решателе z3»; rewrite →
  `revision`; «составь план» → `plan`; `write_document` создал `docs/z3.md` (8 секций, 285 строк,
  H1, 0 DSML, без Logic-LM); 10+3+forced `start_document` убрал `no_outline`.

### Открыто

- Длина переформулировки всё ещё гуляет (модель иногда добавляет аспекты); `respond` на
  неоднозначный «как проверить решатель?» просит уточнение вместо `general`.
- Heavy/live sandbox не запускались.

## 2026-11-12 — acceptance плана убран

### Что сделано

- **Убран отдельный plan-acceptance.** План закрывается `done`, когда закрыт последний пункт:
  `completed` пункта = его единица завершилась; отдельного `general`-судьи и `VERDICT: PASS`
  больше нет. Удалены `PlanAcceptance`/`runPlanAcceptance`/`lastStopText` (`src/session/driver.ts`),
  рендер в `src/session/view.ts` и TUI-блок/поле лога в `src/tui/app.tsx`; тест в
  `tests/plan.test.ts` заменён на «план done по последнему пункту, без general-единицы».
  Причина: судья был второй моделью поверх самоотчёта, слабее информирован (не видел правок
  пункта), шёл с `generalMaxTurns=9` на весь план и в e2e дал false negative при 7/7 completed
  (`aborted`), заново привязывая сырой request как цель.
- **Проверка принадлежит пункту.** `task` уже верифицируется островом Verification; `done`-заметка
  пункта уходит агенту сессии в `renderPlanState` и входит в work order единицы. Кросс-пунктовая
  проверка (полный тест-сьют) — явный пункт плана, а не скрытый финальный проход.
- **Добиты хвосты удаления `kind`.** Из `SESSION_BASE_PROMPT` убрана фраза про `(coding)`-метку
  (`src/session/session_agent.ts`); описание тула `plan` — «executable work orders»
  (`src/llm/session_agent.ts`); из доков убрано «пункт `document` открывается напрямую»
  (`sessions.md` §11, `projection.md`, EN/RU); из тестовых фикстур (`tui_app`, `tui_view_model`,
  `budget_pause`) убрано поле `kind` у пунктов плана.
- **Паузное меню.** Для `document`/`revision` cancel без «& roll back» (`session/view.ts`,
  `tui/panels.tsx`): снимка/отката у них нет.
- Доки EN/RU `sessions.md` §8: явно сказано, что отдельного acceptance-прохода нет.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **655 passed / 40 skipped**
  (минус два acceptance-теста, плюс один «done по последнему пункту»).

### Открыто

- Временные скрипты (`.z3-e2e.ts`, `.route-probe.ts`, `.plan-probe.ts`, `.print-plan.ts`) оставлены
  в корне по решению владельца — могут понадобиться для перепрогона; в коммит не входят.
- Live-перепрогон z3-e2e не делался: по решению владельца не требуется.
- ankyra: изменения от e2e владелец проверит и закоммитит сам из TUI (см. ниже, 2026-11-11).
- **Осознанный остаток:** `done`-условие пункта движком не проверяется (у `task` остров
  Verification читает request; у `general`/`revision`/`document` слота критерия нет). Обсуждение
  отложено.

## 2026-11-11 — `revision`, план без `kind`, планировщик read-only

### Что сделано

- **Новая единица `revision`** (session-level, request-anchored, как `general`/`document`):
  выполняет изменение, уже описанное в запросе — правит существующие файлы и запускает нужные
  команды (добавить зависимость, обновить lock, поставить пакет). Одно состояние на `request`,
  без `move`/островов, закрытие — текстовым ответом. Изменяющая: нет read-only снимка и отката.
- **Реализация `revision`.** `src/llm/revision.ts` (`REVISION_BASE_PROMPT`, положительный;
  proposer с полным набором инструментов вкл. side-effecting `bash` и `webfetch`);
  `src/session/revision.ts` — обёртка над `runGeneralAgent`, который параметризован
  (`unitType`/`agent`/`basePrompt`/`stateLabel`/`finalInstruction`), так что раннер один.
- **Маршрутизация агента сессии.** Новая операция `revision`: «изменение задано — `revision`;
  причину/способ искать или новый код — `task`; крупный prose — `document`; только чтение —
  `general`». Wiring: `types`/`operations`/`session.unitCompleted`, `progress`/`telemetry`,
  `driver` (`nextRevisionId`=`v1`, `dispatch`, `resume`, `cancel` без откатов, `executePlan`),
  `cli` deps; рендер/TUI (`session_outline`, `view`, `view_model`, `app`, `trace_lines`, `repl`).
- **`kind` убран из пунктов плана.** Планировщик больше не помечает операцию: `PlanItemKind`
  удалён, пункт — work order (`title`/`detail`/`done`). `executePlan` на каждый пункт зовёт
  агента сессии (видит план и результаты прошлых пунктов и сам выбирает операцию); `document`
  не открывается напрямую по `kind`. Причина: метка `(coding)` перевешивала маршрут (docs/config
  уходил в `task`/Patch; live e2e: 53 хода, budget). Риппл: `ir/types`, `session/planner`,
  `llm/planner` (схема `submit_plan`), `session/plan`/`view`/`driver`, `tui/view_model`, тесты и
  доки EN/RU.
- **Планировщик строго read-only.** `PLANNER_TOOL_NAMES` без `shell` (`src/llm/planner.ts`);
  `modelPlannerAgent` фильтрует вызовы вне поверхности (один repair, затем drop); в `runPlanner`
  — барьер `PLANNER_READONLY = {read,grep,list,recall,search}`. Причина: провайдер отдавал
  `bash`/`edit` вне поверхности, планировщик их исполнял (`bash sed -n` кусками вместо `read` с
  8K; 17 `bash` в одном прогоне) и мог мутировать дерево. Теперь только read/grep/list; доки
  `sessions.md` §8 EN/RU обновлены, тест `plan.test` проверяет, что off-surface вызов не
  исполняется.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **656 passed / 40 skipped**
  (включая `revision_unit`).
- **Пробник планировщика** (z3-запрос): только `read/grep/list` (нет `bash`/`shell`/`edit`),
  план сдан за 18 ходов.
- **Live e2e в `~/dev/ankyra`** («напиши план для добавления решателя z3»): план из 7 пунктов;
  исполнение — item 1 → `revision v1`, 2 → task r1, 3 → `revision v2`, 4 → `revision v3`,
  5 → `revision v4`, 6 → task r2, 7 → task r3. Docs/config/verify-доки ушли в `revision`,
  код/тесты — в `task`; **все 7 пунктов completed**. План `aborted (7/7)` только из-за acceptance.

### Открыто

- **ankyra: рабочее дерево содержит реальные изменения от e2e** — новые
  `src/ankyra/engine/backends.py`, `src/ankyra/engine/smt/prove.py`, `tests/test_engine_smt.py`,
  `tests/test_engine_backends.py`; изменены `verify.py`, `settings.py`, `pyproject.toml`,
  `uv.lock`, `.env.example`, `AGENTS.md`, `README.md`, `ARCHITECTURE.md`,
  `docs/l2_plan(.ru).md`, `docs/logic_layer(.ru).md`, `docs/quality_findings(.ru).md`. Item 7
  сам сообщил 671 passed (без z3) / 681 (с `--extra smt`), но прогон не проверялся вручную —
  владелец решит keep/revert и закоммитит из TUI.
- Чекпойнт/откат для `revision` намеренно не делался.

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
