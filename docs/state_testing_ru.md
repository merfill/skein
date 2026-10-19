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

## 0. Цель

Добиться, чтобы на каждом состоянии агент:
- делал **работу состояния** (а не работу соседнего),
- **закрывал** состояние (`stop`) по своему критерию — без дрейфа и без «судьи»-эталона,
- не **затягивал** (не пере-выводил уже добытое).

Мерим по ходам: в каком состоянии закрылся или куда ушёл; объём `reasoning`; содержание
`why`. Модель — `routerai/~deepseek/deepseek-v4-flash-latest`, `SKEIN_TEMPERATURE=0.1`
(**шумно**: по одному сэмплу вывод не делать, смотреть `K≥3`).

## 1. Два инструмента

1. **Живой ход за ходом** — `bench/step.ts` (в репозитории). Один запуск = один ход движка:
   переигрывает накопленную последовательность действий в контейнере задачи, строит ленту и
   делает **один** вызов модели. Это повседневный инструмент: идём по состояниям, после
   каждого хода смотрим результат и правим промт.
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
- Дерево `WORKDIR` образа один раз выгружается в **временный корень на хосте** (tar-пайп,
  чтобы владельцем стал пользователь хоста, а не root образа).
- Затем поднимается **долгоживущий контейнер**:
  `docker run -d --entrypoint sleep -v <root>:/app --network none -w /app <image> infinity`.
  Флаг `--network none` (по умолчанию) держит агента **оффлайн**.
- Команды идут через `docker exec` **в этот же контейнер**, так что все шаги видят одно дерево.
- Файловые инструменты (`read`/`grep`/`list`/`edit`/`write`) работают с **тем же** деревом
  через `fsWorkspace` (bind-mount), поэтому правки «видны» и хосту, и контейнеру.
- Уборка — `cleanupContainers()` (изнутри контейнера стирает mount, затем `docker rm`).

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

`bench/step.ts` — «один ход на запуск»:

```
TAPE_DIR=<dir> npx tsx bench/step.ts <task-id> <seq.json>
```

- читает `seq.json` — массив `{ turn, action }` (накопленные действия прошлых ходов);
- `materializeTask(task)` даёт `{ root, request }`; поднимает `dockerWorkspace`;
- засевает журнал узлом-запросом и **переигрывает `seq`** через `executeAction` (команды
  исполняются в контейнере);
- `project` + `buildMessages` строит ленту, `propose` делает **один** вызов модели;
- пишет результат (см. §2.4).

Цикл работы: запустили → взяли `next-actions.json` → дописали действия в `seq.json` следующим
`turn` → запустили снова. Так и «идём по ходам», останавливаясь после каждого.

> Замечание по стоимости: каждый запуск заново переигрывает **весь** `seq` в свежем
> контейнере. Если в `seq` есть `./configure`/`make`, сборка исполняется на каждом ходу —
> ходы становятся медленными и дорогими (видели на Verification).

### 2.4 Куда пишется лента

Каталог — `TAPE_DIR` (по умолчанию `bench/runs/sandbox-tasks/<task>-step`):

- `contexts/tNNN.txt` — **читаемая лента** хода (ровно то, что ушло модели);
- `turns.ndjson` — по ходу: `{ turn, situation, island, actions, reasoning }`;
- `next-actions.json` — предложение модели (действия следующего хода).

Живые прогоны целиком лежат в `bench/runs/sandbox-tasks/<ts>-<name>/`. Примеры: полный
прогон `run-loc-restart` (Localization → Patch → Verification), записанный пример
`rec-orientation-182830` (Orientation t0–t4 с рассуждениями).

### 2.5 Replay с записанной ленты (как гонять один ход)

`bench/step.ts` переигрывает `seq` с нуля. Если проверяешь **переходы движка** (`stop`/`move`,
откат неверного Patch), нужен replay **ленты через `runAgent`**, иначе хук в `executeNode`
обходится. Для этого у `AgentInput` есть `seed` (готовый журнал) и `startTurn` (номер хода);
`maxTurns` остаётся абсолютным.

Чеклист:

1. **Выбери run и точку входа.**
   - второй вход в Localization — fold до `descend` после `move` (состояние
     `plan / localization`);
   - провал Verification (transition) — до `stop`-edge закрытой Verification;
   - рабочая Verification после провала — до `result`-edge упавшего `bash`.
2. **Приведи дерево к сиду.** Подними `dockerWorkspace` для `fix-ocaml-gc`; примени/откати
   записанный `edit` (или `write`/`apply_patch`) так, чтобы файл соответствовал событиям.
   Затем добавь в сид синтетический `mutate` с фактической версией файла (`workspace.version`).
   Без этого IR и дерево расходятся, и следующий `edit` получает `stale_base`.
3. **Запусти `runAgent({ propose, workspace, maxTurns }, { request, seed, startTurn })`.**
   Не делай ручной цикл `propose`: переходы и откат живут в `executeNode`.
4. **Поставь sentinel в `propose`.** Остановись, когда `context.island` достиг целевого
   (например, `localization` после отката или `verification` перед сборкой) — так один прогон
   не уходит в дорогой build.
5. **Пиши `contexts/tNNN.txt`, `turns.ndjson`, `journal.ndjson`.** Смотри `reasoning`,
   действия, `stop why`, `revert`; контекст — ровно то, что ушло модели.
6. **K≥3 и один фактор за раз.** `SKEIN_STREAMING`, `SKEIN_TEMPERATURE` и правки промта —
   отдельными плечами; иначе вывод будет не про тот фактор.

Что ожидать после текущего фикса:

- Verification провалилась → `stop` → `move` в Patch или Localization (модель выбирает; Patch, если
  координаты ещё верны) → движок пишет `revert` последнего
  Patch: файл возвращается к pre-patch, версии в IR обновляются;
- в открытой Localization блок говорит `This change has been reverted…` и
  `A different change is required…`;
- Patch применяет **другой** diff, а не вариант откатанного;
- вторая ошибка Verification снова даёт `stop` → Localization → revert, без отладки и правок
  внутри Verification.

## 3. Как формируется лента (что затирается, что добавляется)

Лента строится `project` (`src/ir/project.ts`) и `buildMessages`
(`src/loop/propose.ts`) из IR **каждый ход заново** (детерминированно: одни события → один
`Context`). Ничего не «копится» само: источник — журнал событий, лента — его проекция.

Общий скелет одного хода:

```
system   — базовый промт (States + Transitions + строка про имена файлов)   [всегда]
system…  — ограничения (constraints), если есть                              [по необходимости]
user     — ЗАПРОС пользователя                                              [всегда, один раз]
user     — ENVIRONMENT BRIEF (сессионный факт, подмножество по острову)      [если есть]
… состояния (дети запроса) в порядке появления …
system   — инструкция текущей ситуации (plan/working/transition/terminal)   [всегда]
```

**Запрос** показывается **один раз, вторым сообщением** (сразу после базового промта) — и так
на **каждом** ходу, чтобы задача была видна и внутри состояния.

**Environment brief** — `user`-сообщение сразу после запроса (Markdown), собранное из события
`add_node kind:"fact"`: один детерминированный зонд на старте запроса (`src/loop/probe.ts`)
пишет среду, проекция выбирает подмножество по текущему острову (Orientation —
root/vcs/build/interpreters/pkg; Research — interpreters/tools; Recovery —
root+interpreters/tools). Полный вывод зонда на ленту не попадает; replay читает записанный
факт, а не запускает зонд.

**Вход в состояние** (показывается для каждого состояния):

```
ai       — Start state <Label>
system   — <инструкция острова: как действовать в этом состоянии>
user     — what: <цель острова (island.what)>
```

**Возврат в Localization или Patch после провала** (только текущее открытое состояние): сразу
после `ai: Start state Localization`/`Start state Patch` идёт ещё одно `system` — **последняя**
неудачная попытка, собранная логосом из журнала:

```
system — Previous failed attempt:
           Patch: runtime/shared_heap.c
             <фактический find из edit>
             ->
             <фактический replace>
           Verification: <буквальный пересказ ошибки: команда, exit, фактический текст>
           This change has been reverted in the workspace; the tree is back to its pre-patch state.
           Do not repeat this change. A different change is required; it may be in the same file or even the same loop.
```

Источник — `payload.call` правки и `stop.why` доксы у упавшей `verification`: буквальный
пересказ ошибки (команда, exit, фактический текст), а не диагноз кода и не механический
последний упавший `bash` с хвостом. Только последняя попытка; более ранние уже в ленте. Если
Patch не менял файл — `Patch: no file changed.`

Откат делает движок на переходе `Verification → Patch/Localization` по провалу: он пишет событие
`revert` (файлы + новые версии) и возвращает дерево к pre-patch. Блок рендерится для
**текущей открытой** Localization или Patch. Если откат невозможен (например, `write`/`apply_patch` без
preimage в Phase 1), блок говорит `The failed change is still in the workspace.` — не
притворяйся, что оно откатано.

**Открытое состояние** — после этого идут шаги плана: каждый ход доксы — пара
`ai(tool_calls=[…])` + по одному `tool(результат)` на вызов.

**Закрытое состояние** — план **элидируется**: остаются только

```
ai — Start state <Label>
system — <инструкция>
user — what: <цель>
ai — Finish state <Label> — <why из stop>
```

**Инструкция ситуации** (в хвосте, `system`):

| ситуация | что добавляется |
|---|---|
| `request` | `REQUEST_INSTRUCTION` — выбрать стартовое состояние (`move`) или `decline` |
| `plan` | «Call a tool — the action that advances the goal above.» |
| `working` | `turnInstruction` — критерий состояния + «когда он выполнен, `stop`; подозрения достаточно…» |
| `transition` | `transitionInstruction` — прочитать строку `Finish`, выбрать следующее состояние |
| `terminal` | «This is Finish. Call `stop` now…» |

**Что затирается (не показывается):**
- `notes` из `move` — не рендерятся;
- `what` из `move` — не рендерится (цель берётся из определения острова);
- **план закрытого состояния** — все пары `ai`/`tool` заменяются одной строкой `Finish`.

**Что добавляется:**
- запрос — вверху, один раз;
- вход состояния — `ai(Start)` + `system(инструкция)` + `user(what)`;
- хвост-инструкция ситуации;
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

- **Форма ленты переработана** (см. §3): запрос — вверху, один раз; вход состояния —
  `ai(Start)` + `system(инструкция)` + `user(what)`; `notes`/`move.what` не показываются.
- **Добавлена per-island `instruction`** (`src/ir/islands.ts`) — «как действовать в
  состоянии», рендерится `system`-сообщением при входе.
  - Orientation: «исследуй репозиторий поиском, прочти документацию проекта (README, HACKING)…
    дефект не ищи, сбой не воспроизводи, с upstream не сверяйся».
  - Localization: «прочти подозрительный код и **сверь его с сиблингами** — другими обходами
    той же структуры (тех же пулов/хипа); расхождение в шаге/кодировке — сигнал. Назови
    файл(ы) и строки. Дефект не доказывай, правку не применяй, с upstream не сверяйся».
- **Сверка с сиблингами работает**: в прогоне модель сама сопоставляет `pool_sweep` с
  `calc_pool_stats`/`pool_finalise`/`compact_update_pools`/`verify_pool` и находит расхождение
  `p += Whsize_hd(hd)` против `p += wh` (`runtime/shared_heap.c:650`). Дрейфа в `major_gc.c`
  на свежем прогоне Localization нет.
- **Описание `stop` усилено** (`src/llm/tools.ts`): теперь оно ссылается на строку
  критерия в контексте и несёт «a strong suspicion is enough — do not verify to be sure».
- **Полный прогон до конца пути**: Localization (t6–t17) → transition → Patch
  (`edit`: `p += Whsize_hd(hd)` → `p += wh`, t18–t24) → transition → Verification (t25+,
  начал `./configure`/`make`). Ответ везде верный.
- **Разобран промт opencode** (для сравнения): системный промт — общий, **без сценария**
  (ни `major`, ни `heap`, ни `sweep`); единственный источник задачи — запрос. opencode
  выигрывает не разметкой, а поведением: читает код широко и **сверяет «сестринские» циклы**,
  доводит до тестов; эталон ему не нужен (сеть off).
- **Reasoning на ленте (2026-10-17, дефолт).** Докса видит на ленте свои прошлые рассуждения:
  AI SDK (`@ai-sdk/openai-compatible`) round-trip'ит reasoning (`reasoning`/`reasoning_content`), движок
  журналит reasoning хода на узлах-действий (`payload.reasoning`), проекция показывает его на
  assistant-сообщении хода; вкл. по умолчанию, `SKEIN_REASONING_TAPE=false` — выключатель для A/B.
  Контролируемый A/B на полном цикле (`sandbox-run`, `--net off`, K=3–4): **момент закрытия
  локализации не меняется** (ON t14,15,14,11 / OFF t14,11,14), но reasoning ~2.5× меньше и
  стоимость ~40% ниже (добавленный контекст уходит в `cacheRead`, fresh-вход равен ≈49k).
  Детали — `docs/benches/best_bench_ru.md`, раздел «2026-10-17».
- **Возврат в Localization/Patch несёт неудачную попытку (2026-10-17).** `renderState`
  (`src/ir/project.ts`) для **текущих открытых** Localization и Patch вставляет `system` сразу после
  `ai: Start state …`: фактическую правку последнего `patch` (из `payload.call`) и модельный
  `stop.why` упавшей `verification` (literal, команда/exit/фактический текст); блок
  переформулирован ниже (reverted / different change). Раньше связь терялась: план закрытого
  состояния элидировался, оставались только `why` доксы.
  **Проверка без полного прогона** (по §2.3): записанный журнал прогона с циклом
  (`2026-10-17T08-04-06-897Z`) до повторного входа в Localization, на свежее дерево применена та
  же неудачная правка, три прохода Localization до `stop`. Контроль (без блока) повторно называл
  строку 644 и зацикливался; с блоком: **2/3 закрылись на верной строке** (`p += Whsize_hd(hd)`
  → `p += wh`, строки ~644–653/653), **1/3** не закрылась за 12 ходов, но и **не** подтвердила
  старую гипотезу (продолжала читать). Блок виден на ленте (`Previous failed attempt:`).
- **Транспорт — стриминг (2026-10-17, AI SDK).** `streamText` (on) против `generateText` (off)
  в `src/llm/structured.ts` (`callModel`); reasoning/usage из результата SDK;
  `SKEIN_STREAMING` (дефолт on). SSE-адаптер и `ChatOpenAI` не нужны. Подробности — §7 и
  `docs/plans/implementation_plan_ru.md`.
- **Literal Verification why + Verification→Patch + финальный батч (2026-10-17, сделано).**
  `stop.why` у Verification — literal error; `Previous failed attempt` в Localization и Patch;
  ребро `Verification → Patch` + revert на оба перехода; per-state hints. `fix-ocaml-gc --net on`,
  **5/5 reward=1**, 7.315₽; `docs/benches/best_bench_ru.md`.
- **Мета-провайдер: `tool_choice` больше не форсим (2026-10-17).** `required` уводил маршрут на
  thinking-апстримы, которые отвергали его или были под лимитом; opencode его тоже не ставит.
  Теперь AI SDK tools без `tool_choice`, а текстовый ответ вместо вызова чинит штатный
  один ремонт. Заодно: пустой `reasoning_content` отдаём обратно даже пустым (некоторые
  подрядчики требуют поле), а кросс-подрядчиковый mismatch «ход без reasoning → thinking»
  лечится одним повтором с выключенным thinking (`isReasoningContentRequired`).
- **Откат проваленного Patch + выход из Verification (2026-10-17).**
  - На переходе `Verification → Patch/Localization` по провалу движок откатывает последний Patch:
    событие `revert` (`src/ir/events.ts`), `State.reverted` и обновление версий в `fold`
    (`src/ir/graph.ts`), реализация — `src/ir/attempts.ts` (`isFailedVerificationMove`,
    `revertLastPatch`, `revertFailedPatch`). Хук — в `executeNode` (`src/loop/graph.ts`).
  - Блок `Previous failed attempt` теперь говорит, что правка откатана, показывает модельный
    literal `why` упавшей Verification и требует **другого** изменения, а не «look elsewhere».
    Он рендерится в открытых Localization и Patch.
  - В hint Verification: при провале acceptance — literal `why`; выбор `patch`, если координаты
    Localization ещё верны, иначе `localization`; environment-ошибки — не `stop`, чинить и
    повторять; без отладки/правок в Verification.
  - Для replay добавлены `AgentInput.seed`/`startTurn` (`src/loop/graph.ts`), чтобы гонять
    `runAgent` с записанного журнала (см. §2.5).
  - Тесты: `tests/revert.test.ts` (откат, версии, блок, conflict, успешная Verification,
    интеграция через `runAgent`).
  - **K=3 на `08-04-06`:** циклов **0/3**; верная правка — 1/3 при streaming on (temp 0.1),
    2/3 при streaming off (temp 0.1), 2/3 при streaming off + temp 0. Неверный вариант —
    free-ветка с оставленным `Whsize_hd` для live-блоков — сохраняется. Вторая ошибка
    Verification (реальная сборка) даёт `stop` → Localization → `revert` без цикла.
  - Phase 1 откатывает только `edit`; `write`/`apply_patch` возвращают conflict (Phase 2).
  - **Финальный батч `fix-ocaml-gc --net on` (2026-10-17):** 5/5 `reward=1`, 29–50 ходов,
    7.315₽; run5 использовал `Verification → Patch` напрямую (один revert), остальные — прямой
    путь. Токены — `docs/benches/best_bench_ru.md`.

### Проблемы (на завтра)

> Гипотеза п.1–2 **закрыта**: «позднее закрытие от того, что модель не видит свой вывод» —
> **не причина** (A/B по reasoning на ленте, см. «Сделано»; прежний baseline n=30 оказался
> артефактом гарнитуры `bench/step.ts` vs полный цикл — см. §6). Значит, пере-вывод после
> находки (Patch в run1: t17–t21 перечитывал перед правкой) — disposition, а не отсутствие
> рассуждений на ленте. Отсюда и новые пункты ниже.

1. **Localization закрывается поздно**: ответ на руках с ~t10–t14, а `stop` — на t17;
   reasoning раздувается (1.5k–8.8k), модель пере-выводит уже добытое.
2. **Критерий не считается выполненным.** Модель **не игнорирует** критерий — она его
   цитирует (t14: «the state's criterion is just naming file(s) and coordinates»), но всё
   равно читает дальше: «назвал кандидата → а вдруг не тот → прочту ещё». Это воля к
   уверенности, а не отсутствие текста.
3. **Правки у точки `stop` не дают надёжного закрытия.** Усиленное описание `stop` — ~1/3
   закрытий на t16; дублирование «a strong suspicion…» внутрь критерия — хуже (тоже ~1/3, но
   шумнее). Т.е. дело, похоже, не в формулировке, а в disposition модели на позднем,
   раздутом ходу.
4. **Meta-сомнение (t25):** модель путается, что маркеры `ai: Start/Finish state` — это
   реплики движка, а не её собственные («did I actually apply a fix? … the tool calls so far
   were "move" declarations, not actual edits»). Возможный побочный эффект того, что вход
   состояния — `ai`-сообщение.
5. **Verification дорогой**: каждый ход переигрывает весь `seq` в свежем контейнере, поэтому
   `configure`/`make` в `seq` исполняется заново каждый ход.
6. **EN-зеркало и индекс** (`docs/README.md`) — сделано (`docs/state_testing.md`).
7. **Verification-ловушка: после провала сборки модель остаётся в Verification и жжёт бюджет
   (2026-10-17, главное).** Живые `--net on`, K=3: **1/3** reward=1 (40 ходов, верная правка
   хвоста `p += Whsize_hd(hd)` → `p += wh`); **2/3** — `max_turns`=60, транспортных
   `llm_error` нет. В обоих фейлах локализация снова назвала **free-run строку**
   (`p += wh * Wosize_hd(hd)`), Patch правил её, хвост `p += Whsize_hd(hd)` остался → сборка
   падает с тем же segfault. Дальше модель **не закрывает Verification и не уходит в
   Localization**:
   - run `10-20-26`: `./configure`, затем **19× `make -j16`** (t29,33,36,39,42,44,46,48–59)
     вперемешку с чтением исходников; acceptance-команду так и не запустил;
   - run `10-33-08`: configure, make, gdb, valgrind, `runtime/ocamlrund`, и **правит файл через
     `bash`** (`python3`/`perl`) внутри Verification (write-инструменты там не предлагаются, но
     `bash` пишет).
   Блок «Previous failed attempt» тут не сработал **не потому, что плохой**: он показывается
   только при повторном входе в Localization, а возврата не было.
   **Сделано:** на провале acceptance хинт Verification требует literal `why` и выбор
   `Patch`/`Localization` (Patch, если координаты ещё верны); вторая ошибка (реальная сборка)
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
- **Сравнивать только в одной гарнитуре.** Baseline `run-loc-restart` (закрытие локализации
  n=30) против полного цикла дал ложный «выигрыш»: `bench/step.ts` (переигрыш всего `seq` на
  каждый ход) и `sandbox-run` (инкрементальный цикл) несопоставимы по числу ходов. A/B — только
  меняя **один** фактор и в одном харнессе.

## 7. Код и данные

- **Драйвер хода:** `bench/step.ts` (один ход: переигрыш `seq` в контейнере + один `propose`).
- **Оффлайн-переигрыш хода:** `bench/turn.ts` (по записанной ленте, без контейнера).
- **Контейнер:** `tests/sandbox/docker.ts` (`dockerWorkspace`).
- **Исполнение действий:** `src/tools/index.ts` (`executeAction`).
- **Откат проваленного Patch:** `src/ir/attempts.ts` (`isFailedVerificationMove`,
  `lastPatchBefore`, `revertLastPatch`, `revertFailedPatch`); событие `revert` —
  `src/ir/events.ts`; `State.reverted` и версии — `src/ir/graph.ts`; хук — `src/loop/graph.ts`
  (`executeNode`).
- **Replay с ленты:** `AgentInput.seed`/`startTurn` — `src/loop/graph.ts`; чеклист — §2.5.
- **Session fact / environment probe:** `src/loop/probe.ts` (`probeEnvironment`),
  `src/ir/environment.ts` (`EnvironmentFact`, подмножества и Markdown-бриф), событие
  `add_node kind:"fact"` — `src/loop/graph.ts` (`runAgent`, `deps.probe`); в шаговом харнессе
  факт добавляет `bench/step.ts` (иначе лента расходится с движком).
- **Лента:** `src/ir/project.ts` (`project`), `src/loop/propose.ts` (`buildMessages`),
  инструкции — `src/loop/prompt/blocks.ts`, тексты островов — `src/ir/islands.ts`,
  описания инструментов — `src/llm/tools.ts`.
- **Записи:** `bench/runs/sandbox-tasks/` (пример полного пути — `run-loc-restart`,
  пример записи — `rec-orientation-182830`).
- **Reasoning через AI SDK:** `src/llm/client.ts` (`createOpenAICompatible`, `transformBody`),
  поле reasoning хода — `payload.reasoning` (`src/tools/index.ts`, `executeAction`), рендер —
  `src/ir/project.ts` (`renderPlan`), `src/loop/propose.ts` (reasoning part), возврат из
  ответа — `src/llm/structured.ts` (`invokeTools`). `SKEIN_REASONING_TAPE`; `provider.ts` удалён.
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
- **Сделано:** стриминг-транспорт; возврат в Localization с последней неудачной попыткой;
  провайдерская совместимость (нет `tool_choice`, пустой `reasoning_content`, thinking-off
  fallback, transition-инструкция как `user`); откат проваленного Patch на
  `Verification → Patch/Localization`; failure-stop в Verification; `seed`/`startTurn` для replay —
  см. §5, §7.
- **Живой статус (2026-10-17).** `fix-ocaml-gc --net on`, K=3 до фикса: транспорт 3/3 без
  `llm_error`, reward 1/3 (фейлы — `max_turns`=60 из-за Verification-ловушки). После фикса
  отката/стопа: **циклов 0/3**; верная правка 1/3 (streaming on, temp 0.1), 2/3 (streaming
  off, temp 0.1) и 2/3 (streaming off, temp 0). Вторая ошибка Verification (реальная сборка)
  даёт `stop` → Localization → `revert`.
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
  5. **Shell-гигиена: cwd.** `bash` стартует из workspace root (`/app`), а репо — в `/app/ocaml`;
     общий фикс — показывать cwd в наблюдении `bash` или различать workspace/repo root.
  6. **Meta-сомнение** (§5 п.4): не мешает ли `ai`-маркер `Start/Finish state`.
  7. Тексты состояний Patch/Verification (`docs/states_ru.md` §2.3–2.5 пусты).
