# Skein — прогон тестов и бенчей

> Английское зеркало — `docs/testing.md`.

Единая точка, чтобы не искать команды и места вывода по репозиторию. Относится к
`package.json` (скрипты), `bench/` (синтетический бенч и гейт),
`bench/harbor/` (реальные задачи) и `langgraph/graph.ts` (инструментовка).

## 1. Слои проверки

| Слой | Команда | Что проверяет | Стоимость |
| --- | --- | --- | --- |
| Типы | `npm run typecheck` | `tsc --noEmit` | секунды |
| Офлайн-тесты | `SKEIN_LIVE=false npx vitest run` | инварианты IR, проекция, цикл, проверка допустимости | секунды |
| Песочница (офлайн) | `SKEIN_LIVE=false npx vitest run tests/sandbox` | движок на виртуальном воркспейсе; извлечение метрик | секунды, бесплатно |
| Live-гейт | `SKEIN_LIVE=true npx vitest run tests/gate.test.ts` | починка багфиксов живой моделью | минуты, деньги |
| Live-сценарии | `SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts` | короткие сценарии на ветки движка | минуты, деньги |
| Песочница (live) | `SKEIN_LIVE=true npx tsx tests/sandbox/live-trace.ts` | один прогон моделью по песочнице, с разрезом токенов | 1 прогон, деньги |
| Синтетический бенч | `npm run bench -- <case>` | один кейс из `skein-plugin` | минуты, деньги |
| Гейт бенча | `npm run bench:gate -- <runDir>` | прогон против `bench/baseline.json` | секунды |
| Harbor | `bash bench/harbor/run.sh` | реальные задачи terminal-bench | долго, деньги |

**По умолчанию — офлайн.** Live-гейт и бенчи запускаются осознанно.

## 2. Офлайн-тесты

`.env` (gitignored) содержит `SKEIN_LIVE=true`, а `loadSettings` читает его через
`dotenv/config`. Поэтому `npm test` без override включит дорогой live-гейт. Для
обычной проверки:

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run
```

`SKEIN_LIVE=false` задаётся в окружении процесса, и `dotenv` не перезаписывает
уже выставленную переменную. Live-тесты помечены `describe.skipIf(!settings.live)`
(`tests/gate.test.ts`), инварианты — в `tests/invariants.ts`.

### Операции над IR

Операторы дерева специфицированы в `docs/ir_operations.md` (реестр ID: `OP-CG`,
`OP-AP`, `OP-QR`, `OP-ST`, `OP-CP`, `TR`, `DER`, `REF`, `PRJ`). Их офлайн-тесты
сгруппированы по оператору в `tests/ops/` (`create_goal`, `apply`, `query`, `stop`,
`applicable`, `traversal`, `derivation`); инварианты проверяются на 400 случайных легальных деревьях
(`tests/ops/ir_properties.test.ts`); `tests/coverage.test.ts` падает, если у ID реестра
нет теста или тест ссылается на ID вне реестра.

## 3. Live-гейт

```sh
SKEIN_LIVE=true npx vitest run tests/gate.test.ts
```

Прогоняет живую модель по фикстурам `fixtures/bugfix/*`: агент должен починить
падающий тест, не редактируя тесты. Таймаут — 300 c на фикстуру. Нужен ключ
(см. §9).

### Live-сценарии

Короткие сценарии на отдельные ветки цикла (`query`, ревизия гипотезы,
ограничения, ответ без правки, план, восстановление после отказа, поиск при
многих файлах). Отдельная группа — **матрица «команды × действия»**: `fail-recover`,
`script-two-bugs`, `make-command`, `verbatim-flag`, `command-from-package` — задачи,
где критерий включает реальную команду (в README / `package.json` / `Makefile` /
дословно), а решающий должен выполнить последовательность действий
(`read`→`edit`→`run`, создание конфига через `run … >`, две независимые правки).
Ещё две — **стратегические**: `reference-diff` (эталонная копия в воркспейсе →
ожидается `diff`, блок B9) и `no-vcs` (нет `.git` → без повторов git, блок B8).
Фикстура — `fixtures/scenarios/<name>/{repo, request.txt, check.sh?,
constraints.json?}`; `check.sh` опционален (по умолчанию `node --test`).

```sh
SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
SKEIN_SCENARIOS=two-outputs,revise-hypothesis SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
SKEIN_SCENARIO_REPEATS=3 SKEIN_SCENARIOS=script-two-bugs SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
```

Сценарии независимы (у каждого свой temp-воркспейс и след) и идут **параллельно**:
`it.concurrent` + `test.maxConcurrency: 5` (`vitest.config.ts`), что совпадает с
`n_concurrent_trials: 5` в Harbor. Каждый тест чистит свой temp-корень, поэтому общего
`afterEach`-cleanup нет (он гонялся бы за ещё бегущие сценарии). Весь набор — ~3 минуты.

Харнесс сценариев играет **программного арбитра** (зеркалит `bench/run.ts`): пока в
фокусе открытая arbiter-интерпретация, он запускает приёмочный `check` фикстуры и на
успехе пишет пользовательскую приёмку (`record_check` с `actor: "user"`) — единственный
способ закрыть arbiter-цель. Без него запрос, не называющий литеральной команды, не
может стать `addressed`.

Жёсткие проверки (падение теста): решён ли `check`, закрыт ли запрос
(`stopReason=request_addressed`, если у сценария `expect.addressed`), целостность
инвариантов (`tests/invariants.ts`), неизменность `test/` (и явных путей), число
**различимых** повторно запрошенных результатов (`maxRepeats`; одна и та же цель,
сколько бы раз ни отказали, — один), отсутствие правок там, где запрещено, форма
`run`-команд (`expect.commands`: regexp + `min`/`max` — например, `diff` обязателен
для `reference-diff`, git ограничен для `no-vcs`).
**Устойчивость:** `SKEIN_SCENARIO_REPEATS=N` (по умолчанию 1) гоняет каждый сценарий
N раз и собирает все провалы, так что флаки промпта виден как pass-rate, а не как
одна выборка; таймаут теста масштабируется на N. Мягкий отчёт по покрытию
веток печатается в stdout (`branches=[…]`, `MISSING(soft)=[…]`) и намеренно
не роняет тест: это инструмент подбора проекции, ветки промоутятся в жёсткие по мере
стабилизации. Полная проекция каждого хода и журнал складываются в
`bench/runs/live-<ts>-<name>/{contexts,events}.ndjson` для офлайн-разбора; туда же
пишется телеметрия рабочего множества: `workset.ndjson` (на ход — `shownCount`,
`shownChars`, `requested`) и `workset.json` (`peakCount`, `peakChars`, `reacquired`),
а `run.json` фиксирует вердикт (`done`, `stopReason`, `turns` и внешний `check`:
код/stdout/stderr). Мягкий отчёт печатает ещё и `refuted=` — провалившиеся проверки
целей, — чтобы был виден прогон, восстановившийся после неверного фикса
(`tempting-wrong`, `two-step-fix`), а не только итоговый reward.

### Live-шаги по операциям

`SKEIN_LIVE=true npx vitest run tests/live/ir_operations_step.test.ts` строит проекцию
каждой семьи операций **офлайн** (ровно то, что показал бы движок) и проверяет **форму**
следующего хода живой модели: интерпретировать запрос, чекнуть готовую объективную цель,
принять арбитрную извне, опросить фоновый job, повторить inconclusive-проверку, применить
следующий пункт плана, последовать подсказке фокуса. `SKEIN_STEP_REPEATS=N` (по умолчанию
3) повторяет шаг, поэтому стохастический промах — не провал. Спецификация и карта
покрытия — `docs/ir_operations_ru.md`.

### Реплей трассы (без Harbor)

`npm run replay -- <trace-or-scenario> [--limit N] [--offset N] [--model M]` берёт
записанную трассу (короткий сценарий — `bench/runs/live-<ts>-<name>/contexts.ndjson`,
допускается имя сценария; Harbor — `agent/langgraph-run.log` со строками `SKEIN_CONTEXT`
/ `SKEIN_PROPOSAL`), восстанавливает `buildMessages(context)` на каждый ход и гоняет
текущий `invokeTools` на **том же контексте**. Печатает по ходу: `operator`/tool
предложенный и записанный (`=`/`≠`), длину `thought`, выходные токены, `finish_reason`;
в конце — сводку `ok/fail/match/mismatch/outTokens/maxOut/finish=[…]`. Это позволяет
отлаживать промпт/схему на реальном распределении контекстов за копейки: например,
`th=8661 out=31531 finish=length` до правки `thought` против `th≈120 out≈200 finish=stop`
после.

### Симуляция политики рабочего множества (офлайн)

Длинный горизонт проверяется без модели: `tests/workingset.test.ts` гоняет
скриптованный proposer через реальный цикл и проверяет рост, вытеснение по cap,
повторное приобретение, сброс устаревшего и сжатие. Лимиты (`turns`/`max`/`chars`)
передаются через `AgentDeps.held` и варьируются в тестах; метрики — из
`tests/workset.ts` (те же, что в live-дампе). Это позволяет проверять политику на
сотнях ходов детерминированно и бесплатно, до дорогих live-прогонов.

## 3.5 Песочница (без Docker)

Миниатюра задачи terminal-bench `fix-ocaml-gc` с **настоящим циклом** и виртуальным
воркспейсом (`tests/sandbox/`): маленькое дерево
(`tests/sandbox/specs/fix-ocaml-gc.ts`), а команды `make`/testsuite эмулируются по карте
файлов — правка дефекта переключает чек с fail на pass, без Docker и сети. Тот же
`runSandbox` управляет **детерминированным** (скриптовым) или **живым** (модельным)
пропозером, так что движок проверяется бесплатно до любого прогона моделью.

```sh
# только движок, без модели — classify/refusal/терминация; <1s
SKEIN_LIVE=false npx vitest run tests/sandbox/fix-ocaml.test.ts
# извлечение метрик: учёт токенов/вызовов, офлайн и бесплатно
SKEIN_LIVE=false npx vitest run tests/sandbox/metrics.test.ts
# один живой прогон: реальная модель, виртуальный воркспейс, ≤16 ходов (деньги)
SKEIN_LIVE=true npx tsx tests/sandbox/live-trace.ts
```

`live-trace.ts` пишет `bench/runs/sandbox-live-<ts>-fix-ocaml-gc/`:

| Файл | Содержимое |
| --- | --- |
| `contexts.ndjson` | полная проекция по ходам (`turn`, `chars`, `context`) |
| `result.json` | `stopReason`, `turns`, IR-журнал (`events`) |
| `metrics.json` | `stopReason`, `turns`, `fixed`, `totals`, `byTool`, `byOperator`, `perTurn` |

**Записываемые параметры.** По ходу (`perTurn`): `operator`/`tool`, `refused`, `chars`,
`llmCalls`, `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheRead`, `cacheWrite`,
`cost`. Итоги: `turns`/`toolCalls`/`accepted`/`refused`, `inputTokens` (`freshInput` +
`cacheRead`) и `outputTokens` (`visibleOutput` + `reasoningTokens`), `cacheHitRatio`,
`costRub`, `contextChars` `first/last/peak`; далее тот же разрез по `byTool` и
`byOperator`.

- `llmCalls` — реальные вызовы модели (bump по completion-cap или repair-раунд добавляет
  один).
- `toolCalls` — один на ход (`tool_choice: "required"`); **отклонённое** предложение —
  тоже вызов (разделяется на `accepted`/`refused`). Ретраи добавляют `llmCalls`, не
  `toolCalls`.
- `in` = свежий ввод + чтение кэша (как в `bench/agents_compare.ts`, §6); `out` = видимый
  вывод + reasoning.
- Учёт — `TurnMeter`/`extractUsage` (`bench/metrics.ts`), общий с Harbor-адаптером;
  `tests/sandbox/metrics.ts` — чистая агрегация, проверяется офлайн в `metrics.test.ts`.

**Дисциплина расходов.** Живой прогон тратит реальные деньги:

1. сначала проверь **офлайн** — `npm run typecheck` и `SKEIN_LIVE=false npx vitest run
   tests/sandbox`; код метрик обязан быть зелёным до вызова модели;
2. один осознанный прогон за раз; прогон ограничен `maxTurns` (16) и крошечным
   воркспейсом, т.е. стоит копейки, но дерево **синтетическое**: сравнивай *форму*
   (токены на вызов, доли cache/reasoning, кривую контекста), а не абсолютные итоги, с
   прогоном Harbor;
3. реши **заранее**, что будешь сравнивать, и читай записанный артефакт (`metrics.json`,
   `contexts.ndjson`) вместо повторного запуска;
4. не запускай живой прогон «проверить, работает ли» — для этого есть скриптовая
   песочница.

Чтобы сравнить сохранённый живой прогон с Harbor, разбери job
(`npx tsx bench/agents_compare.ts ~/.skein-bench/harbor/<job>`, §6): у opencode токены по
вызовам в `agent/opencode.txt` (`step-finish`), у Skein — в `agent/langgraph-run.log`
(`SKEIN_TURN`/`SKEIN_METRICS`).

## 3.6 Песочница задач (реальные, без Harbor)

Реальные задачи terminal-bench гоняются локально настоящим движком и родным верификатором
задачи на двух бэкендах:

- **Docker** (задачи с образом). Родной образ задачи (`alexgshaw/<task>:20251031`) несёт
  точное окружение, на хост ничего не ставится. `/app` образа копируется во временный
  корень, затем контейнер `sleep` бинд-маунтит этот корень в `/app`; `run` = `docker
  exec`. Сеть по умолчанию `none`, выставлен разумный `--ulimit nofile` (valgrind), и git
  `safe.directory=*` (файлы образа принадлежат его пользователю, не root).
- **bwrap** (`container.ts`, для `regex-log`). Временный корень хоста в `/app` под `bwrap`
  с read-only `/usr` хоста, сеть выключена — для задачи без своего образа.

Портировано (13): `regex-log`, `fix-git`, `log-summary-date-ranges`,
`openssl-selfsigned-cert`, `git-leak-recovery`, `cobol-modernization`,
`modernize-scientific-stack`, `custom-memory-heap-crash`, `password-recovery`,
`db-wal-recovery`, `crack-7z-hash`, `fix-code-vulnerability`, `fix-ocaml-gc`.

| Файл | Роль |
| --- | --- |
| `tests/sandbox/docker.ts` | Docker-`Workspace` (`/app` образа → временный корень → `docker exec`) |
| `tests/sandbox/container.ts` | bwrap-`Workspace`; файловые инструменты рерайтят префикс `/app/` |
| `tests/sandbox/task.ts` | `SandboxTask` + поиск в кэше Harbor + обёртка верификатора и `pytest`-шим |
| `tests/sandbox/harness.ts` | `runTask`: материализация → setup → `runAgent` → `checkSetup` → верификатор → reward |
| `tests/sandbox/tasks/<id>.ts` | дескриптор задачи; `registry.ts` — id → задача |
| `tests/sandbox/sandbox-run.ts` | live-CLI |

Файлы задач читаются из `~/.cache/harbor/tasks/<hash>/<id>/` (в них canary бенчмарка), в
репозиторий не копируются.

```sh
# офлайн: без модели, реальный образ(ы) + верификатор; no-op → 0, родное решение → 1
SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts
# тяжёлый rebuild-верификатор fix-ocaml-gc (минуты), по требованию
SKEIN_SLOW_TASKS=1 SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts -t fix-ocaml
# один живой прогон задачи, с разрезом токенов (деньги)
npx tsx tests/sandbox/sandbox-run.ts <task-id> [--turns N]
```

Вывод — `bench/runs/sandbox-tasks/<ts>-<id>/`: `contexts.ndjson` (проекция по ходам),
`result.json` (`stopReason`, `reward`, результат верификатора, IR-журнал), `metrics.json`
(те же итоги/разрезы, что в §3.5), `reward.txt` (оценка верификатора).

**Верификатор.** `tests/test_outputs.py` запускается обёрткой без pytest; рядом кладётся
шим `pytest`, чтобы `import pytest` резолвился без установки. `checkIn: "host"` гонит
верификатор через bwrap для образа без Python (`git-leak-recovery`, `password-recovery`,
`crack-7z-hash`); `checkSetup` исполняет команду до верификатора в контейнере задачи
(`fix-ocaml-gc` пересобирает компилятор и пересоздаёт `tests.txt`).

**Изоляция / ограничения.** Docker-задачи держат сеть выключенной (кроме `crack-7z-hash`,
который ставит p7zip), домашний каталог хоста не монтируется, root-овые файлы вычищаются
изнутри контейнера при закрытии. bwrap-задачи делят `/usr` хоста, поэтому нужен инструмент
на хосте. Фоновая задача (`run {background: true}`) и `fetch` пока используют хостовую
реализацию.

**Как добавить задачу.** Напиши `tests/sandbox/tasks/<id>.ts` с `{ id, image?, files?,
setup?, check?, workdir?, checkIn?, checkSetup?, network? }` — `request` по умолчанию из
кэшированного `instruction.md`, `check` — из кэшированного `tests/test_outputs.py`;
`files` повторяют Docker `COPY`, `setup` — шаг Dockerfile/`setup.sh`. Зарегистрируй в
`tasks/registry.ts`. Сначала проверь офлайн (no-op → `reward=0`, родной `solution/solve.sh`
→ `reward=1`), потом живой прогон.

## 4. Синтетический бенч

```sh
npm run bench -- <case> [--model provider/model] [--max-turns N] [--compare]
```

Кейсы и метрика поведения берутся из соседнего репозитория
(`../skein-plugin/pilot/synthetic`, переопределяется `SKEIN_PLUGIN_ROOT`). Прогон
копирует `repo` кейса в свежий workdir, крутит агента, затем `check.sh`.

Результат — `bench/runs/<ts>-<case>-skein>/`:

| Файл | Содержимое |
| --- | --- |
| `trajectory.json` | предложенные действия по ходам |
| `turns.ndjson` | на ход: токены/кэш/`contextChars`/время |
| `contexts.ndjson` | **полная проекция** на ход (`turn`, `chars`, `context`) |
| `events.ndjson` | журнал IR: узлы, рёбра, `record_check`, `record_rejection` |
| `metrics.json` | сводка: reward, context `first/last/peak/growth`, граф, циклы |
| `reward.txt`, `check.out.txt`, `summary.txt` | вердикт и вывод `check.sh` |

## 5. Гейт против базовой линии

```sh
npm run bench:gate -- bench/runs/<ts>-<case>-skein
```

Сравнивает `metrics.json` с `bench/baseline.json` и печатает `PASS`/`FAIL` с
дельтами по метрикам (токены, контекст, циклы). Ненулевой код возврата — провал.

## 6. Harbor (реальные задачи)

```sh
bash bench/harbor/run.sh
```

`run.sh` рендерит `bench/harbor/skein.yaml` из `skein.template.yaml` (абсолютный
путь проекта), подставляет ключ и запускает `harbor run`. Ключ берётся из
`ROUTERAI_API_KEY` → `OPENAI_API_KEY` → `SKEIN_API_KEY` → `~/.config/opencode/opencode.json`.

Результаты — вне репозитория: `~/.skein-bench/harbor/<ts>/`. На триал:
`<task>__<id>/agent/langgraph-run.log` (строки `SKEIN_*`, §7),
`<task>__<id>/verifier/reward.txt`.

**Точечный прогон** (один кейс, не весь набор). `run.sh` передаёт свои аргументы
дальше в `harbor run`, поэтому набор/задачу/число попыток задаём флагами Harbor
после `run.sh`:

```sh
# один кейс, одна попытка (итерации по движку)
bash bench/harbor/run.sh -d terminal-bench -i fix-ocaml-gc -k 1
# две попытки (как в отчётах о прогонах)
bash bench/harbor/run.sh -d terminal-bench -i fix-ocaml-gc -k 2
```

- `-d/--dataset` — набор (`terminal-bench`), `-i/--include-task-name` — задача
  (поддерживает glob), `-k/--n-attempts` — попыток на триал; `-x/--exclude-task-name`
  исключает, `-l/--n-tasks` ограничивает число задач.
- Альтернатива (как в соседнем `skein-plugin`): задать одну задачу и `n_attempts`
  прямо в `bench/harbor/skein.template.yaml` (`datasets[0].task_names`), отрендерить
  `node bench/harbor/prepare.mjs`, затем `harbor run --config bench/harbor/skein.yaml -y`.

Результат — там же, вне репозитория: `~/.skein-bench/harbor/<ts>/<task>__<id>/`.

## 7. Инструментовка: где смотреть

В `langgraph-run.log` по ходу пишутся строки (каждая — один JSON):

| Строка | Содержимое |
| --- | --- |
| `SKEIN_CONTEXT` | **полная проекция** на ход: `{turn, chars, context}` |
| `SKEIN_PROPOSAL` | предложенное действие (в т.ч. текст команд) |
| `SKEIN_TURN` | на ход: токены/кэш/`contextChars`/время |
| `SKEIN_LLM_ERROR` | ошибка вызова модели (с номером попытки) |
| `SKEIN_EVENTS` | диагностика IR: цели, планы, альтернативы, `checks`, `observations`, `mutates`, отказы |
| `SKEIN_METRICS` | сводка: токены, `context` `first/last/peak/growth`, граф |

`contextChars` считается из того же `renderContext(context)`, что уходит в
`buildMessages`, поэтому размер в логе совпадает с отправленным контекстом.
Исполненные команды видны в `SKEIN_PROPOSAL` (предложенные) и в
`SKEIN_EVENTS.checks`/`.observations`/`.actions` (фактические, включая команду из
`done_when`). Локальный бенч кладёт то же в `bench/runs/<...>/` (§4).

## 8. Лимиты инструментов и проекции

Общего бюджета контекста нет: инструмент честно возвращает результат в объявленных
лимитах, а проекция его не режет (`docs/tools_ru.md`).

| Предел | Значение | Смысл |
| --- | --- | --- |
| `MAX_READ_LINES` | 400 | окно `read` за вызов; инструмент говорит «строки X–Y из Z» |
| `GREP_COUNT_DEFAULT` | 100 | совпадений `grep` в окне по умолчанию |
| `MAX_GREP_MATCHES` | 200 | максимум совпадений в окне `grep`; продолжение — `next`/`from` |
| `MAX_LIST_FILES` | 500 | максимум файлов в окне `list` |
| `OUTPUT_LIMIT` | 8000 | байтовый предел JSON-результата `grep`/`list` и вывода `run`; лишние `grep`/`list`-результаты отбрасываются целиком, вывод `run` — head+tail и `outputRef`/`errorRef` (stdout/stderr раздельно) |
| `SKEIN_CTX_ITEMS` | 20 | элементов в `plan`/`alternatives` проекции |

### 8.1 Устойчивый structured output

Агент предлагает через **нативные tool calls**: `src/llm/tools.ts` описывает по одному
плоскому function-инструменту на операцию (`create_goal`, `query`, `read`,
`grep`, `list`, `edit`, `write`, `run`, `fetch`, `apply_patch`, `stop`), а `invokeTools` в `src/llm/structured.ts`
биндит их с `tool_choice: "required"`, читает `tool_calls[0]` и маппит в IR `Action`.
Плоские схемы на операцию важны: одна глубокая вложенная discriminated-union приходила
плоской (`operator` на верхнем уровне вместо вложенного `action`), а JSON-режим заставлял
модель думать сильно больше на тяжёлых ходах (и упираться в cap, чьи ретраи
перепосылали всю проекцию). Если ответ обрезан по cap (`finish_reason: "length"`) и вызова
нет, `invokeTools` поднимает cap и повторяет вызов, как JSON-путь; для голого отсутствия
вызова — один repair-раунд; иначе цикл завершается с `stopReason: "llm_error"`, а не падает.

`invokeStructured` остаётся общим JSON-путём (схема в промпте, `response_format:
json_object`, ручной разбор, поднятый cap при обрыве, один repair-раунд); он покрыт
офлайн в `tests/structured.test.ts` и агентом не используется.

## 9. Ключи и секреты

Ключ живёт только в `.env` (gitignored) или в `~/.config/opencode/opencode.json`.
В репозиторий и в логи ключ не пишется. `run.sh` пробрасывает его в контейнер как
`OPENAI_API_KEY`.

## 10. Принципы

- **Офлайн по умолчанию.** `SKEIN_LIVE=false` для обычной проверки; live и
  Harbor — только намеренно. Песочница офлайн бесплатна (движок + извлечение метрик);
  живой прогон песочницы — один осознанный запуск с заданным сравнением, а не проба
  «работает ли вообще» (§3.5).
- **Перед дорогим прогоном — сохранить, что измеряем.** Полная проекция и
  исполненные команды должны попасть в лог/файлы (§4, §7), иначе разбор
  невозможен.
- **Один кейс, одна попытка** для итераций по движку; полный набор — для приёмки.
- **Сравнивать с сохранённым прогоном**, а не с памятью: `context first/last/peak`
  и `reward` из `metrics.json` / `SKEIN_METRICS`.
- **Минимальный диф.** Правка харнесса не меняет семантику движка; инварианты —
  в `tests/invariants.ts`.