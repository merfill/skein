# Skein — дефекты движка, найденные на fix-ocaml-gc, и план их исправления

> Английский оригинал — `docs/plans/engine_fixes_found.md`.

Связанное: `docs/plans/fix_ocaml_gc_investigation_ru.md` (журнал прогонов),
`docs/fix_ocaml_gc_run_report_2026-10-05_ru.md` (дефект фокуса),
`docs/fix_ocaml_gc_run_report_2026-10-06_ru.md` (принятый фикс),
`docs/ir_semantics_ru.md`, `docs/tools_ru.md`, `docs/projection_ru.md`,
`docs/testing_ru.md` (команды и live-гейт).

Статус: план согласован 2026-10-06. Пункты **S1–S5**, **P0**, **P1**, **P2**, **P3.1**,
**P3.3**, **P4** (удаление `need`) и **P5/P6** реализованы; бэктрейс в P1 —
best-effort, когда платформа пишет core через pipe. **P3.2** (быстрый прокси-reward)
отложен: нужна инфраструктура на внутренностях Harbor, а не работа над движком.

Приёмка (**2026-10-06, дважды**): два прогона `fix-ocaml-gc` на Flash + reasoning `high`,
`maxTurns 60`, `override_cpus: 4` — оба **reward 1.0** (`40 tests passed`). Первый
(`2026-10-06__10-57-47`, ~36 мин, с `need`) и второй (`2026-10-06__14-53-22`, ~39 мин,
после удаления `need` + P5/P6) назвали дефект (`pool_sweep` сдвигает `p` на
`Whsize_hd(hd)` вместо `wh`) и внесли эталонную однострочную правку; оба остановились по
`max_turns` (ходы ушли на опрос долгой сборки и перечитывание), но верификатор подтвердил
фикс в каждом. Второй прогон показывает, что движок после удаления `need` не деградирует
на live-пути. Детали: `docs/fix_ocaml_gc_run_report_2026-10-06_ru.md`. Артефакты:
`~/.skein-bench/harbor/2026-10-06__10-57-47/`, `~/.skein-bench/harbor/2026-10-06__14-53-22/`.

Ограничения задачи (согласованы): модель для повседневной работы не меняем; весь
набор бенча не гоняем; приёмка — один прогон `fix-ocaml-gc`.

---

## 1. Что к этому привело

Прогоны `fix-ocaml-gc` (terminal-bench): после run-length-сжатия свободного места в
major heap компилятор OCaml падает на bootstrap. Эталонный фикс — **один токен**:
`sed -i '650s/Whsize_hd(hd)/wh/' runtime/shared_heap.c`, т.е. безусловный сдвиг
курсора `p += Whsize_hd(hd);` → `p += wh;` (подтверждено из `solution/solve.sh`
задачи). Критерий: `make -C testsuite one DIR=tests/basic` → "40 tests passed".

Прогон 2026-10-05 сделал **одну** правку за 60 ходов (неверную), а остаток бюджета
ушёл в цикл `unknown_revision` (дефект фокуса), ретраи `Text file busy` и повторную
локализацию. Расследование — чат-пробы в идеальных условиях: код
`pool_sweep` с багом + макросы + диагностика падения, минимальный промт, история
собственных неудачных правок модели.

## 2. Находки (доказательства)

- **F1 — решающий фактор это переключатель reasoning, а не контекст и не движок.**
  Продовый клиент всегда шлёт `thinking:{type:"disabled"}`, а
  `SKEIN_REASONING_EFFORT` по умолчанию `none`
  (`src/llm/client.ts:23`, `src/config/settings.ts:33`).
  - Flash, reasoning **выкл**: 15/15 попыток мимо (и ещё 6 с богатым core dump —
    тоже мимо); строку 650 не тронул ни разу.
  - Flash, reasoning **high**: правильный фикс с первой попытки; с terse-ошибкой
    тоже решил (2/2). Core dump полезен, но **не обязателен**.
  - V4 Pro, reasoning **high**: правильный фикс с первой попытки.
- **F2 — эталон**: `sed '650s/Whsize_hd(hd)/wh/'`; `p += Whsize_hd(hd)` — это счёт
  **в словах** (Wosize+1), а каждый пул-блок занимает `wh` слов, поэтому сдвиг
  должен быть `wh`.
- **F3 — абляция контекста/инструкций не спасла модель без reasoning**: определения
  макросов, нота самой модели, полный gdb core (строка падения, локалы, `p-end=12`)
  и принудительный trace цикла — всё равно мимо. Это изолировало причину в
  модель/конфиг.
- **F4 — дефекты движка, найденные по ходу** (детали в §5–§7): фокус под закрытым
  предком; closing move мог целиться в предка; повтор после `inconclusive` был
  запрещён; ноты `complete` и diff правок не показываются; segfault/core dump не
  читается; у `run` лимит 120 с; верификатор пересобирает OCaml ~2 ч.

## 3. Сделано в рабочем дереве (S1–S5)

- **S1. `focusEvents` обрезает ветку под закрытым предком** — `src/ir/traversal.ts`
  (инвариант 17); тест `tests/ir.test.ts`.
- **S2. Closing move действует только на узел в фокусе** — `apply run {target}` и
  `complete {goal}` отвергают предка/сиблинга (`not_current_goal`) —
  `src/loop/classify.ts`; тесты `tests/loop.test.ts`.
- **S3. Повторная проверка после `inconclusive` разрешена** — `src/loop/classify.ts`;
  тест.
- **S4. Документы** — `docs/ir_semantics.md` (+`_ru`), `docs/ir.md` (+`_ru`),
  `docs/tools.md` (+`_ru`).
- **S5. Live step-тест** `focus-check` —
  `fixtures/live/fix-ocaml-gc-steps.json`, `tests/live/fix_ocaml_step.test.ts`.

## 4. P0 — reasoning включён и бюджет ответа больше (реализовано)

- `src/config/settings.ts`: `reasoningEffort` по умолчанию `"low"` для повседневных
  прогонов; тяжёлая задача поднимает его до `"high"` на прогон —
  `SKEIN_REASONING_EFFORT` либо `configurable.reasoningEffort` адаптера Harbor.
  `maxTokens` 4096 → **8192** (потолок 32768 без изменений).
- `src/llm/client.ts`: `reasoningBody(effort)` — `"none"` оставляет прежнее
  отключение, иначе `{ reasoning: { effort } }` (ровно тот формат, что дал верный
  фикс).
- `tests/loop.test.ts`: обновлён (дефолт `low`, override через env `high`, кейсы
  `reasoningBody`).

Согласовано: reasoning включён по умолчанию на `low`; бенч/приёмка
(`fix-ocaml-gc`) гоняются на `high` (`bench/harbor/skein.template.yaml` →
`configurable.reasoningEffort: high`). `maxTokens=8192`. Риск: `high` дороже по
латентности; часть провайдеров может дополнительно хотеть `thinking`; проверить live.

## 5. P1 — диагностика падения (core dump): не терять информацию о краше

**СДЕЛАНО (2026-10-06), P1b — best-effort.** `CommandResult.signal` заполняется в
`workspace.run`; обёртка поднимает `ulimit -c unlimited`; при crash-сигнале
(`!timedOut`) `crashReport` (`src/tools/crash.ts`) находит новейший `core*` в
воркспейсе и, если есть `gdb`, запускает `gdb --batch -nx -c <core> -ex bt -ex
"info locals"`. Payload observation/check несёт `signal`/`core`/`backtrace`, заголовок
хода говорит «killed by SIGSEGV», а `src/ir/project.ts` показывает их в `lastResult`
и в заметке `calls`. Если core не записан, движок сообщает `core_pattern` ядра — причина
видна. Покрыты обычный `run` и завершившийся фоновый job (`JobResult.startedAt`).
Файлы: `workspace.ts`, `crash.ts`, `tools/index.ts`, `events.ts`, `graph.ts`,
`project.ts`; документы `docs/tools.md` §4.3.

Итог разведки: на дев-хосте `core_pattern` — pipe в `systemd-coredump`
(`|/usr/lib/systemd/systemd-coredump …`), файл `core` в воркспейсе не появляется;
`gdb` установлен. В Docker-контейнере `core_pattern` наследуется от хоста, поэтому
файла core может не быть вовсе — тогда P1 даёт **только сигнал**, без бэктрейса.
Надёжная альтернатива для контейнера с pipe — явный прогон под gdb (открытый вопрос
§10).

Исходные точки потери:

1. `src/tools/workspace.ts` — `spawnSync` знает `result.signal`, но `CommandResult`
   его терял.
2. `src/tools/index.ts` — observation для `run` нёс `{command, verdict, output,
   error}`; ни сигнала, ни дампа.
3. Core не читался вовсе: ни `ulimit -c`, ни `gdb` по core (образ задачи ставит
   `gdb` — значит отладка предполагается).
4. `src/ir/project.ts` — `lastResult`/`calls` не показывали ни сигнал, ни бэктрейс.

## 6. P2 — информация, теряемая в проекции

**СДЕЛАНО (2026-10-06).** P2a: закрытая субъективная цель уходит из `path` (focusEvents
обрезает ветку под закрытым предком), поэтому `callsView` теперь добавляет запись
`complete <goal>` с её `note` (`src/ir/project.ts`); `PathNode` тоже несёт `note` для
закрытого корневого goal. P2b: `edit` хранит `find`/`replace` в payload действия,
неудачная правка теперь создаёт своё действие (с рёбром `produces`), а `calls` показывает
короткий diff `-find +replace` (плюс причину сбоя) вместо пустого «applied»
(`src/tools/index.ts`, `src/ir/project.ts`). P2c: `shown` несёт результаты **всех
уровней ветки**, не только листа, новейшее — первым, поэтому доказательство стадии
остаётся видимым до закрытия родителя (`src/loop/graph.ts`); TTL-тест кросс-уровня
переориентирован на вне-веточный результат. Документы `docs/tools.md` §4.4. Тесты:
`tests/loop.test.ts`, `tests/workingset.test.ts`.

## 6b. P4 — удаление `need` (модель больше не формирует контекст)

**СДЕЛАНО (2026-10-06).** Найдено при разборе приёмочного прогона 2026-10-06: `need` был
единственным местом, где докса объявляет, что логос должен показать, — противоречит
«докса предполагает, логос решает»; а плохой id (узел `complete`/`action` или
выдуманный) отклонял **всё** предложение — 6 из 8 отказов в том прогоне были `need` с
id без тела, один из них потерял валидный `read`. Уровневое удержание (P2c) и
`query {id}` покрывают возможность, поэтому `need` удалён: `proposalSchema`
(`src/llm/schemas.ts`), валидация (`src/loop/classify.ts`), пиннинг
(`src/loop/graph.ts`), промт (`src/loop/propose.ts`), live-харнесс/сценарии и документы
(`docs/context_design.md` §8, `docs/tools.md` §4.4, `docs/projection.md`, `docs/ir.md`).
Рабочее множество теперь принадлежит движку (уровни ветки) плюс тела `query {id}` (TTL).

## 6c. P5/P6 — отказ называет ход по фокусу; промт удерживает фокус

**СДЕЛАНО (2026-10-06).** Найдено live-прогоном `two-outputs`: после правки на фокусе
оказалась объективная цель `w:goal:42` с выполненным планом (`checkReady: true`), но
модель 12 ходов циклила `complete w:goal:2` / `complete w:goal:42`
(`not_current_goal` ↔ `objective_goal_needs_check`) до `max_turns` — она не действовала
по фокусу.

- **P5** (`src/loop/classify.ts`): детерминированный `focusHint(state)` читает фокус и
  возвращает конкретный ожидаемый ход (чек объективной цели с выполненным планом;
  `complete` субъективной; применить/спуститься в следующий пункт плана; интерпретировать
  запрос). Он добавляется к отказам `not_current_goal`, поэтому модель при неверной цели
  получает, что делать вместо этого — движок объявляет фронтир, докса всё равно
  предлагает.
- **P6** (`src/loop/propose.ts`): описание `complete` и правила теперь прямо говорят, что
  закрывать можно только фокус, а объективный фокус с выполненным планом решается чеком,
  не закрытием предка.
- `tests/live/scenarios.ts`: у `two-outputs` убрано теперь невыполнимое soft-ожидание
  `uses: ["query"]` (при уровневом удержании оба чтения остаются в поле; кросс-уровневый
  возврат ничем не вынуждается).

## 7. P3 — медленный верификатор и лимит `run` (варианты 1 + 2 + 3.3)

Корень: верификатор задачи `tests/test.sh` делает `make clean && ./configure &&
make -j4`, а `task.toml` даёт **cpus=1, memory=2G** (значит `-j4` = `-j1`); плюс
`bench/harbor/skein.template.yaml` ставит `timeout_multiplier: 2.0` → до 2 ч. У
агентского `run` лимит **120 с** (`src/tools/workspace.ts:232`), поэтому агент
**не может сам подтвердить** сборку.

Harbor сам сборку не проверяет: он гоняет верификатор задачи и читает
`/logs/verifier/reward.txt`. `make clean` — код задачи, не Harbor.

- **P3.1 (вариант 1) — больше CPU/RAM контейнеру. СДЕЛАНО (2026-10-06).** В
  `JobConfig` Harbor есть job-level `environment.override_cpus` / `override_memory_mb`
  (плюс `override_storage_mb`/`-gpus`/`-tpu` и
  `cpu_enforcement_policy`/`memory_enforcement_policy` = `auto|limit|request|guarantee|ignore`;
  CLI-флаги `--override-cpus` / `--override-memory-mb`). Он перезаписывает
  `task_env_config` для каждой задачи (`harbor/environments/base.py:296`), а Docker
  применяет как `--cpus` / лимит памяти (`docker/docker.py:269`). Задано в
  `bench/harbor/skein.template.yaml`: `override_cpus: 4`, `override_memory_mb: 6144`
  (влезает в 16 CPU / 30 G при `n_concurrent_trials: 3`). Проверено
  `harbor run --config bench/harbor/skein.yaml --print-config`. Ожидаемо: `make -j4`
  верификатора получает 4 ядра (~2 ч → ~30–40 мин).
- **P3.2 (вариант 2) — быстрый прокси-reward.** После прогона выполнять
  `make -C testsuite one DIR=tests/basic` по дереву агента (без `make clean`), через
  Harbor post-run хук/плагин или внешний скрипт в снапшоте. Минуты–15 мин; не
  официальный reward — для итераций.
  **Разведка (2026-10-06): чистого CLI-механизма нет.** У Harbor нет `exec` в
  запущенный trial; `artifacts` умеет скачать путь, но перенесённое дерево OCaml не
  пересобирается (абсолютные пути). Плагины — это Python entry points (ставятся в
  окружение Harbor) с `JobPlugin.on_job_start/on_job_end`; программный `Job` API даёт
  `on_verification_started` (хук, который мог бы выполнить инкрементальную проверку
  внутри контейнера). Это окружение-специфичная инфраструктура, не работа над движком
  — отложено, пока не понадобится много итераций.
- **P3.3 — таймаут `run` / долгие команды. СДЕЛАНО (2026-10-06).** `run` с
  `background: true` возвращает управление сразу с id задачи, опрос — `{job}`; лимит
  обычного `run` — `SKEIN_RUN_TIMEOUT_MS` (по умолчанию 120 с). Файлы:
  `src/tools/workspace.ts` (`startJob`/`pollJob`, раздельные логи
  `.skein/jobs/<id>.{out,err}`, `runTimeoutMs`), `src/tools/index.ts` (ветка `run`),
  `src/llm/schemas.ts`, `src/loop/classify.ts` (валидации; опрос — не повтор),
  `src/config/settings.ts`, `langgraph/graph.ts` (`configurable.runTimeoutMs`). Документы:
  `docs/tools.md` §4.7 (+`_ru`). Агент теперь может собрать и подтвердить свой фикс, не
  блокируя ход.

## 8. Порядок работ (согласован)

1. **P3.3** — иначе агент не может проверить сборку. **СДЕЛАНО.**
2. **P1** (диагностика падения) → **P2** (P1 питает P2: бэктрейс должен дойти до
   проекции). **СДЕЛАНО.**
3. **P3.1** (разведка Harbor → реализация) **СДЕЛАНО**; **P3.2** (хук/скрипт)
   **отложен** как инфраструктура на внутренностях Harbor, не работа над движком.
4. Live-сценарии + один приёмочный прогон на Flash+reasoning (или Pro+reasoning).
   **СДЕЛАНО** — `two-outputs`, `retrieve-at-scale` проходят live; приёмка
   `fix-ocaml-gc` — **reward 1.0 дважды** (2026-10-06).

## 9. Проверка

- Офлайн после каждой правки: `npm run typecheck`,
  `SKEIN_LIVE=false npx vitest run`.
- Live step-тесты: `SKEIN_LIVE=true npx vitest run tests/live/fix_ocaml_step.test.ts`.
- Точечные live-сценарии (reasoning вкл) на затронутые ветки цикла.
- Приёмка: один прогон `fix-ocaml-gc` с достаточным CPU у верификатора; читать
  `~/.skein-bench/harbor/<ts>/<trial>/verifier/reward.txt`.

## 10. Открытые вопросы

- P1: `core_pattern` хоста — pipe в `systemd-coredump`, поэтому в контейнере core,
  скорее всего, не пишется; добавить явный прогон под gdb / вариант `debug` или
  ограничиться сигналом?
- P3.1: есть ли в Harbor переопределение ресурсов на задачу.
- P3.2: плагин Harbor или внешний скрипт по снапшоту.
- ~~Оставлять ли `reasoningEffort=high` дефолтом для повседневных прогонов или
  повышать только на тяжёлых задачах.~~ **Решено (2026-10-06):** дефолт `low`;
  бенч/приёмка задают `high` на прогон (`configurable.reasoningEffort`).
