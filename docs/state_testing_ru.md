# Skein — методика тестирования состояний (живой ход за ходом)

> Английское зеркало — `docs/state_testing.md`.

> Рабочий документ. Как проверять и отлаживать промт по состояниям на **живой задаче**
> (`fix-ocaml-gc`), идя **по одному ходу движка**, исполняя команды в контейнере задачи и
> записывая ленту каждого хода. Это основной инструмент отладки: здесь и процесс, и код,
> который его реализует, и разбор того, как строится лента.
>
> Связанные документы: `docs/states_ru.md` (цели и критерии состояний),
> `docs/prompt_state_machine_concept_ru.md` (граф состояний), `docs/testing_ru.md`,
> `docs/ir_semantics_ru.md` §7 (лента), `AGENTS.md`.
>
> **2026-11-03:** `Recovery` больше не живое состояние; его работа входит в `Research`.

## 0. Цель

Добиться, чтобы на каждом состоянии агент:
- делал **работу состояния** (а не работу соседнего),
- **закрывал** состояние (`stop`) по своему критерию — без дрейфа и без «судьи»-эталона,
- не **затягивал** (не пере-выводил уже добытое).

Мерим по ходам: в каком состоянии закрылся или куда ушёл; объём `reasoning`; содержание
`why`. Модель — `routerai/~deepseek/deepseek-v4-flash-latest`, `SKEIN_TEMPERATURE=0.1`
(**шумно**: по одному сэмплу вывод не делать, смотреть `K≥3`).

## 1. Инструменты

1. **Реальный движок, ход за ходом** — `bench/live-step.ts` (см. `docs/live_step_ru.md`). Один
   процесс держит контейнер задачи и дерево; каждый шаг — продолжение `runAgent`
   (`seed`/`startTurn`, `maxTurns: startTurn + 1`). Переходы, отказы, откат проваленного Patch и
   reasoning на ленте — движка. **Для поведения использовать это.**
2. **Оффлайн-переигрыш записанного хода** — `bench/turn.ts` (в репозитории). Берёт уже
   **записанную** ленту хода, правит сообщение (например, строку критерия) и снова зовёт
   модель — **без контейнера**. Дёшево; для сравнения формулировок на одном и том же входе.
3. **Replay записанной ленты через `runAgent`** — `seed`/`startTurn` + контейнер. Нужен, когда
   проверяешь **переходы движка** (`stop`/`move`, откат неверного Patch): ручной цикл `propose`
   обходит `executeNode`. Чеклист — §2.5.

Правило: **не гонять контейнер на каждую правку текста** — только новый живой прогон.

## 2. Как всё исполняется

### 2.1 Контейнер задачи

Реализация — `tests/sandbox/docker.ts`, функция `dockerWorkspace(root, options)`.

- **Образ задачи уже содержит нужное окружение** (репозиторий, тулчейн), поэтому на хосте
  ничего устанавливать не надо.
- Для Docker-задач контейнер стартует **прямо из образа**:
  `docker run -d --entrypoint sleep --network <bridge|none> -w /app <image> infinity`. `/app`
  не выгружается в host temp-root и не бинд-маунтится (`rootless`); host-копии `/app` нет.
  Rootless Docker не умеет подключать сеть к контейнеру, стартовавшему с `--network none`,
  поэтому контейнер всегда стартует на bridge: при `--net off` bridge снимается с агента
  после setup и возвращается перед `test.sh`.
- Команды, файловые инструменты (`read`/`grep`/`list`/`edit`/`write`), `bash`, фоновые jobs и
  checkpoint идут через `docker exec` в этот же контейнер, поэтому `/app` и `/tmp` означают
  одно и то же и для инструментов, и для shell; `grep`/`listFiles` возвращают
  workspace-relative пути, как `fsWorkspace`.
- Checkpoint store — `/tmp/.skein` **в контейнере** (`DockerBackend`); `/app/.skein/checkpoints`
  — symlink на него.
- Все ported задачи, включая `regex-log`, идут этим путём. Приёмка — родной
  `tests/test.sh` задачи, который после агента копируется в `/tests` и запускается в этом же
  контейнере; он сам ставит Python (`uv`), поэтому образ может быть без него. `bwrap`
  (`container.ts`) остался только для `bench/minimal` и image-less fallback: там workspace —
  host-root, file-tools — host `fsWorkspace`, `/tmp` — per-invocation tmpfs. opencode-baseline
  идёт legacy bind-mounted Docker-путём и той же приёмкой `test.sh`.
- Уборка — `cleanupContainers()` (`docker rm` контейнера; host-mount для `/app` больше нет).

### 2.2 Исполнение команд

Реализация — `src/tools/index.ts`, функция `executeAction(action, state, workspace, turn)`.
Она превращает один оператор доксы в **события журнала**:

- `move` / `stop` / `decline` — узлы IR, контейнер не нужен.
- `apply` по инструментам:
  - `bash` → `runShell` → `workspace.run(command)` → в контейнере исполняется
    `docker exec -w <workdir> <name> bash -lc "set -o pipefail; umask 000; <command>"`.
    Результат — узел-наблюдение с `exitCode`, `output` (хвост stdout), `error` (хвост stderr);
    если тело большое — полный поток за `outputRef`/`errorRef` (достаётся `recall`).
  - `read` / `grep` / `list` → `workspace.read/grep/listFiles` (то же дерево) → наблюдение
    (окно ограничено ~8K; при переполнении — голова + `outputRef`).
  - `edit` / `write` / `apply_patch` → правка дерева → `mutate`.
- Наблюдения и действия попадают в IR; `placeMove` вешает действие на план текущего состояния.

То есть **команды доксы исполняются в контейнере**, а их stdout/stderr возвращаются на ленту
как результат вызова инструмента.

### 2.3 Драйвер хода

`bench/live-step.ts` — реальный движок, один ход на запуск (подробно — `docs/live_step_ru.md`):

```sh
npx tsx bench/live-step.ts <task-id> --net off --dir <dir>
```

- `openTaskWorkspace(task)` для Docker идёт rootless-путём: контейнер из образа, `/app` не
  копируется на хост, checkpoint — `/tmp/.skein`; выполняется `setup`; это тот же setup, что
  у полного прогона;
- каждый ход — продолжение `runAgent` (`seed`/`startTurn`, `maxTurns: startTurn + 1`), поэтому
  переходы, отказы, откат проваленного Patch и reasoning на ленте — движка, а не харнесса;
- после хода процесс печатает состояние, вызовы, наблюдения, usage, cost и дифф дерева, пишет
  ленту и ждёт `<dir>/continue` (или идёт дальше с `--auto`; `--turn N` — остановиться после N).

### 2.4 Куда пишется лента

Каталог — `--dir` (по умолчанию `bench/runs/sandbox-tasks/<ts>-<task>-live-step`):

- `contexts/tNNN.txt` — **читаемая лента** хода (ровно то, что ушло модели);
- `reasoning.ndjson` — скрытый reasoning провайдера по ходам (диагностика, не лента);
- `turns.ndjson` — по ходу: `{ turn, situation, island, actions, usage, cost, stopReason }`;
- `journal.ndjson` — полный журнал событий после каждого хода.

Живые прогоны целиком лежат в `bench/runs/sandbox-tasks/<ts>-<name>/`.

### 2.5 Replay с записанной ленты (как гонять один ход)

Если проверяешь **переходы движка** (`stop`/`move`, откат неверного Patch), нужен replay
**ленты через `runAgent`**, иначе хук в `executeNode` обходится. Для этого у `AgentInput` есть `seed` (готовый журнал) и `startTurn` (номер хода);
`maxTurns` остаётся абсолютным.

Чеклист:

1. **Выбери run и точку входа.**
   - второй вход в Patch — fold до `descend` после `move` (состояние `plan / patch`);
   - провал Verification (transition) — до `stop`-edge закрытой Verification;
   - рабочая Verification после провала — до `result`-edge упавшего `bash`.
2. **Приведи дерево к сиду.** Подними `dockerWorkspace` для `fix-ocaml-gc`; примени/откати
   записанный `edit` (или `write`/`apply_patch`) так, чтобы файл соответствовал событиям.
   Затем добавь в сид синтетический `mutate` с фактической версией файла (`workspace.version`).
   Без этого IR и дерево расходятся, и следующий `edit` получает `stale_base`.
3. **Запусти `runAgent({ propose, workspace, maxTurns }, { request, seed, startTurn })`.**
   Не делай ручной цикл `propose`: переходы и откат живут в `executeNode`.
4. **Поставь sentinel в `propose`.** Остановись, когда `context.island` достиг целевого
   (например, `patch` после отката или `verification` перед сборкой) — так один прогон не
   уходит в дорогой build.
5. **Пиши `contexts/tNNN.txt`, `turns.ndjson`, `journal.ndjson`.** Смотри `reasoning`,
   действия, `stop why`, `revert`; контекст — ровно то, что ушло модели.
6. **K≥3 и один фактор за раз.** `SKEIN_STREAMING`, `SKEIN_TEMPERATURE` и правки промта —
   отдельными плечами; иначе вывод будет не про тот фактор.

Что ожидать после текущего фикса:

- Verification провалилась → `stop` → `move` в Patch (провал может быть и в изменении, и в
  причине, на которую оно опиралось) → движок пишет `revert` последнего Patch: файл
  возвращается к pre-patch, версии в IR обновляются;
- Patch применяет **другой** diff, а не вариант откатанного;
- вторая ошибка Verification снова даёт `stop` → Patch → revert, без отладки и правок внутри
  Verification.

## 3. Как формируется лента (что затирается, что добавляется)

Лента строится `project` (`src/ir/project.ts`) и `buildMessages`
(`src/loop/propose.ts`) из IR **каждый ход заново** (детерминированно: одни события → один
`Context`). Ничего не «копится» само: источник — журнал событий, лента — его проекция.

Общий скелет одного хода:

```
system   — базовый промт (States + Transitions + строка про имена файлов)   [всегда]
system…  — ограничения (constraints), если есть                              [по необходимости]
user     — ЗАПРОС пользователя                                              [всегда, один раз]
… состояния (дети запроса) в порядке появления …
system   — инструкция текущей ситуации (plan/working/transition/terminal)   [всегда]
```

**Запрос** показывается **один раз, вторым сообщением** (сразу после базового промта) — и так
на **каждом** ходу, чтобы задача была видна и внутри состояния. Отдельного probe-сообщения
после запроса **нет**.

**Probe** — один сессионный `fact` (`id: fact:session`, payload `{ environment, material }`),
записанный на старте запроса (`src/loop/probe.ts`). `material` — карта workspace (`root`, `cwd`
если shell стартует не в root, repo, entries/paths, files), без конфигов, команд сборки и
расширений. Проекция показывает её как
`Workspace` в Orientation; в Patch/Research та же карта идёт как `Orientation result` плюс
`Probe` (environment) отдельным заголовком; остальные состояния получают только `Probe`.
Закрытые состояния блоков не несут, на request-ходу их нет. `environment` также несёт
`network: on|off` — режим агента, записанный harness (не угаданный shell); он говорит, можно ли
ставить отсутствующий рантайм. Полный вывод probe на
ленту не попадает; replay читает записанный факт.

**Вход в состояние** (показывается, пока состояние открыто; brief — только у текущего):

```
system   — Start state <Label>
system   — <brief: Workspace map / Orientation result / Probe>
system   — <инструкция острова: как действовать в этом состоянии>
user     — Goal: <island.what> (+ "Your earlier guess (may be wrong): <move.what>", если задана)
…план…
system   — <per-turn tail: hint, критерий, closure>  [не хранится]
```

**Возврат в Patch после провала.** Отдельного блока `Previous failed attempt`
текущая реализация **не рендерит** (это проверяют `tests/revert.test.ts` и
`tests/tape_render.test.ts`). Провал остаётся на ленте в `Finish`-строках закрытых `Patch` и
`Verification`: `stop.why` упавшей Verification — буквальный пересказ ошибки (команда, exit,
фактический текст), а не диагноз кода.

Откат делает движок на переходе `Verification → Patch` по провалу: он пишет
событие `revert` (файлы + новые версии) и возвращает дерево к pre-patch. Планы закрытых
состояний элидируются, поэтому фактическая правка отдельно не рендерится — модель видит
`Finish`-строки и pre-patch дерево. Если откат невозможен (например, `write`/`apply_patch` без
preimage), изменение остаётся в дереве, а отдельного предупреждения на ленту нет — известный
пробел.

**Открытое состояние** — после этого идут шаги плана: каждый ход доксы — пара
`ai(tool_calls=[…])` + по одному `tool(результат)` на вызов.

**Закрытое состояние** — план **элидируется**: остаются только

```
system — Start state <Label>
system — Finish state <Label> — <why из stop>
```

**Хвост хода** (`system`; `transition` — тоже `system`):

| ситуация | что добавляется |
|---|---|
| `request` | `REQUEST_INSTRUCTION` — выбрать стартовое состояние (`move`) или `decline` |
| `plan` | `planInstruction` — «Call a tool…» + tail: hint → `done`-критерий → closure |
| `working` | `turnInstruction` — тот же tail (per-turn, не хранится) |
| `transition` | `transitionInstruction` — прочитать строку `Finish state`, выбрать следующее состояние |
| `terminal` | `NODE_INSTRUCTIONS.terminal` — «This is End. …» |

**Что затирается (не показывается):**
- `what` из `move` — не цель состояния (в блоке `island.what` как `Goal:`); если докса задала
  `what`, он показывается как непроверенная догадка на этом ходе;
- **план закрытого состояния** — все пары `ai`/`tool` заменяются одной строкой `Finish state`.

**Что добавляется:**
- запрос — вверху, один раз;
- вход состояния — `ai(Start)` + `system(инструкция)` + `user(what)`;
- хвост хода — per-turn tail открытого состояния (`plan`/`working`) или инструкция ситуации
  (не хранится, на следующем ходу пересобирается);
- вызовы инструментов — как `tool_calls` в `ai`; шаги одного хода доксы идут **одной пачкой**
  (`ai` с массивом `tool_calls` + N `tool`), а не по паре на вызов.

## 4. Метод-правила

- Один сэмпл при `temp=0.1` — **не вывод**; смотреть `K≥3`.
- Сравнивать варианты на **одном и том же ходу** (один вход).
- Судить по **действию** (`stop`/куда ушёл) и по `reasoning`, а не по «кажется».
- Правки — общие, без костылей под `fix-ocaml-gc`.
- Живые/контейнерные прогоны — только с явного разрешения владельца (время и деньги).

## 5. Достижения и текущие проблемы (на завтра)

### Сделано (сегодня)

- **D rootless (2026-10-23).** Docker-задачи идут без host-копии `/app`: file-tools, `grep/list`,
  `bash`, jobs и checkpoint — в контейнере; checkpoint store `/tmp/.skein` (`DockerBackend`);
  тогда verifier для `checkIn:"host"` шёл в отдельный контейнер (`SKEIN_VERIFIER_IMAGE`);
  позже заменено на родной `test.sh` в контейнере агента. Найден и исправлен 5-минутный
  `signatureMap` (per-file `docker exec` → batched `signatures`). Crack после фикса: 24 хода,
  reward=1, request_addressed.
- **Приёмка через `test.sh` (2026-10-24).** Docker-путь запускает родной `tests/test.sh`
  задачи после агента в его контейнере (как Harbor) и читает `/logs/verifier/reward.txt`.
  `--net off` снимает сеть только с агента; verifier всегда с сетью.
- **D закрыт (2026-10-23, session 10).** `regex-log` переведён на свой образ + verifier-контейнер
  (bwrap ушёл из task-пути); `stageSolution` идёт rootless; `live-step` считает дифф деревом
  внутри контейнера; `fetchTo` копирует байты через `docker cp`; `grep/list/listFiles` в
  rootless соблюдают `SKIP_DIRS`/dot-entries/include-exclude, как `fsWorkspace`.
- **Форма ленты переработана** (см. §3): запрос — вверху, один раз; вход открытого состояния —
  `ai(Start)` + `system(инструкция)` + `user(цель)`; `move.what` — непроверенная догадка на
  ходе `Goal:` состояния.
- **Добавлена per-island `instruction`** (`src/ir/islands.ts`) — «как действовать в
  состоянии», рендерится `system`-сообщением при входе.
  - Orientation: «исследуй репозиторий поиском, прочти документацию проекта (README, HACKING)…
    дефект не ищи, сбой не воспроизводи, с upstream не сверяйся».
- **Сверка с сиблингами работает**: в прогоне модель сама сопоставляет `pool_sweep` с
  `calc_pool_stats`/`pool_finalise`/`compact_update_pools`/`verify_pool` и находит расхождение
  `p += Whsize_hd(hd)` против `p += wh` (`runtime/shared_heap.c:650`). Дрейфа в `major_gc.c`
  на свежем прогоне нет.
- **Описание `stop` усилено** (`src/llm/tools.ts`): теперь оно ссылается на строку
  критерия в контексте и несёт «a strong suspicion is enough — do not verify to be sure».
- **Полный прогон до конца пути**: Patch (t6–t24; правка `p += Whsize_hd(hd)` → `p += wh` на
  t18–t24) → transition → Verification (t25+, начал `./configure`/`make`). Ответ везде верный.
- **Разобран промт opencode** (для сравнения): системный промт — общий, **без сценария**
  (ни `major`, ни `heap`, ни `sweep`); единственный источник задачи — запрос. opencode
  выигрывает не разметкой, а поведением: читает код широко и **сверяет «сестринские» циклы**,
  доводит до тестов; эталон ему не нужен (сеть off).
- **Reasoning на ленте (2026-10-17, дефолт).** Докса видит на ленте свои прошлые рассуждения:
  AI SDK (`@ai-sdk/openai-compatible`) round-trip'ит reasoning (`reasoning`/`reasoning_content`),
  движок журналит reasoning хода на узлах-действий (`payload.reasoning`), проекция показывает его
  на assistant-сообщении хода; вкл. по умолчанию, `SKEIN_REASONING_TAPE=false` — выключатель для
  A/B.
  Контролируемый A/B на полном цикле (`sandbox-run`, `--net off`, K=3–4): **момент закрытия
  состояния не меняется** (ON t14,15,14,11 / OFF t14,11,14), но reasoning ~2.5× меньше и
  стоимость ~40% ниже (добавленный контекст уходит в `cacheRead`, fresh-вход равен ≈49k).
  Детали — `docs/benches/best_bench_ru.md`, раздел «2026-10-17».
- **Возврат в Patch несёт неудачную попытку (2026-10-17).** `renderState`
  (`src/ir/project.ts`) для **текущего открытого** Patch вставляет `system` сразу после
  `ai: Start state …`: фактическую правку последнего `patch` (из `payload.call`) и модельный
  `stop.why` упавшей `verification` (literal, команда/exit/фактический текст); блок
  переформулирован ниже (reverted / different change). Раньше связь терялась: план закрытого
  состояния элидировался, оставались только `why` доксы.
  **Проверка без полного прогона** (по §2.3): записанный журнал прогона с циклом
  (`2026-10-17T08-04-06-897Z`) до повторного входа в Patch, на свежее дерево применена та
  же неудачная правка, три прохода Patch до `stop`. Контроль (без блока) повторно называл
  строку 644 и зацикливался; с блоком: **2/3 закрылись на верной строке** (`p += Whsize_hd(hd)`
  → `p += wh`, строки ~644–653/653), **1/3** не закрылась за 12 ходов, но и **не** подтвердила
  старую гипотезу (продолжала читать). Блок виден на ленте (`Previous failed attempt:`).
- **Транспорт — стриминг (2026-10-17, AI SDK).** `streamText` (on) против `generateText` (off)
  в `src/llm/structured.ts` (`callModel`); reasoning/usage из результата SDK;
  `SKEIN_STREAMING` (дефолт on). SSE-адаптер и `ChatOpenAI` не нужны. Подробности — §7 и
  `docs/plans/implementation_plan_ru.md`.
- **Literal Verification why + Verification→Patch + финальный батч (2026-10-17, сделано).**
  `stop.why` у Verification — literal error; `Previous failed attempt` в Patch;
  ребро `Verification → Patch` + revert на этом переходе; per-state hints. `fix-ocaml-gc --net on`,
  **5/5 reward=1**, 7.315₽; `docs/benches/best_bench_ru.md`.
- **Мета-провайдер: `tool_choice` больше не форсим (2026-10-17).** `required` уводил маршрут на
  thinking-апстримы, которые отвергали его или были под лимитом; opencode его тоже не ставит.
  Теперь AI SDK tools без `tool_choice`, а текстовый ответ вместо вызова чинит штатный
  один ремонт. Заодно: пустой `reasoning_content` отдаём обратно даже пустым (некоторые
  подрядчики требуют поле), а кросс-подрядчиковый mismatch «ход без reasoning → thinking»
  лечится одним повтором с выключенным thinking (`isReasoningContentRequired`).
- **Откат проваленного Patch + выход из Verification (2026-10-17).**
  - На переходе `Verification → Patch` по провалу движок откатывает последний Patch:
    событие `revert` (`src/ir/events.ts`), `State.reverted` и обновление версий в `fold`
    (`src/ir/graph.ts`), реализация — `src/ir/attempts.ts` (`isFailedVerificationMove`,
    `revertLastPatch`, `revertFailedPatch`). Хук — в `executeNode` (`src/loop/graph.ts`).
  - Блок `Previous failed attempt` теперь говорит, что правка откатана, показывает модельный
    literal `why` упавшей Verification и требует **другого** изменения, а не «look elsewhere».
    Он рендерится в открытом Patch.
  - В hint Verification: при провале acceptance — literal `why`; выбор `patch`, если координаты
    ещё верны; environment-ошибки — не `stop`, чинить и
    повторять; без отладки/правок в Verification.
  - Для replay добавлены `AgentInput.seed`/`startTurn` (`src/loop/graph.ts`), чтобы гонять
    `runAgent` с записанного журнала (см. §2.5).
  - Тесты: `tests/revert.test.ts` (откат, версии, блок, conflict, успешная Verification,
    интеграция через `runAgent`).
  - **K=3 на `08-04-06`:** циклов **0/3**; верная правка — 1/3 при streaming on (temp 0.1),
    2/3 при streaming off (temp 0.1), 2/3 при streaming off + temp 0. Неверный вариант —
    free-ветка с оставленным `Whsize_hd` для live-блоков — сохраняется. Вторая ошибка
    Verification (реальная сборка) даёт `stop` → Patch → `revert` без цикла.
  - Phase 1 откатывает только `edit`; `write`/`apply_patch` возвращают conflict (Phase 2).
  - **Финальный батч `fix-ocaml-gc --net on` (2026-10-17):** 5/5 `reward=1`, 29–50 ходов,
    7.315₽; run5 использовал `Verification → Patch` напрямую (один revert), остальные — прямой
    путь. Токены — `docs/benches/best_bench_ru.md`.

- **Patch: полное изменение (2026-10-29).** `Patch` больше не ограничивается найденным
  артефактом: `criterion` требует `the change is complete — the located artifact and every other
  file the task needs are created or updated`, `hint` — не откладывать обязательный файл до
  Verification; End получил «the finished state's check is the verification — do not re-verify».
  Live: `fix-code` K=3 — 3/3 `O → P → V → End`, 22–24 хода против 32, без `P → V → P` и
  `revert`; db-wal Patch-пакет — 20 ходов (15–20), `V → P` нет. Recovery-формулировки (consumer
  и утвердительная `matches what the material contains`) дали 22 хода медианы; в худшем прогоне
  остаётся пере-проверка WAL (6,8k reasoning) — словами это не лечится. Трассы:
  `bench/runs/matrix/2026-10-29-patchall-fix-code/`,
  `2026-10-29-patchall-db-wal/`, `2026-10-29-recovery-{consumer,affirmative}-db-wal/`.
- **Patch получает карту материала (2026-10-20).** *(Устарело 2026-11-04: Patch теперь и
  находит дефект, поэтому получает карту **плюс** пробу — `vcs, build, compilers,
  interpreters`.)* Patch больше не получает Probe с
  compilers/interpreters; вместо него — `Workspace` (`root`, `repo`, `entries`, `files`), как у
  Orientation. На записанной ленте t9 (Patch plan) dry-проекция даёт `repo: none` и
  `entries: ocaml/ (4623 files)`; live K=3 на этом же контексте — 3/3 сразу читают
  `runtime/shared_heap.c` (280-699), без git и без `ls`/широкого grep. Было: t9 `git status` +
  `git diff` (7.3k символов usage, 0.157₽) и t10 `ls` + `grep free_space/run/rle` (0.156₽);
  стало: 0.019–0.091₽ на первом ходе Patch.

### Проблемы (на завтра)

> Гипотеза п.1 **закрыта**: «позднее закрытие от того, что модель не видит свой вывод» —
> **не причина** (A/B по reasoning на ленте, см. «Сделано»; прежний baseline n=30 оказался
> артефактом гарнитуры: replay-харнесс (`bench/step.ts`, удалён) против полного цикла — см. §6). Значит, пере-вывод после
> находки (Patch в run1: t17–t21 перечитывал перед правкой) — disposition, а не отсутствие
> рассуждений на ленте. Отсюда и новые пункты ниже.

1. **Критерий не считается выполненным.** Модель **не игнорирует** критерий — она его
   цитирует (t14: «the state's criterion is just naming file(s) and coordinates»), но всё
   равно читает дальше: «назвал кандидата → а вдруг не тот → прочту ещё». Это воля к
   уверенности, а не отсутствие текста.
2. **Правки у точки `stop` не дают надёжного закрытия.** Усиленное описание `stop` — ~1/3
   закрытий на t16; дублирование «a strong suspicion…» внутрь критерия — хуже (тоже ~1/3, но
   шумнее). Т.е. дело, похоже, не в формулировке, а в disposition модели на позднем,
   раздутом ходу.
3. **Meta-сомнение (t25):** модель путается, что маркеры `ai: Start/Finish state` — это
   реплики движка, а не её собственные («did I actually apply a fix? … the tool calls so far
   were "move" declarations, not actual edits»). Возможный побочный эффект того, что вход
   состояния — `ai`-сообщение.
4. **Verification дорогой**: каждый ход переигрывает весь `seq` в свежем контейнере, поэтому
   `configure`/`make` в `seq` исполняется заново каждый ход.
5. **EN-зеркало и индекс** (`docs/README.md`) — сделано (`docs/state_testing.md`).
6. **Verification-ловушка: после провала сборки модель остаётся в Verification и жжёт бюджет
   (2026-10-17, главное).** Живые `--net on`, K=3: **1/3** reward=1 (40 ходов, верная правка
   хвоста `p += Whsize_hd(hd)` → `p += wh`); **2/3** — `max_turns`=60, транспортных
   `llm_error` нет. В обоих фейлах модель снова назвала **free-run строку**
   (`p += wh * Wosize_hd(hd)`), Patch правил её, хвост `p += Whsize_hd(hd)` остался → сборка
   падает с тем же segfault. Дальше модель **не закрывает Verification и не уходит в
   Patch**:
   - run `10-20-26`: `./configure`, затем **19× `make -j16`** (t29,33,36,39,42,44,46,48–59)
     вперемешку с чтением исходников; acceptance-команду так и не запустил;
   - run `10-33-08`: configure, make, gdb, valgrind, `runtime/ocamlrund`, и **правит файл через
     `bash`** (`python3`/`perl`) внутри Verification (write-инструменты там не предлагаются, но
     `bash` пишет).
   Блок «Previous failed attempt» тут не сработал **не потому, что плохой**: он показывается
   только при повторном входе в Patch, а возврата не было.
   **Сделано:** на провале acceptance хинт Verification требует literal `why` и выбор
   `Patch` (если координаты ещё верны); вторая ошибка (реальная сборка)
   проверена — модель останавливается, движок откатывает Patch. Осталось: (а) маскировка exit code (`make ...; echo $?`) — принципиальный
   фикс не в промте, а в engine-owned acceptance observation (команду запускает движок, модель
   не передаёт shell-строку); (б) после отката модель иногда выбирает вариант free-ветки вместо
   хвоста `p += wh` — это вопрос Patch-таргетинга, а не цикла.

## 6. Журнал экспериментов (не повторять)

- Правки `done`/`what` (line / area / files / «strong suspicion» / «with coordinates or not»)
  **остановкой не управляют**: доля стопа ≈ 0–1/3.
- Добавление в базовый промт строки opencode «think … based on the filenames directory
  structure» — **эффекта нет** (модель по-прежнему уходила к эталону `VERSION`/upstream).
- Копирование «a strong suspicion…» из хинта ещё и внутрь критерия — **не помогает** (~1/3).
- Текстовые «костыли» (вернуть B0/anti-diff) — отвергнуты как частное решение.
- **Сравнивать только в одной гарнитуре.** Baseline `run-loc-restart` (закрытие состояния
  n=30) против полного цикла дал ложный «выигрыш»: прежний replay-харнесс
  (`bench/step.ts`, удалён; переигрыш всего `seq` на каждый ход) и `sandbox-run`
  (инкрементальный цикл) несопоставимы по числу ходов. A/B — только
  меняя **один** фактор и в одном харнессе.
- **Per-file `signature` в контейнере (2026-10-23).** `signatureMap` до/после каждого `apply bash`
  вызывал `workspace.signature(path)` на каждый файл; в rootless Docker это `docker exec stat`
  на файл. На crack (2673 files) — ~5 минут на действие при idle-контейнере. Батчевый
  `Workspace.signatures()` (один `xargs stat`) устраняет это; не возвращать per-file exec.

## 7. Код и данные

- **Драйвер хода:** `bench/live-step.ts` (реальный движок, один ход на запуск; см. §2.3).
- **Оффлайн-переигрыш хода:** `bench/turn.ts` (по записанной ленте, без контейнера).
- **Контейнер:** `tests/sandbox/docker.ts` (`dockerWorkspace`, `rootless`; `signatures`).
- **Checkpoint:** `tests/sandbox/checkpoint.ts` (`CheckpointBackend`/`HostBackend`) и
  `tests/sandbox/checkpoint-docker.ts` (`DockerBackend`; store `/tmp/.skein`).
- **Приёмка:** `tests/sandbox/harness.ts` (`stageTestSh`, `runTask`: `test.sh` → `reward.txt`);
  сеть агента/verifier — `tests/sandbox/network.ts`.
- **Исполнение действий:** `src/tools/index.ts` (`executeAction`).
- **Откат проваленного Patch:** `src/ir/attempts.ts` (`isFailedVerificationMove`,
  `lastPatchBefore`, `revertLastPatch`, `revertFailedPatch`); событие `revert` —
  `src/ir/events.ts`; `State.reverted` и версии — `src/ir/graph.ts`; хук — `src/loop/graph.ts`
  (`executeNode`).
- **Replay с ленты:** `AgentInput.seed`/`startTurn` — `src/loop/graph.ts`; чеклист — §2.5.
- **Session probe:** `src/loop/probe.ts` (`probeSession`: environment + material),
  `src/loop/material.ts` (карта workspace: root/repo/entries/paths), `src/ir/environment.ts`
  (`EnvironmentFact`, подмножества), `src/ir/material.ts` (`MaterialFact`, `workspaceBrief`),
  `src/ir/session.ts` (`SESSION_PROBE_ID = "fact:session"`, `probeBrief` для environment);
  событие `add_node kind:"fact"` — `src/loop/graph.ts` (`runAgent`, `deps.probe`); рендер —
  `src/ir/project.ts` (`stateBrief`: Workspace/Orientation result/Probe).
- **Лента:** `src/ir/project.ts` (`project`), `src/loop/propose.ts` (`buildMessages`),
  инструкции — `src/loop/prompt/blocks.ts`, тексты островов — `src/ir/islands.ts`,
  описания инструментов — `src/llm/tools.ts`.
- **Записи:** `bench/runs/sandbox-tasks/` (пример полного пути — `run-loc-restart`,
  пример записи — `rec-orientation-182830`).
- **Reasoning через AI SDK:** `src/llm/client.ts` (`createOpenAICompatible`, `transformBody`),
  поле reasoning хода — `payload.reasoning` (`src/tools/index.ts`, `executeAction`), рендер —
  `src/ir/project.ts` (`renderPlan`), `src/loop/propose.ts` (reasoning part), возврат из
  ответа — `src/llm/structured.ts` (`invokeTools`). `SKEIN_REASONING_TAPE` (дефолт on);
  `provider.ts` удалён.
- **Транспорт — стриминг:** `streamText`/`generateText` — `src/llm/structured.ts` (`callModel`,
  `invokeWithRetry`); `SKEIN_STREAMING` (дефолт on, `src/config/settings.ts`).
  `SKEIN_REASONING_TAPE=false` — reasoning не попадает на ленту. SSE-парсера/`transformSse` нет.
- **Мета-провайдер (RouterAI) и подрядчики.** `tool_choice` **не форсим** (как opencode):
  `required` уводит маршрут на thinking-апстримы, которые либо отвергают его
  (`Thinking mode does not support this tool_choice`), либо под лимитом
  (`deepseek/deepseek-v4.1-flash-1017 is temporarily rate-limited upstream`). Это **не прокси и
  не движок**: наш клиент игнорирует `HTTP(S)_PROXY` (проверено с заведомо битым прокси), а тот
  же body без `tool_choice` проходит. Ещё один эффект маршрутизации: соседние ходы могут попасть
  к разным подрядчикам — один без reasoning, другой в thinking, и второй требует
  `reasoning_content`, которого не было (пустое поле тоже не принимает); fallback — один повтор
  с выключенным thinking (`isReasoningContentRequired`). Пустой `reasoning_content` для
  tool-turn всегда отдаём обратно (`transformBody`).

## 8. Следующие шаги

- **Закрыто:** «reasoning не на ленте → позднее закрытие» (дефолт, A/B — `docs/benches/best_bench_ru.md`, 2026-10-17).
- **Сделано:** стриминг-транспорт; возврат в Patch с последней неудачной попыткой;
  провайдерская совместимость (нет `tool_choice`, пустой `reasoning_content`, thinking-off
  fallback, transition-инструкция как `system`); откат проваленного Patch на
  `Verification → Patch`; failure-stop в Verification; `seed`/`startTurn` для replay —
  см. §5, §7.
- **Живой статус (2026-10-17).** `fix-ocaml-gc --net on`, K=3 до фикса: транспорт 3/3 без
  `llm_error`, reward 1/3 (фейлы — `max_turns`=60 из-за Verification-ловушки). После фикса
  отката/стопа: **циклов 0/3**; верная правка 1/3 (streaming on, temp 0.1), 2/3 (streaming
  off, temp 0.1) и 2/3 (streaming off, temp 0). Вторая ошибка Verification (реальная сборка)
  даёт `stop` → Patch → `revert`.
- **Осталось исследовать** (на `fix-ocaml-gc`, K≥3, в **одной** гарнитуре — §6):
  1. **Правильность Patch, не цикл.** После отката модель иногда выбирает вариант free-ветки
     (`p += wh*(Wosize+1)` с оставленным `Whsize_hd` для live-блоков) вместо хвоста
     `p += wh`. Это не зацикливание: Verification теперь закрывается и откатывает. Нужен
     Patch-таргетинг: блок `Previous failed attempt` теперь показывается и в открытом Patch;
     осталось требовать изменения, а не перестановки тех же строк.
  2. **Exit-code masking.** Модель маскирует статус (`make ...; echo $?`, `|| true`), и
     `lastFailingRun` может не увидеть провал. Принципиальный фикс — engine-owned acceptance
     observation: команду запускает движок, модель не передаёт shell-строку; промт-строки и
     guard'ы отвергнуты как костыли.
  3. **Phase 2 отката.** `write`/`apply_patch` пока дают `revert_conflict`; нужен preimage
     (`write`) и reverse patch (`apply_patch`), all-or-nothing.
  4. **Харнесс.** Временный replay-цикл (`seed` + контейнер + reverse diff) перенести в
     `bench/` как штатный инструмент; чеклист — §2.5.
  5. **Shell-гигиена: cwd (исправлено 2026-10-24).** Карта workspace теперь несёт `cwd`, если
     shell стартует вне material root (task `workdir`). `git status` в probe больше не считает
     служебный `.skein` изменённым файлом и запускается с `GIT_OPTIONAL_LOCKS=0`, поэтому не
     перезаписывает `.git/index`.
  6. **Meta-сомнение** (§5 п.3): не мешает ли `ai`-маркер `Start/Finish state`.
  7. Тексты состояний Patch/Verification — `docs/states_ru.md` §2.4, §2.7.
- **Orientation result vs probe (2026-10-20).** Один `fact:session` (`environment` + `material`)
  пишется на старте запроса. `material` — карта workspace: `root`, repo-статус, top-level
  entries (для маленьких материалов — paths), число файлов; без конфигов, команд сборки,
  расширений и build state. Orientation показывает её как `Workspace`; Patch и Research
  получают ту же карту как `Orientation result` плюс `Probe` (environment) отдельным
  заголовком; остальные состояния получают только `Probe`. Цель Orientation
  сужена до входов и acceptance из запроса; если карта и запрос уже всё называют, первый же
  шаг может быть `stop`.
- **Orientation на 13 задачах (2026-10-20, minimal).** Живой прогон на реальных образах: **13/13
  закрыли Orientation за 3 хода** (request → `stop` → transition; один `password` — 4), без
  исследования материала, `max_turns`, `llm_error` или отказов. `fix-ocaml-gc`: 3 хода, ~6.4k
  входных токенов, 0.065₽ против 6 ходов / 25.9k / 0.166₽ в прежней схеме. K=3 маршрутов:
  password/cobol → Research, custom-memory/fix-git → Patch, git-leak → Research (3/3).
  Осталось: environment для других состояний, `.skein` виден shell’у, staleness probe после
  установок/правок.
- **Полный fix-ocaml-gc (2026-10-20, live).** reward=1,
  `stop=request_addressed`, **34 хода, 4.24₽**: Orientation 3/0.29,
  **Research 5/1.00 (лишний шаг)**, Patch 10/1.22, Verification 8/0.79, End 1/0.10. Точная
  правка `p += wh` верная. Остаток разрыва с 29 ходами/1.684₽ — лишний Research: для code defect
  надо идти в Patch, Research оставить для ситуаций/новых артефактов.
