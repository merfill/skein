# Skein — тесты и бенчмарки

> Английское зеркало — `docs/en/testing.md`.
>
> Как запускать офлайн-тесты, живые проверки, песочницу и пошаговую отладку.
> Связанные документы: `ir.md` (модель и лента), `ir_operations.md` (реестр операторов),
> `projection.md` (лента), `sessions.md` (сессии и агенты), `AGENTS.md` (правила работы).

## 1. Слои и команды

| Слой | Команда | Что проверяет | Стоимость |
|---|---|---|---|
| Типы | `npm run typecheck` | `tsc --noEmit` | секунды |
| Офлайн-тесты | `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` | IR, проекция, цикл, проверки допустимости | секунды |
| Песочница, виртуальная | `SKEIN_LIVE=false npx vitest run tests/sandbox/fix-ocaml.test.ts` | цикл на виртуальной рабочей области | секунды, бесплатно |
| Метрики песочницы | `SKEIN_LIVE=false npx vitest run tests/sandbox/metrics.test.ts` | учёт токенов и вызовов | секунды, бесплатно |
| Live-гейт | `SKEIN_LIVE=true npx vitest run tests/gate.test.ts` | починка багфиксов живой моделью | минуты, деньги |
| Live-сценарии | `SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts` | короткие сценарии на ветки цикла | минуты, деньги |
| Live-сессии | `SKEIN_LIVE=true npx tsx tests/sandbox/session-live.ts` | маршруты general/respond/task и отчёт | минуты, деньги |
| Live-план | `SKEIN_LIVE=true npx tsx tests/sandbox/session-plan.ts <task-id> [--virtual]` | план-единица, исполнение пунктов и verifier задачи | минуты, деньги (Docker для реальной задачи) |
| Live-операции | `SKEIN_LIVE=true npx vitest run tests/live/ir_operations_step.test.ts` | следующий ход живой модели на собранной проекции | минуты, деньги |
| Синтетический бенч | `npm run bench -- <case>` | один кейс из `skein-plugin` | минуты, деньги |
| Гейт бенча | `npm run bench:gate -- <runDir>` | прогон против `bench/baseline.json` | секунды |
| Пошагово | `npx tsx bench/live-step.ts <task-id>` | реальный цикл, один ход за раз | минуты, деньги |
| Быстрая проба | `npx tsx bench/turn.ts <run>` | один записанный ход, без контейнера | копейки |

**По умолчанию — офлайн.** Живые проверки и бенчи запускаются только с явного разрешения
владельца.

**Никогда не запускай голый `npx vitest run`.** Он собирает `tests/sandbox/**`, которые
самостоятельно включаются на машине с Docker и образами задач и поднимают настоящие контейнеры и
верификаторы. Для обычной проверки всегда используй `--exclude 'tests/sandbox/**'`.

### 1.1 Приёмка first-run (релиз)

Чистая установка должна доходить до рабочего провайдера без checkout репозитория. Офлайн-половина
бесплатна; живой половине нужен реальный ключ и разрешение владельца.

Офлайн (сборка, установка в изолированный HOME, без ключа):

```sh
npm run build
npm pack --pack-destination /tmp/skein-firstrun
mkdir -p /tmp/skein-firstrun/install && cd /tmp/skein-firstrun/install
npm init -y && npm install /tmp/skein-firstrun/skein-swe-0.1.0.tgz
export HOME=/tmp/skein-firstrun/home XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share
node_modules/.bin/skein --version      # skein 0.1.0
node_modules/.bin/skein --help
node_modules/.bin/skein auth list      # ключей нет -> подсказка про `skein auth login`
node_modules/.bin/skein doctor         # not ready: API key is not set; exit 1
node_modules/.bin/skein </dev/null     # не-TTY -> понятная ошибка "run auth login"; exit 1
```

Живая (реальный ключ, сеть) — в Docker-образе или свежем HOME:

```sh
skein auth login          # провайдер, скрытый ключ, модель
skein doctor              # список моделей + однотокенный чат ok
skein --dir <project>     # TUI запускается
```

Затем один маленький прогон задачи до конца и проверка, что ошибки провайдера (401/404/timeout)
печатаются понятно. Сам `npx skein-swe` проверяется только после публикации пакета.

В Docker `--env-file` не снимает кавычки (значение `SKEIN_MODEL='...'` уходит в API вместе с
кавычками). Делай `source .env` и передавай переменные через `-e VAR` либо держи значения без
кавычек.

## 2. Офлайн-тесты

`.env` в `.gitignore` и выставляет `SKEIN_LIVE=true`; переменная окружения важнее файла. Для
обычной проверки:

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'
```

Реестр операторов — в `docs/en/ir_operations.md`; его тесты сгруппированы по оператору в
`tests/ops/` (`move`, `apply`, `recall`, `search`, `stop`, `applicable`, `traversal`,
`derivation`). Инварианты проверяются на 400 сгенерированных IR
(`tests/ops/ir_properties.test.ts`). `tests/coverage.test.ts` падает, если у id реестра нет
теста или тест цитирует id вне реестра.

Виртуальная песочница (`tests/sandbox/specs/fix-ocaml-gc.ts`) гоняет реальный цикл на маленьком
дереве без Docker: правка дефекта переключает эмулированную проверку с fail на pass. Это
бесплатное место для первой проверки изменения исполнителя.

## 3. Живые проверки

### 3.1 Live-гейт

```sh
SKEIN_LIVE=true npx vitest run tests/gate.test.ts
```

Гейт гоняет живую модель на `fixtures/bugfix/*`: агент должен починить падающий тест, не редактируя
тесты. Таймаут — 300 секунд на фикстуру. Нужен ключ (см. §7).

### 3.2 Live-сценарии

Короткие сценарии покрывают отдельные ветки цикла: `recall`/`search`, ревизию гипотезы,
ограничения, ответ без правки и поиск по многим файлам. Матрица команд (`fail-recover`,
`script-two-bugs`, `make-command`, `verbatim-flag`, `command-from-package`) покрывает задачи,
где условие включает реальную команду. Стратегические сценарии — `reference-diff` и `no-vcs`.

Фикстуры лежат в `fixtures/scenarios/<name>/{repo, request.txt, check.sh?, constraints.json?}`;
`check.sh` необязателен и по умолчанию равен `node --test`.

```sh
SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
SKEIN_SCENARIOS=two-outputs,revise-hypothesis SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
SKEIN_SCENARIO_REPEATS=3 SKEIN_SCENARIOS=script-two-bugs SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
```

Сценарии независимы и идут параллельно (`it.concurrent`, `test.maxConcurrency: 5`). Каждый тест
чистит свой временный корень.

Харнесс гоняет только `runAgent`; отдельной программы проверки нет. Запрос завершается, когда
закрыто его терминальное состояние; условия по критерию нет. Жёсткие проверки: был ли запрос
закрыт, инварианты (`tests/invariants.ts`), неизменность `test/` и явных путей, число
различимых повторных результатов (`maxRepeats`), запрещённые правки и форма команд `bash`
(`expect.commands`). `SKEIN_SCENARIO_REPEATS=N` гоняет сценарий N раз и показывает pass-rate;
мягкий отчёт по веткам печатается в stdout.

Полные проекции и журналы пишутся в `bench/runs/live-<ts>-<name>/{contexts,events}.ndjson`,
вместе с `workset.ndjson`, `workset.json` и `run.json`.

### 3.3 Live-сессии

```sh
SKEIN_LIVE=true npx tsx tests/sandbox/session-live.ts  # general -> task -> report
SKEIN_LIVE=true npx tsx tests/sandbox/general-live.ts  # анализ -> general, только чтение, без task
```

`session-live` проверяет три маршрута (`general`, `respond`, `task`) и отчёт после задачи;
`general-live` проверяет, что вопрос по проекту уходит в `general`, общая единица читает через
`read`/`grep`/`list`, а задача кодирования не открывается. `document`-единица покрыта офлайн
(`tests/document_unit.test.ts`); отдельного live-харнесса для её маршрута пока нет.

### 3.3.1 Live-прогоны плана

```sh
SKEIN_LIVE=true npx tsx tests/sandbox/session-plan.ts fix-ocaml-gc --virtual --turns 20  # дёшево
SKEIN_LIVE=true npx tsx tests/sandbox/session-plan.ts fix-ocaml-gc --turns 60            # Docker
SKEIN_LIVE=true npx tsx tests/sandbox/session-plan.ts custom-memory-heap-crash --turns 80
```

`session-plan` принудительно делает первую операцию `plan`, затем исполняет пункты реальными
агентом сессии, планировщиком и агентами task/general, и оценивает результат собственным
приёмочным механизмом задачи (`test.sh` для Docker, команда спеки для `--virtual`). Печатает
план, итог каждого пункта и reward; `plan.json`, `run.json`, `session.json` ложатся в
`bench/runs/session-plan/`. Виртуальный прогон дешёвый; реальная Docker-задача — минуты и деньги.

### 3.4 Live-шаги операций

```sh
SKEIN_LIVE=true npx vitest run tests/live/ir_operations_step.test.ts
```

Тест собирает проекцию офлайн, затем проверяет форму следующего хода живой модели.
`SKEIN_STEP_REPEATS=N` (по умолчанию 3) повторяет шаг, поэтому стохастический промах не считается
провалом.

### 3.5 Переигрывание трассы

```sh
npm run replay -- <trace-or-scenario> [--limit N] [--offset N] [--model M]
```

Переигрывание берёт записанную трассу (`contexts.ndjson` сценария или сохранённый лог агента
со строками `SKEIN_CONTEXT`/`SKEIN_PROPOSAL`), восстанавливает
`buildMessages(context)` на каждый ход и гоняет текущий `invokeTools` на том же контексте. Оно
печатает предложенный и записанный оператор, выходные токены и причину завершения, затем сводку.
Это дешёвый способ отладить промпт или схему на реальном распределении контекстов.

Длинный горизонт ленты проверяется офлайн: `tests/workingset.test.ts` гоняет скриптовый
пропозер через реальный цикл и проверяет рост и срез при закрытии. Метрики — из
`tests/workset.ts`.

## 4. Песочница задач (реальные задачи)

Реальные задачи terminal-bench идут локально с настоящим циклом и родным верификатором задачи.
Все тринадцать задач используют один путь — **Docker rootless**:

- образ задачи (`alexgshaw/<task>:20251031`) несёт точное окружение; на хосте ничего не
  ставится;
- контейнер стартует из образа; `/app` не копируется на хост и не бинд-маунтится;
- файловые инструменты, `bash`, фоновые задачи и checkpoint идут через `docker exec`;
  `grep`/`list` возвращают пути относительно рабочей области; хранилище checkpoint —
  `/tmp/.skein` в контейнере;
- родной `tests/test.sh` задачи запускается после агента, в его контейнере, и пишет
  `/logs/verifier/reward.txt`; у верификатора своя сеть, даже когда агент офлайн;
- `--net on|off` управляет сетью агента. Задача, которой нужна сеть (`crack-7z-hash`), при
  `--net off` отклоняется.

Портированные задачи: `regex-log`, `fix-git`, `log-summary-date-ranges`, `openssl-selfsigned-cert`,
`git-leak-recovery`, `cobol-modernization`, `modernize-scientific-stack`,
`custom-memory-heap-crash`, `password-recovery`, `db-wal-recovery`, `crack-7z-hash`,
`fix-code-vulnerability`, `fix-ocaml-gc`.

Файлы задач читаются из кэша задач бенчмарка (`~/.cache/harbor/tasks/<hash>/<id>/`) и никогда
не копируются в репозиторий.

```sh
# офлайн: без модели, реальные образы и верификатор; no-op -> 0, родное решение -> 1
SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts
# медленная пересборка fix-ocaml-gc (минуты), по запросу
SKEIN_SLOW_TASKS=1 SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts -t fix-ocaml
# один живой прогон задачи, с разрезом токенов
npx tsx tests/sandbox/sandbox-run.ts <task-id> [--turns N] [--net on|off]
```

`--turns` по умолчанию берёт `maxTurns` задачи (60 для `fix-ocaml-gc`), иначе 80; явный
`--turns` перекрывает оба значения.

Прогон пишет `bench/runs/sandbox-tasks/<ts>-<id>-<random>/`: `contexts.ndjson` (проекция по
ходам), `result.json` (`stopReason`, reward, вывод верификатора, журнал IR), `metrics.json`
(те же итоги и разрезы, что в §5) и `reward.txt`.

### 4.1 Матрица

`matrix.ts` прогоняет всю сетку `agent × net × repeat` для одной задачи, каждая ячейка — в своём
дочернем процессе:

```sh
npx tsx tests/sandbox/matrix.ts regex-log \
  --agents skein,opencode --nets on,off --repeat 3 \
  --concurrency 6 --timeout 1200 --resume
```

Задача — аргумент; полная кампания — это вызов на каждую задачу. `--turns` (Skein) по умолчанию
берёт `task.maxTurns`; `--max-steps` ограничивает opencode; `--timeout` — жёсткий предел ячейки.
`--resume` пропускает готовые ячейки; `--only-failed` перезапускает всё, что не `ok`; `--dry`
печатает сетку. Результат — `bench/runs/matrix/<ts>-<task>/` с `manifest.json`, `summary.json` и
`cells/<agent>-net<mode>-r<n>/`.

### 4.2 Baseline opencode

```sh
npx tsx tests/sandbox/opencode-run.ts <task-id> [--net on|off]
```

Тот же образ и верификатор, другой агент. Трасса: `opencode.txt`, `metrics.json`,
`api-requests.ndjson`, `api-responses.ndjson`, `contexts.ndjson`, `reasoning.ndjson`.

### 4.3 Как добавить задачу

Напиши `tests/sandbox/tasks/<id>.ts` с `{ id, image?, files?, setup?, check?, workdir?,
checkIn?, checkSetup?, network?, maxTurns? }`. `request` по умолчанию берётся из кэшированного
`instruction.md`; Docker-путь использует кэшированный `tests/test.sh`; `files` повторяет Docker
`COPY`, `setup` — шаг Dockerfile/`setup.sh`. Зарегистрируй задачу в `tasks/registry.ts`. Сначала
проверь офлайн (no-op → `reward=0`, родной `solution/solve.sh` → `reward=1`), затем запускай
живой прогон.

## 5. Пошаговая отладка

### 5.1 `bench/live-step.ts` — реальный цикл, один ход за раз

Это единственный пошаговый драйвер. Исполнитель и проекция работают на хосте; файловые
инструменты, `bash`, фоновые задачи и checkpoint — в долгоживущем контейнере задачи. Каждый шаг
продолжает `runAgent` через `seed`/`startTurn`, поэтому переходы, отказы, откаты и рассуждения на
ленте принадлежат исполнителю.

```sh
npx tsx bench/live-step.ts <task-id> --net off --dir /tmp/opencode/<run>
```

Флаги: `--turn N` — остановиться после абсолютного хода N; `--auto` — без ожидания;
`--net on|off`; `--dir`; `--signal`.

Без `--auto` процесс печатает ход и ждёт:

```sh
touch /tmp/opencode/<run>/continue   # следующий ход
touch /tmp/opencode/<run>/quit       # остановиться
```

Файлы в `--dir`:

| Файл | Содержимое |
|---|---|
| `contexts/tNNN.txt` | ровно сообщения, отправленные модели |
| `reasoning.ndjson` | скрытое рассуждение провайдера (диагностика, не лента) |
| `turns.ndjson` | вызовы, usage, стоимость, stop reason |
| `journal.ndjson` | полный журнал событий после каждого хода |

Этот драйвер нужен для поведения: в каком состоянии закрылся ход, куда перешёл, сколько потратил
рассуждений, что вызвал, какой дифф дерева.

### 5.2 `bench/turn.ts` — один записанный ход, без контейнера

Переигрывает записанный ход через живую модель без контейнера. Это дешёвый способ сравнить
формулировки на одном входе.

```sh
npx tsx bench/turn.ts <run-dir-or-trace> --turn N
```

Флаги: `--turn N`, `--turns A-B`, `--turns 6,8,10`, `--list`, `--dry`, `--repeat K`,
`--append-system "..."`. `--rebuild` пересобирает текущую проекцию поверх записанного хода; для
`working` и `terminal` он передаёт `allowText`, как `propose`, иначе текстовое закрытие чинится
как пропущенный вызов инструмента и проба лжёт.

`turn.ts` нужен для формулировок и решений одного хода, а не для среды.

### 5.3 `bench/replay.ts` — записанные контексты как есть

Переигрывает записанные контексты через живую модель без пересборки проекции. Нужен, чтобы
сравнить правку промпта ровно на тех контекстах, которые были записаны.

### 5.4 Правила

- **Один фактор за раз.** Стриминг, температура и правки промпта — отдельные плечи.
- **K≥3.** Один сэмпл при `temperature=0.1` — не вывод.
- **Сравнивать в одном харнессе.** `turn.ts`, `live-step` и `sandbox-run` различаются числом
  ходов и средой; сравнение через харнессы — не сравнение.
- **Судить по действию и рассуждению**, а не по впечатлению.
- **Сначала офлайн.** Код и промпт проверяются офлайн до любого живого прогона.

## 6. Артефакты и ключи

- Каждый живой прогон пишет `contexts`, `turns`, `journal` и, где применимо,
  `reasoning.ndjson`; точный список файлов указан рядом с командой выше.
- `metrics.json` несёт разрез по токенам, кэшу, рассуждениям и стоимости.
- Ключ живёт только в `.env` (gitignored) или в `~/.config/opencode/opencode.json`; он никогда не
  пишется в репозиторий или логи.

## 7. Принципы

- **Офлайн по умолчанию.** Живые проверки и бенчи — намеренные дорогие запуски.
- **Тяжёлые тесты требуют разрешения владельца.** Это `tests/sandbox/**` с Docker, любой
  `SKEIN_LIVE=true` и бенчи.
- **Сохраняй то, что измеряешь.** Полная проекция и команды должны попасть в артефакты, иначе
  прогон не разобрать.
- **Один кейс, одна попытка для итераций по исполнителю; полный набор — для проверки.**
- **Сравнивай с сохранённым прогоном**, а не с памятью.
- **Минимальный диф.** Правка харнесса не меняет семантику исполнителя; инварианты — в
  `tests/invariants.ts`.
