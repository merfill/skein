# Skein — прогон тестов и бенчей

> Английское зеркало — `docs/en/testing.md`.

Единая точка, чтобы не искать команды и места вывода по репозиторию. Относится к
`package.json` (скрипты), `bench/` (синтетический бенч и гейт),
`bench/harbor/` (реальные задачи) и `langgraph/graph.ts` (инструментовка).

Этот же документ покрывает тестирование на реальных задачах (песочница, Harbor, драйвер
live-step и быстрая проба `bench/turn.ts`).

## 1. Слои проверки

| Слой | Команда | Что проверяет | Стоимость |
| --- | --- | --- | --- |
| Типы | `npm run typecheck` | `tsc --noEmit` | секунды |
| Офлайн-тесты | `SKEIN_LIVE=false npx vitest run` | инварианты IR, проекция, цикл, проверка допустимости | секунды |
| Песочница (офлайн) | `SKEIN_LIVE=false npx vitest run tests/sandbox` | движок на виртуальном воркспейсе; извлечение метрик | секунды, бесплатно |
| Live-гейт | `SKEIN_LIVE=true npx vitest run tests/gate.test.ts` | починка багфиксов живой моделью | минуты, деньги |
| Live-сценарии | `SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts` | короткие сценарии на ветки движка | минуты, деньги |
| Песочница (live) | `SKEIN_LIVE=true npx tsx tests/sandbox/live-trace.ts` | один прогон моделью по песочнице, с разрезом токенов | 1 прогон, деньги |
| Live сессии | `SKEIN_LIVE=true npx tsx tests/sandbox/session-live.ts` | маршруты general/respond/start, post-task report | минуты, деньги |
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

Операторы дерева специфицированы в `docs/ru/ir.md` (реестр ID: `OP-MV`, `OP-CG`,
`OP-AP`, `OP-RC`, `OP-SR`, `OP-ST`, `TR`, `DER`, `REF`, `PRJ`). Их офлайн-тесты
сгруппированы по оператору в `tests/ops/` (`move`, `apply`, `recall`, `search`,
`stop`, `applicable`, `traversal`, `derivation`); инварианты проверяются на 400 случайных легальных деревьях
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

Короткие сценарии на отдельные ветки цикла (`recall`/`search`, ревизия гипотезы,
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

Харнесс сценариев гоняет только `runAgent` (зеркалит `bench/run.ts`): отдельной
программы приёмки нет. Запрос завершается на собственном `stop` доксы — `stop` терминального
хода завершает запрос, гейта по критерию нет, — поэтому запрос, не называющий
литеральной команды, всё равно закрывается, как только модель переходит в Hand-off
и останавливается.

Жёсткие проверки (падение теста): закрыт ли запрос
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

### Live сессии

Два синтетических скрипта проверяют контейнер сессии живой моделью на фиксированном
workspace (только с `SKEIN_LIVE=true`):

```sh
SKEIN_LIVE=true npx tsx tests/sandbox/session-live.ts  # general read -> task -> report
SKEIN_LIVE=true npx tsx tests/sandbox/general-live.ts  # анализ -> general, read-only, без task
```

`session-live` проверяет диалог на всех трёх маршрутах (`general`, `respond`, `start`) и post-task report;
`general-live` задаёт общий вопрос по мини-проекту и требует, чтобы session-агент выбрал
`general`, general-unit использовал `read`/`grep`/`list`, coding task не открывался, а ответ
был Markdown с путями. Скрипты печатают каждый session call/result и итоговый view.

### Live-шаги по операциям

`SKEIN_LIVE=true npx vitest run tests/live/ir_operations_step.test.ts` строит проекцию
каждой семьи операций **офлайн** (ровно то, что показал бы движок) и проверяет **форму**
следующего хода живой модели: интерпретировать запрос, запустить готовый критерий,
опросить фоновый job, повторить нерешающую (timeout) проверку, применить
следующий пункт плана, последовать подсказке фокуса. `SKEIN_STEP_REPEATS=N` (по умолчанию
3) повторяет шаг, поэтому стохастический промах — не провал. Спецификация и карта
покрытия — `docs/ru/ir.md` (EN + RU).

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

### Симуляция ленты на длинном горизонте (офлайн)

Длинный горизонт проверяется без модели: `tests/workingset.test.ts` гоняет
скриптованный proposer через реальный цикл и проверяет рост и срез при закрытии состояния
(ходы состояния остаются в ленте, пока оно открыто, и уходят на `stop`; рабочего множества
нет — `recall`/`search` теперь узлы, как любой шаг); метрики — из
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
  один). Вызов наблюдателя тоже считается: это настоящий вызов модели и настоящая трата.
  Поскольку наблюдатель работает в `progress`, уже после дельты хода, его вызов попадает в
  **следующий** ход; если следующего нет (сработал на последнем) — в последний.
- `toolCalls` — один на ход (**без** принудительного `tool_choice`); **отклонённое** предложение —
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
задачи. Все 13 задач идут одним путём — **Docker rootless**:

- Родной образ задачи (`alexgshaw/<task>:20251031`) несёт точное окружение, на хост ничего
  не ставится. Контейнер стартует прямо из образа; `/app` **не** копируется на хост и не
  бинд-маунтится. File-tools, `grep/list`, `bash`, фоновые jobs и checkpoint — через
  `docker exec`; `grep`/`listFiles` возвращают workspace-relative пути, как `fsWorkspace`.
  Store `/tmp/.skein` в контейнере (`DockerBackend`). Сеть агента следует `--net`
  (`on` = bridge, `off` = отключена); выставлен `--ulimit nofile` (valgrind) и git
  `safe.directory=*`.
- Приёмка — родной **`tests/test.sh`** задачи: он ставится после агента и запускается в его
  контейнере (путь Harbor). Скрипт сам поднимает рантайм (`apt`/`uv`/`pip`), поэтому
  `regex-log` не нужен Python в образе. У verifier своя сеть даже при offline-агенте;
  reward — `/logs/verifier/reward.txt`.
- **bwrap** (`container.ts`) остаётся только для `bench/minimal.ts` и image-less fallback;
  opencode-baseline идёт legacy bind-mounted Docker-путём, путь задачи — rootless.

Портировано (13): `regex-log`, `fix-git`, `log-summary-date-ranges`,
`openssl-selfsigned-cert`, `git-leak-recovery`, `cobol-modernization`,
`modernize-scientific-stack`, `custom-memory-heap-crash`, `password-recovery`,
`db-wal-recovery`, `crack-7z-hash`, `fix-code-vulnerability`, `fix-ocaml-gc`.

| Файл | Роль |
| --- | --- |
| `tests/sandbox/docker.ts` | Docker-`Workspace` (rootless: образ → `docker exec`; `signatures` батчем) |
| `tests/sandbox/docker.test.ts` | rootless: `fetchTo` (docker cp) и parity `list`/`grep`/`listFiles` |
| `tests/sandbox/checkpoint-docker.ts` | `DockerBackend`: checkpoint store `/tmp/.skein` в контейнере |
| `tests/sandbox/container.ts` | bwrap-`Workspace` (`bench/minimal`, image-less fallback); файловые инструменты рерайтят префикс `/app/` |
| `tests/sandbox/task.ts` | `SandboxTask` + поиск в кэше Harbor + legacy-обёртка верификатора и `pytest`-шим |
| `tests/sandbox/network.ts` | `--net on/off`: сеть агента и сеть verifier |
| `tests/sandbox/harness.ts` | `runTask`: материализация → setup → `runAgent` → stage `test.sh` → запуск → `reward.txt` |
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
npx tsx tests/sandbox/sandbox-run.ts <task-id> [--turns N] [--net on|off]
```

`--net on` (как в Harbor) даёт агенту bridge. `--net off` снимает сеть с агента и лишает
интернета **хостовый** `fetch` (и хостовые `run` там, где они есть): CLI гонит их `curl`
через allowlist-прокси, разрешающий только API модели. Verifier независим и всегда с сетью —
`test.sh` ставит через неё свой рантайм. Задача, которой сеть нужна агенту
(`crack-7z-hash`), при `--net off` отклоняется. Baseline для сравнения — opencode с
`--net off` (`opencode-run.ts`).

Прогон использует собственный `maxTurns` задачи, если он задан (build-heavy задача вроде
`fix-ocaml-gc` ставит 60 — её критерий пересобирает весь компилятор, а каждый фоновый опрос
стоит хода), иначе 24; явный `--turns N` переопределяет и то, и другое.

Вывод — `bench/runs/sandbox-tasks/<ts>-<id>-<random>/`: `contexts.ndjson` (проекция по ходам),
`result.json` (`stopReason`, `reward`, результат верификатора, IR-журнал), `metrics.json`
(те же итоги/разрезы, что в §3.5), `reward.txt` (оценка верификатора).

Baseline opencode гоняет ту же задачу в том же образе (`npx tsx
tests/sandbox/opencode-run.ts <task-id> [--net on|off]`). Кроме `opencode.txt` (сырой поток
событий `--format json`) и `metrics.json`, его вызовы модели снимаются логирующим
reverse-прокси на `baseURL` (`api-log-proxy.mjs`): пишутся сырые
`api-requests.ndjson`/`api-responses.ndjson`, а из них — `contexts.ndjson` (точный контекст
на вызов: messages + tools) и `reasoning.ndjson` (потоковый reasoning), аналоги артефактов
Skein. `opencode run --format json` и сессионная БД opencode не отдают ни промпт, ни текст
рассуждений.

Родной `tests/` задачи копируется в `/tests` **после** хода агента, никогда до: иначе shell
агента его прочтёт, а harbor-овский `test.sh` пере-клонирует ровно ту ревизию с багом (то
есть называет решение). `test.sh` идёт в контейнере агента с его окружением, поэтому
поставленный агентом пакет виден приёмке. Верификатор заново материализуется из кэша задачи
в момент проверки, поэтому reward воспроизводим.

**Верификатор.** Reward — `/logs/verifier/reward.txt`, который пишет `test.sh`; его exit code
не авторитетен (скрипты заканчиваются успешным `echo`, даже когда pytest упал). Отсутствие
файла — сбой верификатора, не pass. `test.sh` сам ставит `uv`/Python/pytest, а для
`fix-ocaml-gc` пере-клонирует и пересобирает компилятор — поэтому verifier ходит в сеть даже
при offline-агенте. `checkIn`/`checkSetup` остаются только для legacy/bwrap; opencode тоже
запускает родной `test.sh`.

**Изоляция / ограничения.** `--net off` снимает сеть с агента (задача, которой она нужна,
`crack-7z-hash`, отклоняется); verifier сохраняет свою сеть. Домашний каталог хоста не
монтируется, root-овые файлы вычищаются изнутри контейнера при закрытии. `fetch` скачивает URL на хосте (allowlist/constraints) и
копирует байты в контейнер; фоновые jobs в rootless-режиме исполняются в контейнере. bwrap
(`container.ts`) делит `/usr` хоста и используется только `bench/minimal` и image-less
fallback.

**Как добавить задачу.** Напиши `tests/sandbox/tasks/<id>.ts` с `{ id, image?, files?,
setup?, check?, workdir?, checkIn?, checkSetup?, network?, maxTurns? }` — `request` по умолчанию из
кэшированного `instruction.md`; Docker-путь берёт кэшированный `tests/test.sh`; `files`
повторяют Docker `COPY`, `setup` — шаг Dockerfile/`setup.sh`. `check`/`checkIn`/`checkSetup` —
legacy. Зарегистрируй в
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
| `events.ndjson` | журнал IR: узлы, рёбра, `mutate`, `record_rejection` |
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
| `SKEIN_EVENTS` | диагностика IR: состояния, планы, альтернативы, `observations`, `mutates`, отказы |
| `SKEIN_METRICS` | сводка: токены, `context` `first/last/peak/growth`, граф |

`contextChars` считается из того же `promptText(context)`, что уходит в
`buildMessages`, поэтому размер в логе совпадает с отправленным контекстом.
Исполненные команды видны в `SKEIN_PROPOSAL` (предложенные) и в
`SKEIN_EVENTS.observations`/`.actions` (фактические, включая команду запуска).
Локальный бенч кладёт то же в `bench/runs/<...>/` (§4).

## 8. Лимиты инструментов и проекции

Общего бюджета контекста нет: инструмент честно возвращает результат в объявленных
лимитах, а проекция его не режет (`docs/ru/tools.md`).

| Предел | Значение | Смысл |
| --- | --- | --- |
| `GREP_COUNT_DEFAULT` | 50 | совпадений `grep` в окне по умолчанию |
| `MAX_GREP_MATCHES` | 100 | максимум совпадений в окне `grep`; продолжение — `next`/`from` |
| `GREP_BEFORE_DEFAULT` / `GREP_AFTER_DEFAULT` | 3 / 3 | строк контекста вокруг совпадения `grep` |
| `MAX_LIST_FILES` | 200 | максимум файлов в окне `list` |
| `READ_LIMIT` | 32768 | байтовый предел (32K) окна `read` (по байтам, без лимита строк; резервирует место под трейлер `continue from`); большее тело читается следующим окном или через `recall` |
| `GREP_LIMIT` / `LIST_LIMIT` | 8192 | малый байтовый предел (8K) результата `grep`/`list`: указатель на кандидатов, не содержимое; лишние совпадения/файлы отбрасываются целиком (у `grep` — трейлер `continue from`) |
| `RUN_LIMIT` | 8192 | малый байтовый предел (8K) `run`; показывается хвост, полный поток — за `outputRef`/`errorRef` (stdout/stderr раздельно) |
| `QUERY_BODY_LIMIT` | 65536 | предел окна тела `recall`; окно ужимается по строкам, чтобы JSON-результат остался валидным |
| `SKEIN_CTX_ITEMS` | 20 | элементов в `plan`/`alternatives` проекции |

### 8.1 Устойчивый structured output

Агент предлагает через **нативные tool calls**: `src/llm/tools.ts` описывает по одному
плоскому function-инструменту на операцию (`move`, `recall`, `search`, `read`,
`grep`, `list`, `edit`, `write`, `run`, `fetch`, `apply_patch`, `stop`). `invokeTools` в `src/llm/structured.ts`
биндит их как AI SDK tools (без принудительного `tool_choice` — см. `docs/ru/state_testing.md` §7),
маппит возвращённые tool calls в IR `Action`, а usage/reasoning берёт из результата AI SDK.
Плоские схемы на операцию важны: одна глубокая вложенная discriminated-union приходила
плоской (`operator` на верхнем уровне вместо вложенного `action`), а JSON-режим заставлял
модель думать сильно больше на тяжёлых ходах (и упираться в cap, чьи ретраи
перепосылали всю проекцию). Если ответ обрезан по cap (`finish_reason: "length"`) и вызова
нет, `invokeTools` делает **один** повтор на потолке с явной краткостной инструкцией
(«вызови инструмент сейчас, не пересказывай анализ») — он **не** удваивает cap дальше,
что лишь провоцирует ещё больший reasoning (живой прогон `fix-ocaml-gc` превратил одно
`read` в 4 вызова / 60.9k токенов); для голого отсутствия вызова — один repair-раунд.
**Брошенный** провайдерный вызов (сеть/5xx/лимит) — другой сбой: тот же запрос
перепосылается `SKEIN_LLM_RETRIES` раз (по умолчанию 2) с небольшим backoff, чтобы флаки
провайдера не срывали прогон. Лишь когда ретраи и repair-раунды исчерпаны, цикл
завершается с `stopReason: "llm_error"`, а не падает; текст ошибки при этом пишется в
`stopText` (`result.json`/`metrics.json` прогона), а не только в транзиентный ход.

`invokeStructured` остаётся общим JSON-путём (схема в промпте, `response_format:
json_object` через provider options, ручной разбор, поднятый cap при обрыве, один
repair-раунд); он покрыт офлайн в `tests/structured.test.ts` mock-моделью AI SDK и агентом
не используется. Сам wire-формат закреплён `tests/wire.ts`: реальная сериализация
`@ai-sdk/openai-compatible` через stub `fetch`.

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

## Skein — тестирование на задачах

>
> Как проверять поведение на настоящих terminal-bench задачах: песочница без Harbor,
> Harbor, пошаговый прогон в контейнере и быстрая проба `bench/turn.ts`.
> Связанные документы: `docs/ru/state_testing.md` (лента, состояния и драйвер live-step).

### 0. Что выбрать

| вопрос | инструмент | контейнер | модель | цена |
|---|---|---|---|---|
| типы, IR, проекция, промт | `npm run typecheck`; `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` | нет | нет | секунды, бесплатно |
| движок на синтетической задаче | `tests/sandbox/live-trace.ts`, `tests/sandbox/fix-ocaml.test.ts` | bwrap/виртуальный workspace | опционально | секунды–центы |
| полный прогон реальной задачи + reward | `tests/sandbox/sandbox-run.ts` | Docker | да | минуты, ₽ |
| поведение по ходам (реальный движок) | `bench/live-step.ts` | Docker, долгоживущий | да | ₽ |
| быстрый A/B формулировки на одном ходу | `bench/turn.ts` | нет | да | центы |
| официальный terminal-bench | `bench/harbor/run.sh` | Harbor/Docker | да | долго, ₽ |
| сравнение с opencode | `tests/sandbox/opencode-run.ts`, `bench/agents_compare.ts` | Docker | да | ₽ |

Правило: **код и промт сначала проверяются оффлайн**; живой прогон — только когда вопрос
уже про поведение модели.

### 1. Песочница без Harbor

Песочница — это ported terminal-bench задачи в `tests/sandbox/`. Она запускает **реальный
движок** (`runAgent`), реальные инструменты и **собственный verifier задачи**, но без
Harbor:

- задача описана в `tests/sandbox/tasks/<id>.ts` (`SandboxTask`) и зарегистрирована в
  `tests/sandbox/tasks/registry.ts`;
- файлы задачи (`instruction.md`, `tests/`, `solution/`) читаются из кэша Harbor
  `~/.cache/harbor/tasks/<hash>/<id>/` и никогда не копируются в репозиторий;
- все ported задачи (включая `regex-log`) идут в Docker **rootless**: контейнер стартует
  прямо из образа, `/app` **не** выгружается в host temp-root и не бинд-маунтится; файловые
  инструменты (`read/write/edit/grep/list`), `bash`, фоновые jobs и checkpoint работают в
  контейнере через `docker exec`; `grep`/`listFiles` возвращают workspace-relative пути.
  Store — `/tmp/.skein` в контейнере (`DockerBackend`).
  Задача без `image` (сейчас таких нет) упала бы в `bwrap` (`tests/sandbox/container.ts`),
  который оставлен для opencode-baseline/`minimal`;
- `setup` выполняется до агента; **родной `tests/test.sh` задачи** запускается после агента
  в контейнере агента, ровно как в Harbor. Тесты копируются в `/tests` только в этот момент,
  поэтому не могут утечь в workspace. `test.sh` сам поднимает рантайм (`apt`/`uv`/`pip`), а
  reward — его `/logs/verifier/reward.txt` (не exit code);
- у verifier своя сеть: `--net off` снимает сеть только с **агента**
  (`tests/sandbox/network.ts`). `checkIn`/`checkSetup` — только для legacy/bwrap; opencode тоже
  запускает родной `test.sh` задачи.

- checkpoint-слой (`CheckpointBackend`; `HostBackend` для bwrap/virtual, `DockerBackend` для
  Docker) даёт read-only снапшоты и revert проваленного Patch;
- `runTask`/`openTaskWorkspace` (`tests/sandbox/harness.ts`) — общий setup для полного
  прогона и пошагового драйвера; для Docker — rootless-путь.

Полезные поля `SandboxTask`: `image`, `workdir`, `mountPoint`, `setup`, `maxTurns`,
`network` (задаче нужна сеть агенту), а для legacy/opencode-пути — `check`, `checkIn`,
`checkSetup`.

#### Полный прогон

```sh
npx tsx tests/sandbox/sandbox-run.ts <task-id> [--turns N] [--net on|off]
```

- без `--turns` берётся `task.maxTurns` (например, 60 у `fix-ocaml-gc`), иначе 24;
- `--net on` (как в Harbor) даёт агенту bridge; `--net off` снимает его с агента и
  закрывает **хостовый** `fetch` allowlist-прокси (только API модели). У verifier сеть
  остаётся всегда, чтобы `test.sh` мог поставить Python/pytest. Задача, которой сеть нужна
  агенту (`crack-7z-hash`), при `--net off` отклоняется;
- `metrics.json` пишет `network` (запрошенный), `networkAgent`, `networkVerifier`,
  `acceptance` (`test.sh`) и `rewardSource` (`reward.txt`);
- каждый прогон пишет `bench/runs/sandbox-tasks/<ts>-<id>-<random>/` (уникальный суффикс —
  параллельные прогоны не делят каталог): `contexts.ndjson`, `result.json`, `metrics.json`,
  `reward.txt`, `reasoning.ndjson`;
- `reward=1` — verifier задачи прошёл; `stop=request_addressed` — движок закрыл запрос;
- для диагностики: `SKEIN_TIMINGS=1` печатает `capture`/`model` timing,
  `SKEIN_TRACE_ACTIONS=1` — аргументы действий.

#### Оффлайн-проверка задачи (без модели)

```sh
## no-op → 0, solution/solve.sh → 1; Docker + verifier, без модели
SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts
## медленный fix-ocaml-gc (пересборка), по запросу
SKEIN_SLOW_TASKS=1 SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts -t fix-ocaml
```

Это **не** «бесплатные» тесты: они поднимают контейнеры и образы. Запускать осознанно.

#### Виртуальная спека

`tests/sandbox/specs/fix-ocaml-gc.ts` — миниатюрная копия задачи с эмулированными
`make`/testsuite, без Docker и сети:

```sh
SKEIN_LIVE=false npx vitest run tests/sandbox/fix-ocaml.test.ts
SKEIN_LIVE=true npx tsx tests/sandbox/live-trace.ts
```

`live-trace.ts` пишет `bench/runs/sandbox-live-<ts>-fix-ocaml-gc/` и годится для формы
траектории, но не для reward реальной задачи.

#### Opencode baseline

```sh
npx tsx tests/sandbox/opencode-run.ts <task-id> [--net on|off]
```

Тот же образ и verifier, другой агент. Трасса: `opencode.txt`, `metrics.json`,
`api-requests.ndjson`, `api-responses.ndjson`, `contexts.ndjson`, `reasoning.ndjson`.

#### Матрица на одну задачу

`matrix.ts` прогоняет всю сетку `agent × net × repeat` для **одной** задачи, каждая ячейка —
в своём дочернем процессе (изолированный прокси-env `--net off`, убивается по wall-clock
таймауту):

```sh
npx tsx tests/sandbox/matrix.ts regex-log \
  --agents skein,opencode --nets on,off --repeat 3 \
  --concurrency 6 --timeout 1200 --resume
```

- задача — аргумент, а не зашитый список: полная кампания — это вызов на каждую задачу
  (shell-цикл снаружи); дефолта «все задачи» нет;
- `--turns` (Skein) по умолчанию `task.maxTurns`; `--max-steps` ограничивает opencode;
  `--timeout` — жёсткий wall-clock ячейки (агент + verifier);
- ячейки `--net off` для задачи, которой нужна сеть (crack), помечаются `unsupported` и не
  запускаются;
- `--resume` пропускает готовые ячейки; `--only-failed` перезапускает всё, что не `ok`;
  `--dry` печатает сетку без запуска;
- результат: `bench/runs/matrix/<ts>-<task>/` с `manifest.json` (обновляется по ячейкам),
  `summary.json` и `cells/<agent>-net<mode>-r<n>/` (обычные файлы трассы плюс `run.log`).
  Убитая ячейка оставляет `.timeout`; `--resume` её перезапустит.

### 2. Harbor

Harbor — официальный runner terminal-bench. Он запускает задачу целиком (среда, агент,
официальный verifier) в Harbor-джобе и нужен для **официальной приёмки** и сравнения
агентов, а не для пошаговой отладки.

```sh
bash bench/harbor/run.sh
## сравнение Skein vs opencode
SKEIN_HARBOR_CONFIG=compare.yaml bash bench/harbor/run.sh
```

`run.sh`:

- рендерит `bench/harbor/*.template.yaml` через `prepare.mjs` (абсолютные пути проекта и
  джобов, ключ RouterAI; рендеренные `.yaml` gitignored);
- берёт ключ из `ROUTERAI_API_KEY`, `OPENAI_API_KEY`, `SKEIN_API_KEY` или глобального
  `~/.config/opencode/opencode.json`;
- запускает `harbor run --config ... -y`.

Джобы лежат **вне репозитория**: `~/.skein-bench/harbor/<job>/`. Там `agent/` с логами
(`langgraph-run.log`, `opencode.txt`) и артефактами; разбор:

```sh
npx tsx bench/agents_compare.ts ~/.skein-bench/harbor/<job>
```

Кэш задач Harbor (`~/.cache/harbor/tasks/<hash>/<id>/`) нужен и песочнице: без него
`materializeTask` не найдёт `instruction.md`/verifier.

### 3. Пошаговый прогон в контейнере

`bench/live-step.ts` — **единственный** пошаговый драйвер. Движок работает на хосте,
инструменты — в долгоживущем контейнере задачи; каждый ход — продолжение `runAgent`
(`seed`/`startTurn`), поэтому переходы, отказы, revert и reasoning на ленте — движка.

```sh
npx tsx bench/live-step.ts <task-id> --net off --dir /tmp/opencode/<run>
```

Флаги: `--turn N` (остановиться после абсолютного хода N), `--auto` (без пауз), `--net on|off`,
`--dir`, `--signal`.

Без `--auto` процесс печатает ход и ждёт:

```sh
touch /tmp/opencode/<run>/continue   # следующий ход
touch /tmp/opencode/<run>/quit       # остановиться
```

Файлы в `--dir`:

| файл | содержимое |
|---|---|
| `contexts/tNNN.txt` | ровно сообщения, отправленные модели |
| `reasoning.ndjson` | скрытый reasoning провайдера (диагностика, не лента) |
| `turns.ndjson` | вызовы, usage, стоимость, stop reason |
| `journal.ndjson` | полный журнал событий после каждого хода |

Что смотреть: в каком состоянии закрылся ход (`stop`/`move`), объём `reasoning`, вызовы,
дифф дерева; на `plan`/`working` лента заканчивается per-turn tail.

### 4. Быстрая проба: `bench/turn.ts`

Повторяет **один записанный ход** из трассы `sandbox-tasks` через живую модель — без
контейнера. Это дешёвый способ сравнить формулировки на одном и том же входе.

```sh
npx tsx bench/turn.ts <run-dir-or-trace> --turn N
```

Флаги:

| флаг | смысл |
|---|---|
| `--turn N` / `--turns A-B` / `--turns 6,8,10` | какие ходы повторять |
| `--list` | показать ходы трассы |
| `--dry` | собрать сообщения и tool surface, без вызова модели |
| `--repeat K` | K сэмплов одного хода |
| `--append-system "..."` | добавить system в конец |
| `--patch patch.json` | править записанные сообщения (append/insert/remove/replace) |
| `--rebuild` | заново отрендерить промт текущим кодом поверх записанного `history` |
| `--reasoning` | печатать reasoning |
| `--responses` | печатать сырые ответы модели по попыткам |
| `--dump out.txt` | сохранить итоговые сообщения |
| `--model M` | другая модель |

`--rebuild` нужен, когда меняешь **код проекции/промта**: он берёт `history` из трассы и
зовёт текущие `buildMessages`. `--patch` меняет уже записанные сообщения и не пересобирает
промт; с `--rebuild` его использовать нельзя. `--append-system` работает в обоих режимах.

`--rebuild` берёт записанную `history` как есть. На старой трассе закрытое состояние может
всё ещё нести instruction/workspace старой проекции, что приглашает лишний «второй взгляд»:
на одном и том же `L → P`-переходе такая история дала `Research` в 3/10 сэмплов, а свежая
лента (закрытое состояние — только `Start`/`Finish`) — `Patch` 10/10. Для проб переходов
собирай свежую ленту или минимальную синтетическую `history`, а не старую `--rebuild`-трассу.

Пример patch-файла:

```json
[
  { "op": "replace", "match": "A suspected cause is enough", "text": "Stop now." },
  { "op": "append", "role": "system", "text": "Do not compare with upstream." }
]
```

Ограничения: нет контейнера, нет настоящих переходов/отката, tool surface
восстанавливается из `situation` (и острова), а не из `Context.applicable`. Поэтому
`turn.ts` — для формулировок и tool selection, не для доказательства поведения движка.
При temp 0.1 смотреть `K≥3`.

### 5. Вспомогательные инструменты

- `bench/rollout.ts <run> [--turns N] [--dry]` — строит **свежую** ленту текущей проекцией
  и катит модель вперёд; наблюдения берутся позиционно из записи. Это decision replay, не
  среда.
- `bench/replay.ts <trace-or-scenario> [--limit N] [--offset N]` — те же записанные контексты
  через живую модель.
- `bench/minimal.ts` — no-IR микро-агент (4 сообщения) для A/B хинтов.
- `tests/live/*` — живые сценарные/шаговые тесты (`SKEIN_LIVE=true`).
- `bench/gate.ts` + `baseline.json` — регрессионный gate по метрикам.

### 6. Что читать в трассе

`metrics.json` (`tests/sandbox/metrics.ts`):

- `in` = `freshInput` + `cacheRead`; `out` = `visibleOutput` + `reasoningTokens`;
- `cacheHitRatio`, `costRub`, `contextChars` (`first/last/peak`);
- `perTurn`: `operator`/`tool`, `chars`, `llmCalls`, токены, `refused`.

`contexts.ndjson` — проекция/сообщения по ходам; `result.json` — `stopReason`, `reward`,
verifier и журнал IR; `reward.txt` — вердикт.

### 7. Правила

- **Живые прогоны — только с явного разрешения владельца.** Они стоят денег и времени.
- **Никогда** не запускать `npx vitest run` без `--exclude 'tests/sandbox/**'` для обычной
  проверки: sandbox-тесты сами включаются при Docker + образах и поднимают контейнеры.
- Оффлайн: `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'`.
- Один фактор за раз; `SKEIN_TEMPERATURE=0.1` шумит — `K≥3`, не один сэмпл.
- Сравнивать только в одной гарнитуре: `turn.ts`, `live-step`, `sandbox-run` и Harbor
  несопоставимы по числу ходов и по тому, что они проверяют.
- Секреты живут только в `.env` (gitignored).
- После прогона контейнеры/временные деревья должны быть убраны (`cleanupContainers`,
  `cleanupSandboxes` вызываются в `finally`; при ручном kill — проверить `docker ps`).

### 8. Шпаргалка

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'

## полный прогон задачи (Docker + verifier)
npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --net off --turns 60

## пошагово, с паузами
npx tsx bench/live-step.ts fix-ocaml-gc --net off --dir /tmp/opencode/loc
touch /tmp/opencode/loc/continue

## матрица на одну задачу (агенты × сеть × повторы), с resume
npx tsx tests/sandbox/matrix.ts regex-log --agents skein,opencode --nets on,off --repeat 3 --dry
npx tsx tests/sandbox/matrix.ts regex-log --agents skein,opencode --nets on,off --repeat 3 --concurrency 6 --timeout 1200 --resume

## быстрый A/B записанного хода
npx tsx bench/turn.ts <run> --list
npx tsx bench/turn.ts <run> --turn 8 --dry
npx tsx bench/turn.ts <run> --turn 8 --repeat 3
npx tsx bench/turn.ts <run> --turns 6-8 --rebuild --append-system "..."

## официальная приёмка / сравнение
bash bench/harbor/run.sh
SKEIN_HARBOR_CONFIG=compare.yaml bash bench/harbor/run.sh
npx tsx bench/agents_compare.ts ~/.skein-bench/harbor/<job>
```

### 9. Если что-то не работает

- **`Harbor task cache not found` / `task not cached`** — нет
  `~/.cache/harbor/tasks/<hash>/<id>/`; кэш нужен и sandbox, и Harbor.
- **Docker-образ не найден** — задача смотрит на `alexgshaw/<id>:20251031`; убедиться, что
  образ есть локально (`docker images`).
- **`stop=max_turns`** — бюджет кончился; поднять `--turns` (но сначала понять, почему
  модель не закрылась).
- **`--net off` и `fetch`/`curl` → 403** — это ожидаемо: allowlist пускает только API модели.
- **В ленте нет reasoning** — `SKEIN_REASONING_TAPE=false`; по умолчанию reasoning на ленте
  включён. `bench/turn.ts` по умолчанию показывает записанные сообщения, `--reasoning`
  печатает reasoning, `--responses` — сырые ответы.
- **Транспортный `llm_error`/retry** — смотреть `turns.ndjson`/лог; внутренний retry не теряет
  ходы, но стоимость растёт.
- **Verifier видит свой `test.sh`?** — он копируется в `/tests` только после агента и
  запускается в его контейнере; если правишь harness, не переносить staging до прогона.
- **`test.sh` упал на apt/uv/pip** — у verifier своя сеть, даже при `--net off`; проверь
  `docker exec`/stderr в `result.json`. `rewardSource:"missing"` означает, что
  `/logs/verifier/reward.txt` не появился.
- **Контейнер остался** — `docker ps | grep skein`, затем `docker rm -f <name>`; штатно
  `cleanupContainers()` делает это сам.
