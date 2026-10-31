# Skein — общий план реализации

> Русское зеркало `docs/plans/implementation_plan.md`.

Концепция — `docs/concepts_ru.md`. Концептуальный каркас — докса/логос в
`ankyra/docs/doxa_and_logos.tex` и `ankyra/docs/concepts_ru.md`. Детальный спек
текущего этапа — `docs/plans/archive/tier0_plan_ru.md`. Этот документ — общий план, решения,
роадмап и статус.

## 1. Суть

Skein — агент кодирования, у которого контекст есть **проекция IR**, а не лента
сообщений. LLM — докса: только предлагает (цель входит в `open`). Детерминированный
движок (логос) решает. Запрос задаёт пользователь или харнес, и они же принимают
финальный результат снаружи; отдельной роли арбитра в цикле нет. Журнал событий и
функция проекции — протокол.

## 2. Зафиксированные решения

| Решение | Выбор |
|---|---|
| Язык | TypeScript (Node 22, ESM), пакетный менеджер npm |
| Модель состояния | гибридный граф `work` + `artifact`, append-only журнал + детерминированная проекция |
| Немонотонность кода | staleness по версии (хэш файла), без ручного отката |
| Первый срез | багфикс по падающему тесту; критерий — тестовая команда |
| Оркестрация | LangGraph.js (`@langchain/langgraph`) |
| LLM | как в Ankyra: OpenAI-совместимый endpoint; model layer — Vercel AI SDK (`@ai-sdk/openai-compatible`); размышления включены (дефолт `low`; тяжёлые задачи — `high` на прогон); секреты — только в `.env` |
| Критерий | `done_when` цели — буквальная команда; её `exitCode` (0 = pass) — единственный факт pass/fail |
| Закрытие | рамка закрывается только `stop` доксы (пока принимается, лишь когда критерий прошёл); запрос заканчивается, когда его цель остановлена |
| Главный критерий архитектуры | **управляемость**: состояние и его границы наблюдаемы, к структуре применимы детерминированные алгоритмы; цена в ходах — принятая плата, не повод менять проекцию |

## 3. Роадмап

**Tier 0 — багфикс по падающему тесту (выполнен).**
Замкнутый цикл `goal → locate → claim → action → check → done`; IR + проекция;
staleness; объективный арбитр. Детали — `docs/plans/archive/tier0_plan_ru.md`.

**Tier 1 — работа над задачей (выполнен).**
- `Decision` как first-class: выбор, отвергнутые альтернативы, обоснование.
- `Check`/арбитр как явный узел с объективным вердиктом.
- Подцели и их декомпозиция.
- Path-based релевантность: достижимость от цели через рёбра решений/действий
  (C2).
  Детали и порядок работ — `docs/plans/archive/tier1_plan_ru.md`.

**Tier 2 — немонотонность знания (переосмыслена семантикой IR; в основном сделана).**
- Немонотонность **производна**, а не хранится: предикаты `refuted`/`abandoned` и
  `alternatives`+`chosen` вычисляет `fold`, история ревизий шага видна в проекции
  (`docs/ir_ru.md` §4, §7). Это заменило старую рамку статусов/записи `Revision`.
- Работы старого роадмапа (режимы, `W`-гейт, `cited`, `frontier.revisions`) перекрыты
  миграцией семантики — `docs/plans/archive/logos_roadmap_plan_ru.md` оставлен как история.
- По-прежнему отложено: точность устаревания (R3b) — сузить свидетельство до
  замыкания зависимостей; сегодня это весь воркспейс (`SKIP_DIRS`).

**Tier 3 — доксические операторы.**
- `analogy`, `intuition` — запрос у LLM невыводимого, как явные операторы. Не начато.

**Ближайшие шаги.**
1. Ужесточить классификацию: constraint должен запрещать обход через `run`
   (shell), а не только через `edit`. **Сделано** — эффект-гард: `edit`
   проверяется в `classify`; `run`, меняющий запрещённый файл, откатывается и
   записывается нарушением (`docs/plans/archive/constraint_guard_plan_ru.md`).
2. Задачи на длинный горизонт, где проекция должна дать преимущество
   (многофайловые правки, 50+ шагов).
3. Сравнение Skein vs opencode vs монотонный агент на одних задачах. **Начато** — первый
   сопоставимый прогон (3 длинные задачи terminal-bench, k = 3, reasoning `high` у обоих)
   в `docs/benches/bench_report_ru.md` §4.4, и первый проход **локальной песочницы** (§4.8)
   гоняет все тринадцать задач без Harbor (`docs/testing_ru.md` §3.6).
4. **Сравнительное тестирование (следующее).** Перегнать песочницу на тех же задачах при
   reasoning `high` (в матч с Harbor), k = 3, и сравнить по каждой: ходы, вызовы LLM,
   вызовы инструментов с разрезом, токены (`in`/`out`/кэш/reasoning) и стоимость — против
   opencode. Предварительное условие — сопоставимый opencode-бэкенд песочницы (сейчас
   opencode гоняется только через Harbor). Преждевременный `stop` на
   `fix-ocaml-gc`/`custom-memory-heap-crash` исправлен рефактором закрытия `stop` (§4);
   перепроверить их числа точности после следующего прогона.

**Tier 4 — управляемость и сессии (стратегическое направление; порядок — сначала 4a, затем 4b).**

Ценность проекции — не в числе ходов, а в **наблюдаемости**: состояние и его границы
известны движку, поэтому к структуре применимы алгоритмы, недоступные монотонной ленте.
Оба направления опираются на один механизм — **agent-unit**: тот же IR, свой словарь
состояний, read-only-инструменты обзора и операции, которые проверяет и применяет логос.
Механизм строится один раз и получает два экземпляра: RequestObserver и SessionAgent.

- **4a — триггеры и RequestObserver (первое).** Движок детерминированно замечает событие
  в структуре (повтор `действие→наблюдение` над неизменённым материалом, третий вход в
  остров, >20 ходов в состоянии, повтор цепочки состояний через рёбра `move`,
  преждевременный `stop`, расход бюджета и т.п.) и
  выбрасывает **триггер**; RequestObserver с read-only-инструментами обзора решает, что
  делать, и предлагает действие; логос проверяет и применяет. Триггер — факт наблюдения,
  не вердикт. Перечень триггеров, инструменты агента и реакции — открытый вопрос; для
  него заводится отдельный документ `docs/controllability_ru.md` (EN: `docs/controllability.md`).
  4a вводит минимальный контейнер сессии (журнал и стек unit'ов) как носитель; операции
  сессии и статусы внимания остаются за 4b. Существующие пороги (`no_progress`, `max_turns`,
  thrash-guard) переписываются: терминальное завершение уступает триггеру.
  Это снимает отложенную cycle/premature-stop детекцию, не превращая её в жёсткий гейт.
- **4b — сессия и SessionAgent (второе).** Развитие `docs/session_concepts_ru.md` на
  контейнере из 4a: unit'ы, журнал сессии, стек (вершина — `focus`), `pending`, два
  независимых статуса (unit открыт/закрыт vs `active`/`suspended`/`abandoned`/`completed`),
  agent-unit с операциями сессии (первый срез даёт `respond`/`start`; остальные отложены),
  детерминированный иерархический обзор L0–L4. Отличие от монотонной ленты: запрос —
  first-class адресуемый unit, и SessionAgent перечисляет/находит прошлые запросы
  **структурно** (обзор, `recall` по id), без similarity/RAG. SessionAgent не правит деревья
  задач — только предлагает операции; логос проверяет предусловия. Инварианты: ничего не
  удаляем и не сжимаем в резюме-истину; без вердиктов и хранимых статусов. Минимальный
  срез — `docs/session_concepts_ru.md` §10. **Реализовано и проверено live** — статусы
  внимания, L0/L1, session-unit и `SessionAgent`, инструменты памяти/workspace (`read`/`grep`/
  `list`/`probe`/`unit`/`state`/`turns`/`body`/`search`), `respond`/`start`, post-task
  `report`, view-слой, `runSessionTurn`, REPL и CLI (`session_agent_plan`,
  `session_driver_plan`); сохранение, возобновление пройденного unit'а, `revise`, пины,
  `attempt` и reading island остаются. Прерывание — приостановка/возобновление/отмена,
  снапшот-откат задачи и контракт телеметрии — реализовано (`session_interrupt_plan`).

**Почему такой порядок.** 4a бьёт прямо в главный критерий — управляемость: движок уже
знает структуру и может детерминированно заметить событие, а agent-unit с read-only-обзором
решает, что с ним делать; это же снимает отложенную cycle/premature-stop детекцию. 4b
переиспользует тот же механизм и добавляет контейнер сессии и операции над unit'ами.
Семантика триггеров обсуждается отдельно, в своём документе.

## 4. Текущий статус

> **Приведение к семантике IR.** Код приведён к `docs/ir_semantics_ru.md`:
> старая модель (`claim`/`decision`/`subgoal`, статусы-поля, `mode`) заменена
> операторной моделью (`create_goal`/`apply`/`stop` + read-only `recall`/`search`) и производным
> состоянием. План и статус —
> `docs/plans/archive/ir_semantics_migration_plan_ru.md`; текущий as-built — `docs/ir_ru.md`.
> Описанная ниже линия Tier 0/Tier 1 — история.

Реализован Tier 0 (шаги 1–5 `docs/plans/archive/tier0_plan_ru.md` §11): `src/ir`, `src/config`,
`src/llm`, `src/tools`, `src/loop`, три фикстуры, offline- и live-гейт. Полный
статус и осознанные упрощения — `docs/plans/archive/tier0_plan_ru.md` §13.

Поверх Tier 0 текущая линия добавляет:

- **Первый принцип** — каждое событие есть знание, полученное из опыта, и
  прослеживается до источника (`docs/concepts_ru.md`).
- **Достоверность проверок** — проверка несёт свидетельство; позднее изменение
  обесценивает его, и утверждение уходит в `frontier.invalidated`
  (`docs/plans/archive/check_soundness_plan_ru.md`).
- **Наблюдение изменений** — `run` пишет `mutate` на каждый изменённый файл;
  движок сверяет активные `ref` перед каждой проекцией, с кэшем отпечатков;
  `fs.watch` оставлен для будущего стримингового режима
  (`docs/plans/archive/observation_plan_ru.md`, `docs/plans/archive/watcher_plan_ru.md`).
- **Фиксация отказов** — отклонённое предложение пишется событием
  `record_rejection` и показывается в `frontier.refusals`, поэтому переживает
  вытеснение из хвоста и реплей (`docs/plans/archive/rejection_plan_ru.md`).
- **Бюджет контекста** — `index` есть ограниченная сводка (счётчики + окно
  новейших) по контракту адресуемости; бюджет ходов показан в `header.budget`
  (`docs/plans/archive/index_budget_plan_ru.md`).
- **Арбитр (приёмка пользователя)** — `userAcceptance` фиксирует пользовательскую проверку
  (`actor: "user"`), поэтому не-кодовая работа может достичь settled-состояния
  (`docs/plans/archive/user_approval_plan_ru.md`).
- **Охват устаревания** — транзитивность покрыта снимком всего воркспейса;
  свидетельство теперь живёт один раз, в наблюдении
  (`docs/plans/archive/staleness_scope_plan_ru.md`).
- **Рабочий граф (T1.1)** — `decompose`/`decide` производят подцели, решения и
  связующие рёбра (`decomposes`/`justifies`/`chosen_over`/`supports`) с
  `provenance.llm`; привязка к родителю обязательна (проверка допустимости `classify`); статусы
  `superseded`/`achieved` производны; проекция показывает подцели и связи
  (`docs/plans/archive/tier1_plan_ru.md`).
- **Path-based релевантность (T1.2)** — `frontier` есть достижимое замыкание от
  цели по рёбрам пути; недостижимое остаётся доставаемым через `recall`
  (`docs/plans/archive/tier1_plan_ru.md` §5).
- **Явный узел проверки (T1.3)** — `record_check` материализует узел `check`
  (команда, вердикт, свидетельство, `actor`) и ребро `verifies` `check → claim`;
  `query {verdictOf}` читает узел (`docs/plans/archive/tier1_plan_ru.md` §6).
- **Приёмка fix-ocaml-gc (2026-10-06)** — длинная задача terminal-bench решена
  (**reward 1.0**, `40 tests passed`) на Flash + reasoning `high`. Исправления движка
  (фокус под закрытым предком, диагностика падения, удержание в проекции, фоновый
  `run`, удаление `need`) — `docs/benches/engine_fixes_found_ru.md`; отчёт о прогоне —
  `docs/benches/fix_ocaml_gc_run_report_2026-10-06_ru.md`.
- **Справочник операций IR и покрытие** — каждая операция над деревом специфицирована
  стабильным ID в `docs/ir_operations_ru.md` (+EN); офлайн-тесты по операторам
  (`tests/ops/`), property-тесты на 400 случайных легальных деревьях, coverage-gate
  (`tests/coverage.test.ts`) и live step-тесты (`tests/live/ir_operations_step.test.ts`).
- **Нативные tool calls (structured output)** — агент предлагает через плоские
  function-инструменты, сгенерированные из zod (`src/llm/tools.ts`); `invokeTools`
  (`src/llm/structured.ts`) биндит их (без принудительного `tool_choice`, как opencode), маппит вызов в IR
  `Action` и ремонтирует один битый/отсутствующий вызов. JSON-схема-в-промпте
  (`invokeStructured`) остаётся общим фолбэком. Это заменило одну глубокую
  discriminated-union, которая раздувала reasoning и упиралась в completion cap на
  тяжёлых ходах (`docs/testing_ru.md` §8.1; `docs/benches/bench_report_ru.md` §4.4). Добавлен
  инструмент `write` (`docs/ir_operations_ru.md` §2.2.6).
- **Сравнение моделей (DeepSeek vs Qwen)** — `qwen3-30b-a3b-instruct-2507` проваливает
  синтетический набор (0/4) и дороже текущего DeepSeek; остаёмся на
  `~deepseek/deepseek-v4-flash-latest`.
- **Ревизия системного промпта (сделано)** — блоки поведения + документ
  `docs/system_prompt_ru.md`, устранён дрейф `apply`, политика VCS и внешний референс,
  инструменты `fetch`/`apply_patch`, guard путей вне воркспейса, контролируемый
  эксперимент (§4.5 `docs/benches/bench_report_ru.md`). Итог — `docs/plans/archive/system_prompt_revision_plan_ru.md`.
- **Широтный прогон (2026-10-08)** — десять остальных задач terminal-bench, онлайн, `low`, k=2
  (`bench/harbor/skein-unrun.template.yaml`): каждая попытка, дошедшая до агента, решила
  свою задачу (13/13); `fix-code-vulnerability`/`git-leak-recovery` потеряны на выкачивании
  Docker-образов. Блокер починен первым: `invokeTools` теперь поднимает completion cap при
  усечённом ответе (`finish_reason: "length"`), а не завершает прогон с `llm_error`
  (`docs/benches/bench_report_ru.md` §4.7).
- **Закрытие `stop` (2026-10-09, сделано)** — кадр (цель или запрос) закрывается **только**
  `stop` доксы; запуск-критерий — обычный `observation`, несущий `target`+`exitCode`;
  машинерия `check`/`verdict`/`under`/`arbiter` удалена. Врата `stop`: на цели —
  принимается, если её критерий прошёл или её план исчерпан (сдача); на запросе —
  если его выбранная интерпретация устоялась или остановлена. Это устраняет дефект
  преждевременного `stop` на `fix-ocaml-gc`. Спек и пример — `docs/ir_semantics_ru.md` §4.3,
  `docs/walkthrough_ru.md`; план — `docs/plans/archive/stop_closure_plan_ru.md`.
- **Рефактор request→goal (2026-10-09, сделано)** — `request` интерпретируется ровно
  однажды как `goal` через `has_goal` (интерпретация фиксирована) или отклоняется
  (`no_goal` → `unactionable`); ребро `chosen` удалено. `stop` действует только на цель:
  добавляет узел `stop` её **последним пунктом плана** и ребро `has_stopped`, и (пока)
  принимается, лишь когда критерий прошёл (только положительные остановки; сдача
  отложена). У запроса нет `stop`; он заканчивается, когда его цель остановлена;
  `decline` доступен только на свежем запросе. План — `docs/plans/archive/request_goal_plan_ru.md`.
- **Правки под тяжёлую задачу и первое чистое закрытие (2026-10-09).** Промпт: repair-routine
  собирает первой (B7), а B10 разделяет неверный рабочий каталог и несобранное дерево; триггер
  «подозреваемый → правка» (B7/B16) и «diff-референс — зацепка, а не чеклист» (B9) убирают
  петлю чтения. Движок: `invokeTools` ограничивает обрыв completion одним краткостным повтором
  (без удвоения cap); thrash-guard чтения отклоняет третье чтение неизменённого файла
  (`OP-AP-READ-6`). Build-heavy задача объявляет свой `maxTurns` (`fix-ocaml-gc`: 60,
  `tests/sandbox/task.ts`). Живой повтор — `reward=1`, `stop=request_addressed` (первое
  позитивное закрытие в песочнице; израсходованы все 60 ходов). A/B транскрипта проведён и
  отклонён. Детали — `docs/benches/bench_report_ru.md` §4.8; промпт — `docs/system_prompt_ru.md`.

- **Ревизия IR свёрнута (форма, операции, контекст; сделано).** Узел `item` заменил контейнер
  `alternatives`; рёбра переименованы (`goal`/`unactionable`/`plan`/`stop`/`items`/`alts`/
  `result`/`mutates`); `stop` — связь на цели (не пункт плана); `create_goal` сразу исполняет
  первую команду; `apply` размещает команду по исходу текущего пункта, а неисполнение команды —
  наблюдение с причиной (не отказ без узла); контекст — **лента сообщений**, собираемая из
  дерева. Спек — `docs/ir_semantics_ru.md`; ход работ —
  `docs/plans/archive/ir_revision_implementation_plan_ru.md`. Прежние формулировки формы в этом
  разделе — история.

- **Model layer на Vercel AI SDK + стриминг (2026-10-17, сделано).** `src/llm/client.ts` —
  `createOpenAICompatible`; `buildMessages` → AI SDK `ModelMessage[]`; `invokeTools`/
  `invokeStructured` → `generateText`/`streamText`; инструменты — AI SDK `tool()` из тех же
  zod-схем; reasoning и usage берутся из результата SDK. Старый LangChain-адаптер
  (`src/llm/provider.ts`), SSE-парсер и `onResponseBody` удалены; `@langchain/openai` убран из
  зависимостей. `SKEIN_STREAMING` (дефолт on) выбирает `streamText` против `generateText`;
  `SKEIN_REASONING_TAPE` по-прежнему управляет показом reasoning на ленте. Тесты/бенчи
  обновлены; план и статус — `docs/plans/ai_sdk_migration_plan_ru.md`.
- **Literal Verification why + failed-attempt block (2026-10-17, сделано).** `stop.why` у
  Verification — буквальный пересказ ошибки: команда, exit status, фактический текст; без
  диагноза кода и без «почему фикс не сработал». `Previous failed attempt` в открытых
  Localization и Patch собирается из модельного `why` упавшей Verification и фактического diff
  последнего Patch; механический `lastFailingRun`/`git`/exit в блок не попадает. Блок говорит
  `has been reverted` и `Do not repeat this change`; masked exit-0 с `stop.why` тоже виден.
  Тесты — `tests/revert.test.ts`, `tests/tape_render.test.ts`.
- **Verification → Patch + revert (2026-10-17, сделано).** `ISLANDS.verification.next` включает
  Patch: если координаты Localization ещё верны, а не сработала только правка, модель может идти
  прямо в Patch. `isFailedVerificationMove` откатывает failed Patch на оба перехода
  (`Patch`/`Localization`), поэтому Patch стартует с pre-patch дерева и с блоком. Live-проверка:
  в финальном батче run5 выбрал `verification → patch`, сделал один revert и починил tail;
  в отдельных stage-сэмплах модель чаще выбирала Localization. Тесты — `tests/revert.test.ts`.
- **Per-state hints (2026-10-17, сделано).** `Island.hint` для каждого состояния + общий
  closure-хвост: Orientation — `pwd`/build/check; Localization — sibling walkers; Patch —
  «только названное изменение / не повторять failed attempt»; Verification —
  pass/fail/environment; End — `stop`, когда запрос завершён. `turnInstruction` больше не смешивает состояния;
  тесты — `tests/prompt.test.ts`, `docs/system_prompt_ru.md`.
- **Финальный live-батч (2026-10-17, сделано).** `fix-ocaml-gc --net on`, 5 параллельных:
  **5/5 `reward=1`**, 29–50 ходов, **7.315₽** суммарно (1.031–2.521₽ на прогон); 999 544 in
  (79.7% cache), 47 325 out (28 462 reasoning). Токены и разбор — `docs/benches/best_bench_ru.md`.
- **Orientation result vs probe (2026-10-20, сделано).** Один `fact:session`
  (`environment` + `material`) пишется на старте запроса. `material` — карта workspace: `root`,
  repo-статус, top-level entries/paths, число файлов; конфиги, команды сборки, расширения и
  build state убраны. Orientation показывает `Workspace`; Localization/Research получают ту же
  карту как `Orientation result` (Research — плюс `Probe` с interpreters/tools); остальные —
  `Probe` (environment) отдельным заголовком. Цель Orientation сужена до входов и acceptance из
  запроса; если карта и запрос уже всё называют, первый шаг может быть `stop`.
- **Orientation на 13 задачах (2026-10-20, minimal).** Реальные образы задач: **13/13 закрыли
  Orientation за 3 хода** (request → `stop` → transition; один `password` — 4), без
  исследования материала и ошибок. `fix-ocaml-gc`: 3 хода, ~6.4k in, 0.065₽ против 6 ходов /
  25.9k / 0.166₽ раньше. K=3 маршрутов: password/cobol → Research, custom-memory/fix-git →
  Localization, git-leak → Research (3/3). Тесты — `364 passed`, typecheck чистый.
- **Localization/Patch alignment (2026-10-20).** Localization — критерий 29-ходового прогона:
  target + coordinates/extent + siblings ruled out, **без** failing code/cause. Patch — как в
  29-ходовом (`439095b`, declared form); Verification уже был в этой версии. Добавлены
  probe-правила: `repo: none` → без git, не читать build-доки/конфиги, старт от названной
  подсистемы; «tape already holds what you observed».
- **Полный fix-ocaml (2026-10-20, live).** С failing code: 60 ходов/7.61₽, неверная строка,
  Patch-1 21 + Patch-2 16. После alignment: reward=1, `stop=request_addressed`, **34 хода,
  4.24₽**: Orientation 3/0.29, Localization 7/0.83, **Research 5/1.00 (лишний шаг)**, Patch
  10/1.22, Verification 8/0.79, End 1/0.10. Остаток разрыва с 29/1.684₽ — лишний Research:
  для code defect нужен переход L→P; Research — для ситуаций/новых артефактов. Тесты —
  `364 passed`, typecheck чистый.
- **Localization → Patch (2026-10-20).** *(Устарело 2026-10-29 — см. запись о коррекционных
  L↔R ниже.)* Позднее ребро `L → R` убрано (`83243ae`): у
  Localization снова единственный переход — Patch. Dry-rebuild перехода из 34-ходового прогона
  Research не показывает; live K=3 — 3/3 `move patch`. Полный `fix-ocaml-gc` K=1: reward=1,
  `request_addressed`, 34 хода, 5.23₽ — Research нет; остаток — Patch 15 ходов (пере-вывод
  причины, ~10k reasoning) и 2 хода на `.skein/checkpoints`; cache hit 81%.
- **Коррекционные L↔R (2026-10-29).** `Localization → Research` возвращено как коррекция
  неверной стартовой классификации (не обычный выход), симметрично — `Research → Localization`;
  промты внутри состояний не тронуты (только `next` и правило перехода). Синтетика —
  `tests/routing.test.ts`; живой прогон 3 задач × K=3 (`fix-code`, `db-wal`, `log-summary`,
  `--turns 34/32/21`): 9/9 `reward=1`, рёбра не выбраны ни разу, нормальные пути не сдвинулись.
  Трасса: `bench/runs/prompt-tests/2026-10-29T08-12-37-edges-k3-full/`.
- **Терминальный UI (2026-10-31, сделано).** `npm run cli` открывает Ink-TUI: живой прогресс
  из loop/session/observer, постоянная панель состояний текущей задачи (диапазоны ходов,
  токены, действия, полный `stop.why`), read-only overlay истории задач и header с общим
  расходом токенов. Markdown рендерится стилизованными спанами (`marked` + `lowlight`),
  темы светлая/тёмная (`COLORFGBG`, `SKEIN_THEME`). Старый REPL остаётся за `--plain`.
  Детали — `docs/plans/tui_plan_ru.md`; тесты — `tests/tui_*`; офлайн **526 passed,
  40 skipped**.

Проверка: `npm run typecheck`; `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` —
offline-тесты; live-гейт только при `SKEIN_LIVE=true` и с явного разрешения владельца.

**Отложено (бэклог):**

- **Показ/прерывание генерации (стриминг-UX).** Стриминг сделан как транспорт (см. выше), но
  токены наружу не отдаются: чтобы показывать и прерывать вывод, нужно потреблять
  `textStream`/`fullStream` AI SDK на уровне цикла, а не только собирать результат. TUI
  показывает activity и tool-события, но не потоковый текст. Отложено.

- **Возможные инструменты.** `write` сделан. Кандидаты по величине пробела: `edit` по
  диапазону / `multiedit` (find/replace ломается на неоднозначных/повторяющихся
  фрагментах); `web_fetch` (документация, разбор ошибок — доступен через `run`/`curl`,
  потому низкий приоритет); LSP `symbol` (definition/references/rename). Non-goals:
  VCS, инструмент `todo` (план живёт в IR), браузер/скриншоты, субагенты, MCP
  (`docs/tools_ru.md` §8).
- **Прогнать `write` вживую.** Ни один live-сценарий не создаёт файл: две «похожие на
  создание» фикстуры (`command-from-package`, `make-command`) уже содержат
  `package.json`/`Makefile`, поэтому модель читает команду, а не пишет файл. Надо
  добавить фикстуру, чей README требует создать файл (например, отсутствующий
  `package.json`), и прогнать её
  (`SKEIN_SCENARIOS=<name> SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts`).
  Сейчас `write` покрыт офлайн (`tests/ops/apply.test.ts`, `OP-AP-WRITE-1..5`).
- **Стабильный префикс проекции (кэш промпта).** Бенч на `skein-plugin`
  (`bench/`) показал: провайдер кэширует только system-префикс (ровно 1664 токена
  за вызов), а проекция не кэшируется — её стабильный префикс обрывается на
  `goal`/`constraints`, сразу за которыми идёт волатильный `frontier`. Оптимизация
  (волатильное — в хвост, закрытые факты и индекс файлов — append-only в начало,
  ограничить рост) отложена как преждевременная; требует отдельного исследования.
- **Сокращение LLM-турнов.** A/B формата контекста (JSON-проекция vs транскрипт с
  ролевыми ходами) проведён, и транскрипт **предварительно отвергнут**: на `fix-ocaml-gc`
  он примерно удвоил reasoning/стоимость (ходы по 60.9k токенов, закончился `llm_error`),
  хотя поднял cache hit на коротких фикстурах (90% против ~55%) — и даже на `fix-ocaml-gc`
  его кеш был выше (63% против 42–58%). Потеря — **шторм обрыва** completion, а не кеш;
  шторм теперь ограничен (`invokeTools` делает один повтор на потолке, без удвоения cap),
  поэтому формат стоит перепроверить (детали — `docs/benches/bench_report_ru.md` §4.8).
  Пока промпт толкает к правке по названному подозреваемому, а thrash-guard отклоняет третье
  чтение неизменённого файла. Остаётся открытым: замыкание логоса (проходящий objective-чек
  верифицирует предков с тем же критерием) — `docs/plans/archive/step_reduction_plan_ru.md`.
- **Долгая сборка vs бюджет ходов (следующее исследование).** Build-heavy критерий
  (`fix-ocaml-gc` пересобирает весь компилятор OCaml) стоит ходов, даже когда правка верна:
  после правки агент запускает фоновый `run {background: true}`, и каждый `poll` — отдельный
  ход доксы (живой прогон опросил 8×, пока сборка ещё шла, затем запустил критерий рано →
  `exitCode 2`). Объявленный `maxTurns: 60` у задачи (`tests/sandbox/task.ts`) дал позитивное
  закрытие (`reward=1`, `stop=request_addressed`) — но прогон израсходовал все 60 ходов
  (правка t25, зелёный критерий t58), то есть это потолок, а не запас. Исследовать:
  (а) `timeout` у команды / проброс `runTimeoutMs` для долгой **foreground**-сборки
  (настройка есть, но в воркспейс не передаётся — `docs/tools_ru.md` §4.7 неточен), и/или
  (б) удешевить опрос (не тратить ход доксы на ещё идущий job); измерять ходы и стоимость.
  Опора — `docs/benches/bench_report_ru.md` §4.8, `docs/testing_ru.md` §3.6.
- **~~Завершать arbiter-цели / останавливать цикл отказанного `stop`.~~ Решено (2026-10-09)**
  рефактором закрытия `stop`: `arbiter`-целей нет; каждая цель несёт командный
  критерий, а запрос завершается своим `stop` под вратами факта критерия (или
  остановленной интерпретации), поэтому автономный прогон больше не повторяет `stop`
  до `maxTurns`. Из того пункта остаётся открытым: сократить переотправки ремонта
  `invokeTools` и разрешить батчинг — другие драйверы числа вызовов
  (`bench_report_ru.md` §4.4.2).

## 5. Границы

Сознательно не входит в текущие этапы: AST/символьная таблица, эмбеддинги,
CSP/арифметика, UI, мультиязычность, несколько LLM-провайдеров. Мета-unit (Tier 4) — тот
же IR, а не субагент; similarity/RAG остаётся вне рамок.

## 6. Открытые вопросы

- **Tier 4 (сессии и управляемость).** Порядок — 4a → 4b. Открытые вопросы сессии —
  `docs/session_concepts_ru.md` §8; триггеры, инструменты агента ленты/IR и реакции —
  `docs/controllability_ru.md`.
- Валидация предложений: жёсткий zod-контракт vs мягкий fallback JSON (как в
  `llm/structured.py` Ankyra).
- Остановка: вправе ли движок сам запускать `done_when.command` после завершения
  плана, без хода доксы (A5 в `docs/plans/archive/step_reduction_plan_ru.md` §5).
- Кэш: кэшируется только стабильный префикс (request + constraints); фокус
  проекции меняется каждый ход (`docs/plans/archive/step_reduction_plan_ru.md` §4).
- **Путь вне workspace в `write`/`read`/`edit` (2026-10-19).** Сейчас `/tmp/...`
  переинтерпретируется как `/app/tmp/...` (workspace-relative), и модель теряет ходы на
  отладке пути: 3 из 4 Recovery-прогонов на db-wal. Принципиальный фикс — **отвергать** путь
  вне workspace, а не нормализовать его; в контракте инструмента сказать, что путь
  workspace-relative.
- **Handoff Research → Recovery должен нести метод (2026-10-19).** В db-wal `why` говорил
  «determine the byte-level transform», а не «XOR 0x42, checksums little-endian»; Recovery
  заново выводил метод и вязнул в endianness (t18–t21, 4–12k симв.). Общее правило: `stop.why`
  несёт то, что нужно следующему состоянию — метод/координаты/проверку, а не только ситуацию.
- **Локализация теряет межсостоянийную передачу (регресс, 2026-10-15).** Реальный sandbox
  `fix-ocaml-gc --net on` (Phase-20-лента) провалился — reward 0, `max_turns` 60: orientation
  закрылась на «layout known», а локализация стартовала с причинной целью («find why the
  bootstrap crashes») без указателя на `runtime/shared_heap.c` и ушла в `major_gc.c` / отладку
  bootstrap. Успешный прогон 2026-10-14 (Phase 18, 29 ходов, reward 1) держался на **широкой цели
  orientation** («…locate the sweeping/free-space changes in the major GC…») и **`note`** — сводке
  оставляемого состояния («…changes in `runtime/shared_heap.c`/`.h`»). Phase 20 сузил orientation
  до «layout» и убрал `note` из контракта `move`/B9 — передача потеряна. Фикс не выбран;
  варианты: (A) вернуть `note`-цепочку, (B) расширить orientation до «где лежит изменение»,
  (C) сделать первый шаг локализации «найти затронутые файлы». Доказательства:
  `docs/benches/best_bench_ru.md` (Фаза 20, Docker net on / виртуальная спека).
  **Обновление 2026-10-17:** финальный батч `fix-ocaml-gc --net on` — 5/5
  (`docs/benches/best_bench_ru.md`); per-state hints, literal `why` и `Previous failed attempt`
  в Patch сделали передачу рабочей в этой серии. Вопрос оставлен как история и для проверки на K>5.
