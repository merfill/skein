# Handoff — Tier 4: RequestObserver и сессия

> Рабочий документ передачи. Английского зеркала нет.
> Отправная точка — `docs/session_concepts.md`/`_ru.md`, `docs/plans/tui_plan*` и планы
> `docs/plans/session_{agent,driver,interrupt}_plan*`.

## 2026-11-07 — Provider layer (уровень 0), maxTurns 80

- **maxTurns по умолчанию 80**: `settings`, CLI (и интерактивная задача), sandbox/bench,
  `.env.example`, `docs/testing.md`, README.
- **Каталог провайдеров** (`src/providers/presets.ts`): RouterAI, OpenRouter, Google AI Studio,
  Groq, Cerebras, Mistral, GitHub Models, DeepSeek, OpenAI, Ollama, LM Studio, vLLM, Custom.
  Только OpenAI-compatible; нативные Anthropic/Google и models.dev — после 1.0.
- **Файлы**: `~/.config/skein/config.json` (provider/model/baseURL, без секретов) и
  `~/.local/share/skein/auth.json` (ключи, 0600); override `SKEIN_CONFIG_DIR`/`SKEIN_DATA_DIR`.
  Приоритет: CLI → env → config → preset. Старые `SKEIN_API_URL`/`SKEIN_API_KEY`/`SKEIN_MODEL`
  работают; `SKEIN_API_URL` без `SKEIN_PROVIDER` = `custom`.
- **CLI**: `auth login/list/logout`, `models`, `doctor`, `--provider/--model/--base-url`,
  `--help/--version`. Первый запуск без конфига предлагает локальные рантаймы и free-tier.
- **TUI**: `/model` — список моделей, `/model <id>` — переключение на лету (со следующего хода,
  с записью в конфиг).
- **Совместимость**: `transformBody` добавляет reasoning только для routerai/openrouter/deepseek;
  остальным тело не трогаем, чтобы не ломать OpenAI/Groq/локальные.
- **Тесты**: `providers_config`, `providers_probe`, `providers_auth` (mock fetch, без живых
  вызовов). Офлайн **630 passed / 40 skipped**, typecheck чистый.
- **Доки**: `docs/providers.md` + `_ru`, README, `.env.example`.

## 2026-11-07 — Esc: пауза, выход в сессию, отмена

- **Esc — пауза, не IR-операция.** Модельный вызов абортится, выполняющийся tool доходит до
  конца, committed turns — точка возобновления. В журнал задачи ничего не пишется.
- **Меню паузы** (`renderPauseMenu`): `[r] resume`, `[s] session`, `[c] cancel & roll back`,
  `[q] quit`; для session-unit'а — `[r] resume`, `[c] discard`, `[q] quit`. Произвольная строка
  в REPL больше не отменяет задачу неявно.
- **Leave (`s`)** — `leaveTurn`: снимает фокус (наблюдателя, затем задачу), работа сохраняется,
  в журнал unit'а ничего не пишется; статус производный `suspended`. Следующая реплика уходит
  агенту сессии. Read-only general при выходе восстанавливает случайные изменения.
- **Cancel (`c`)** — `cancelTurn`: откат к снапшоту входа + `rollback`-факт, unit помечается
  `abandoned` (возобновлять нельзя). Для наблюдателя помечаются оба unit'а.
- **Телеметрия:** новое событие `leave`, `SessionSummary.left`.
- **Тесты:** `tests/session_pause.test.ts` — leave сохраняет файл и даёт `suspended`, cancel даёт
  `abandoned`, REPL по `s` уходит в session. Offline: **607 passed / 40 skipped**, typecheck чистый.
- **Доки:** `session_concepts`/`_ru` §3.

## 2026-11-07 — End-инструкция, снос Orientation/Recovery, `R→V` добавлен и убран, error-closure, короткие задачи

- **End получил инструкцию.** `terminalInstruction` (`src/loop/prompt/blocks.ts`) рендерит
  `This is End.` + `ISLANDS.end.instruction`; `buildMessages` добавляет её `system`-ходом для
  `situation === "terminal"`. Инструментов на End по-прежнему `[]`, текст уходит в `stop.why`.
  Первый живой замер — `fix-code-vulnerability` K=3 net off: **3/3 reward=1**, 30/17/17 ходов,
  1.793/0.820/0.823₽; End-отчёты 1.0–2.1k символов. У всех 3 в End-контексте ровно одна
  terminal-инструкция.
- **`Orientation` и `Recovery` удалены совсем** (не legacy): `ISLAND_IDS` — пять состояний
  (`research`, `patch`, `construction`, `verification`, `end`); `ISLANDS`, `briefs`,
  `environment`, `tools`, `graph`, тесты и доки синхронизированы. `LIVE_ISLAND_IDS` — алиас
  `ISLAND_IDS`.
- **Переходный промпт переписан.** Состояния рендерятся из `next[].when`, а не из
  `island.what`; `transitionRule`/`START_RULE`/`renderStates` удалены. Шапка:
  `The engine recorded this state's result on the \`Finish state X — …\` line above.` Затем
  `Choose exactly one next state:` и условия; хвост — `move` + `what`. Это снимает
  двусмысленность «Patch — find the defect…», которую модель читала как условие перехода.
- **`Research → Verification` добавляли и убрали.** Добавили из-за `fix-git` (Research делает
  merge, нужна проверка), но `password-recovery` показал, что это категориальная ошибка:
  результата-изменения нет, Verification нечего делать, и она уходит в цикл перепроверок
  (28–30 ходов, 1.88–2.25₽). Итог: Verification — только после Patch; `research.next` =
  `End`, `Patch`; условие End — «результат есть в объявленной форме и совпадает с материалом
  или запросом».
- **Error-closure.** `llm_error` больше не обрывает ленту: движок пишет engine-owned `stop`
  открытому состоянию (`payload.error: true`), делает engine-owned `move` в End и один раз
  просит модель об отчёте (fallback из `Finish`-строк, если и этот вызов упал). `stopReason`
  остаётся `llm_error`; End-`stop` помечен `error`, поэтому сессия выводит `abandoned`, а не
  `completed`. Тесты: `tests/error_closure.test.ts`, `tests/session_attention.test.ts`.
- **Бенчи после удаления `R→V` и сноса legacy (K=3, sandbox, официальный verifier):**
  - `password-recovery` net off: **3/3**, 28/16/15 ходов (median **16**), 3.188/0.959/1.148₽,
    все `R → End`; старый замер — median 17 / 1.433₽.
  - `fix-git` net off: батч 1 — 2/3 (r3: преждевременный stop Research → `R→Patch`, merge не
    сделан, reward=0, `max_turns`); батч 2 — **3/3**, 12/14/15 ходов (median 14),
    0.517–0.717₽. Итог 5/6 `R→End`; старый median 22 / 0.804₽.
  - `log-summary-date-ranges` net on/off: **6/6**, 9–11 ходов (median **9**),
    0.446–0.733₽ (median ~0.47); все `C → End`; старый median 13–15 / 0.64–0.70₽.
  - `openssl-selfsigned-cert` net on/off: **6/6**, 10–17 ходов (median 11–13),
    0.415–0.740₽; старый 16–19 / 0.64–0.76₽.
  - `regex-log` net on/off: **6/6 reward=1**, 8–15 ходов (median 8–10), 1.335–2.004₽; один
    net-on прогон завершился `llm_error` **после** записи `/app/regex.txt` (reward=1, нет End),
    что и стало мотивом error-closure. Дорого не ходами, а reasoning (12–21k).
  - Сеть нигде не использовалась; net on/off — шум. Против opencode (2026-10-24): log-summary
    9 против 4–5 шагов, openssl 11–13 против 7–8, regex-log 8–10 против 6–8; по wall time
    Skein уже на уровне.
- **Проверено офлайн:** `npm run typecheck` чистый; **605 passed / 40 skipped**
  (`SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'`).
- **Доки:** walkthrough (пример стартует в Patch), states_ru, system_prompt, session_concepts,
  projection, ir_semantics (error-closure), state_testing (legacy-разделы помечены
  историческими), `best_bench_ru`/`best_bench`, `task_benchmarks_ru`/`task_benchmarks`.

## 2026-11-06 (вечер) — observer off, `move.done` убран, End без инструкции, двойная сборка

- **Наблюдатель выключен по умолчанию.** `SKEIN_OBSERVER` включает его только при `true`
  (`src/config/settings.ts`); иначе observer не подключается. Причина — net-on hint'ы:
  ложный git-совет и неполная правка `wh*(1+W)` (см. запись ниже). `tests/triggers.test.ts`
  обновлён: default false, явный `true` — true.
- **`move.done` убран с поверхности модели, критерий снова рукописный.**
  `workingInstruction` всегда берёт `ISLANDS[island].criterion`; `done` больше нет в `move`
  (schema, `toProposal`, описание), в IR остался только для старых журналов/фикстур. Patch:
  criterion = `the plan is complete: the error is found and fixed`; instruction — два пункта:
  1) найти файл с координатами и причину; 2) исправить и остановиться с отчётом. Раньше
  модель писала `done` сама и тащила в Patch приёмку запроса («compiler builds and testsuite
  passes»), из-за чего Verification повторяла testsuite.
- **Net-on K=3, observer off, `done` убран (запуски остановлены).** Агенты: 40/27/36 ходов
  (второй батч) и 34/26/34 (первый, прерванный). Все три сделали одну правку
  `p += Whsize_hd(hd)` → `p += wh` в `pool_sweep`, собрали компилятор и прогнали
  `make -C testsuite one DIR=tests/basic`: **40/40, 0 failed** в каждом (`/tmp/*.log`
  в контейнерах). Harbor-reward не снят: верификатор был прерван/остановлен до `reward.txt`.
  То есть «net-on 1/3» из записи ниже — про таймаут верификатора, не про провал правки.
- **Проблема: охота за upstream.** С сетью r1/r3 тратят 10–15 ходов на
  `webfetch`/`git clone` версий 5.4/5.5/5.0/master и diff, чтобы решить, была ли `p += wh`
  «оригинальной» строкой; workspace — `5.5.0+dev0-2025-04-28`, версии расходятся структурно.
  r2 без upstream: edit на t15, 27 ходов; r1/r3: edit на t25/t23, 40/36 ходов. Локальные
  sibling-циклы (`calc_pool_stats`, `pool_allocate`, compaction, verify) уже дают ответ;
  upstream — законная зацепка в общем случае, но не оракул для этой задачи. Кандидат: явная
  граница в плане/B2 «причина названа — правь; fetched reference не оракул».
- **Баг: End не получает инструкцию.** В `buildMessages` (`src/loop/propose.ts`) нет ветки
  `terminal`, а `workingInstruction` делает ранний `return ""` при пустом `criterion`
  (`src/loop/prompt/blocks.ts`). Поэтому `ISLANDS.end.instruction` («write the report…»,
  `src/ir/islands.ts:222`) **не рендерится**. Модель в End видит только
  `Finish state Patch/Verification` + `Start state End`; reasoning r1 t40 / r3 t36: «the
  states are already finished?… I'm in End state», r2 t27 пытается ещё раз прочитать файл.
  Текст последнего хода при этом **записывается**: в terminal текстовый ответ синтезируется
  в `stop { why }` (`src/loop/graph.ts:305-309`) и рисуется как `Finish state End — <why>`
  (`src/ir/project.ts:213`). Теряется он только в артефактах прерванного прогона:
  `session.json`/`result.json` пишутся после `runTask`, т.е. после верификатора.
- **Проблема: двойная сборка.** Агент уже собрал компилятор и прогнал testsuite; затем Harbor
  `test.sh` заново делает `git clone sadiqj/ocaml`, `make clean && ./configure && make -j4`
  и testsuite. Это и есть «тишина» 5–15 минут после последнего хода и причина старых
  `code=124`: ходов у верификатора нет, его stdout/stderr попадают только в `result.json`
  после завершения; клон в старых прогонах занимал 13–14 минут. Клон нужен Harbor'у против
  подмены testsuite, но для нашего замера можно прогнать acceptance в контейнере агента по
  уже собранному дереву, а не пересобирать всё. Решение — отдельным шагом.
- **Таймауты.** `VERIFIER_TIMEOUT_MS` = 0 (no limit) по умолчанию
  (`SKEIN_VERIFIER_TIMEOUT_MS` > 0 включает), `matrix.ts --timeout` по умолчанию 0
  («none»), `DEFAULT_RUN_TIMEOUT_MS` = 0. Протокол батча записан в `AGENTS.md`: параллельно,
  лимит по ходам (60 для `fix-ocaml-gc`), без wall-clock.
- **Ошибка запуска.** K=3 гонялись shell-loop'ом последовательно (13–14 минут на прогон);
  matrix умеет параллельно (`--concurrency`). При SIGINT родителя `docker exec test.sh`
  продолжает жить в контейнере; контейнеры пришлось снимать `docker rm -f`.
- **Проверено офлайн:** `npm run typecheck` чисто; `SKEIN_LIVE=false npx vitest run
  --exclude 'tests/sandbox/**'` — **603 passed / 40 skipped**.

## 2026-11-06 — `fix-ocaml-gc`: user-route, Orientation removed, K=3 net off/on

- **Маршрут — `user`-сообщение.** Request instruction больше не `system`, а последний `user`
  turn (`src/loop/propose.ts`); порядок: `system(base)` / `user(request)` /
  `system(workspace)` / `user(route)`. Текст:
  `Choose exactly one of three values:`; `- Patch when the task is to find an error in the
  existing code and fix it by editing an existing file.`; `- Construction when the task is to
  write new file(s) explicitly.`; `- Research in all other cases.`; последняя строка —
  `The original user request is context for this choice, not the goal.` Список состояний, их
  описания, `what`-подсказка и `decline` из request-инструкции убраны. Это дало
  `fix-ocaml-gc` **Patch 5/5** на первом ходу (до user-route было Research 5/5).
- **Workspace на request-ходу.** `requestBrief` = `researchBrief` (координаты + environment
  Research, без `entries/paths/files`), рендерится перед route. `Explored workspace` пробовали
  и убрали — не помогло. B2 не менялся. `patchBrief` — координаты + environment Patch, без map.
  Полную workspace map (`entries/paths/files`) пробовали вернуть и убрали: в `5b8943d` она уже
  удалена, возвращать не надо.
- **Orientation удалён из live.** `LIVE_ISLAND_IDS` без `orientation`; в `ISLANDS` оставлен
  legacy для старых журналов. `START_ISLAND_IDS = ["patch","research","construction"]`;
  request стартует сразу в продуктивное состояние. `classify`: `not_startable` на request и
  `unreachable` после `Finish` (цель должна быть в `next`).
- **Working prompt.** Один `user`-ход после turns: `Goal`, guess, `Done when`, `Plan`;
  `The original user request is context for this state, not its goal.` `renderState` больше не
  пишет instruction/goal в state entry; `Island.tail` удалён.
- **Patch восстановлен из `HEAD` `5b8943d`.** `what` = `find the defect in the existing
  artifact and make the change it needs`; старые criterion/instruction/next. Это вернуло
  «поиск» в Patch.
- **`bench/turn.ts --rebuild`**: срезает старый state entry, использует текущий criterion,
  читает `island/what/done` из трейсов; `tests/sandbox/live.ts`/`live-trace.ts` эти поля пишут.
- **Docs:** обновлены `AGENTS.md`, `ir`/`ir_semantics`/`projection`/`system_prompt`/
  `state_testing`/`states_ru`, `walkthrough` (исторические примеры помечены),
  `ir_operations` (`not_startable`/`unreachable`).
- **Тесты:** `npm run typecheck` чисто; offline
  `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **603 passed / 40 skipped**.

**Route probe 13 задач × 5 (реальный probe, финальный user-route):**

| task | факт |
|---|---|
| `fix-ocaml-gc` | **Patch 5** |
| `custom-memory-heap-crash` | **Patch 4**, Research 1 |
| `fix-code-vulnerability` | **Patch 3**, Research 2 |
| `regex-log` | **Construction 5** |
| `log-summary-date-ranges` | **Construction 5** |
| `openssl-selfsigned-cert` | **Construction 5** |
| `cobol-modernization` | **Construction 5** |
| `modernize-scientific-stack` | **Construction 5** |
| `fix-git` | **Research 5** |
| `password-recovery` | **Research 5** |
| `db-wal-recovery` | Research 3, Construction 2 |
| `git-leak-recovery` | Research 2, Construction 3 |
| `crack-7z-hash` | Construction 4, Research 1 |

**Живые прогоны `fix-ocaml-gc`:**

- K=1, старый prompt (13:12): `reward=0`, `max_turns`, 65 ходов, 8.996₽; ложные observer
  hints, включая «Remove line 628» — прогон загрязнён.
- K=3 `--net off` (финальный prompt): **3/3 reward=1**, `request_addressed`, ходы 41/25/31,
  стоимость 7.981₽; путь `Patch → Verification → End`, edits 2/1/1, build+testsuite.
  Observer: 1 trigger/run, hint правильный, но повторялся 25/7/13 ходов.
- K=3 `--net on`: **1/3 reward=1**. runs 1/3: `check.code=124`, verifier timeout на
  `Cloning into 'ocaml-original'`, `rewardSource=missing`; run 2: `reward=1`, `40 tests
  passed`. run 1 стартовал Research, runs 2/3 — Patch. runs 1/3 ходили за upstream
  `shared_heap.c` (`curl`/`wget`), run 2 — нет. Стоимость 7.422₽, ходы 40/28/28. Нули —
  таймаут verifier’а, не провал тестов; для чистого net-on замера runs 1/3 надо перезапустить.

**Открытое:** перезапустить net-on runs 1/3 (verifier timeout); observer hint всё ещё липкий
(повтор каждый ход), хотя в net-off прогонах был корректен; recovery-задачи (`db-wal`,
`git-leak`, `crack-7z`) иногда уходят в Construction, потому что правило «write new file(s)
explicitly» буквально совпадает с их output-файлом.

## 2026-11-05 — `fix-ocaml-gc`: ложный липкий hint, observer on/off

- **Симптом.** K=3, `--net off`, observer on (retry 15:47,
  `/tmp/opencode/fix-ocaml-gc-k3-netoff-retry/`): 50+ ходов вместо вчерашних 25–30, два
  прогона дошли до t50/t54, третий до t49. Трейсы:
  `bench/runs/sandbox-tasks/2026-11-05T12-47-55-*` (`N6MXdy`, `92OV0a`, `mMdLPA`).
- **Дефект — не диагноз, а hint.** Настоящую причину (`pool_sweep`: `p += Whsize_hd(hd)`
  вместо `p += wh`) все три нашли сами на t7/t8/t26. На t12 наблюдатель выдал **неверный**
  hint, и дальше 26–33 хода ушли на «the hint is false/stale» и повторную проверку ложного
  следа: «в compaction две одинаковые ветки» (ложь — ветки разные), «ты ещё не собирал, иди
  собирай» (уже собирал), «diff `/tmp/.skein/trees/0`» (снапшоты байт-в-байт равны).
  Правку `p += wh` применили только на t48–t54, после чего прогоны были остановлены.
- **Корень.** У hint нет актуальности: он не сверяется с ходами после триггера и не
  отзывается. Пока состояние открыто, `advisoriesOf` рендерит его **каждый ход**
  (`src/ir/project.ts:442-467`), поэтому модель вынуждена снова и снова его опровергать.
  Триггер `state_long` срабатывает на t12 (порог 9, `src/config/settings.ts:50`).
  Это тот же дефект, что записан в разделе «Перезамер 2026-11-04», но там hint был
  **правильным**: в прогоне
  `bench/runs/sandbox-tasks/2026-11-04T17-18-17-428Z-fix-ocaml-gc-sTIh2b` (29 ходов)
  hint t12 называл ту же строку, которую агент вывел сам на t11, и потому не мешал.
- **Почему 50+, а не 29.** Вчера `--turns 24` (стоп на 29); retry шёл без `--turns`, поэтому
  сработал `fix-ocaml-gc.maxTurns = 60` (`tests/sandbox/tasks/fix-ocaml-gc.ts:15`) и ничто
  не ограничивало цикл. Плюс с `5b8943d` из брифа убрана карта workspace (остались только
  root/repository/cwd), так что разведка дерева тоже подорожала — но это единицы ходов,
  не десятки.
- **Связанные правки промптов (между вчерашними 25–30 и сегодняшними 50+).**
  `1d71637` — `localization` слит в `Patch` (Patch теперь locate+change, критерий требует
  «siblings ruled out + cause named»); `5b8943d` — `Island.hint` слит в `instruction`,
  карта workspace убрана из брифов, переписаны `Orientation`/`Verification`/`End`, удалён
  terminal-промпт. Диагноз от этого не сломался: агент по-прежнему находил фикс за ~8 ходов.
- **Контрольный батч observer off.** `SKEIN_OBSERVER=false`, K=3, `--net off`, тот же дефолт
  60 ходов (`/tmp/opencode/fix-ocaml-gc-k3-netoff-observeroff/`, 16:03–16:15): в контекстах
  **0** строк `Tape-agent hint`. Два прогона закрыли агентский цикл на t40 и t30 (End),
  третий был на t27 и ещё шёл; один transient `llm call failed` на t24 в r1, ретрай прошёл.
  Дальше r2/r3 ушли на верификатор (`bash /tests/test.sh`, в r2 свой `tests/basic` — 40
  тестов, 0 failed); батч **погашен до summary**, поэтому финального reward нет.
  Ходов 27–40 против 50+ — hint-loop исчез, но полного K=3-финала с reward пока не снято.
- **Не сделано.** (1) Доснять observer-off до reward, чтобы утверждать «25–30 восстановлены».
  (2) Решить, как чинить hint: отзыв/expiry после N ходов или после противоречащих ходов,
  рендер только в ход инъекции, либо валидация цитируемых evidence в logos. (3) Проверить
  вклад prompt-правок отдельно от hint (observer off уже почти изолирует его).

## 2026-11-05 — Переформат промптов состояний, фикс Orientation, полные прогоны

- **`hint` слит в `instruction`.** Поле `Island.hint` удалено: подсказка состояния — это его же
  инструкция, а не второй текст. `project.ts` больше не добавляет `ISLANDS[island].hint` в
  запись состояния; список `hint`-строк остался только у recovery/construction, вклеен в текст.
- **`localization` удалён целиком.** `ISLAND_IDS` (без него), `ISLANDS` (запись удалена, не
  «оставлена для старых журналов»), `transitionRule`, `stateBrief`, `tests/*` — синхронизированы.
  `LIVE_ISLAND_IDS` теперь совпадает с `ISLAND_IDS` минус `recovery`.
- **Карта workspace убрана из брифа.** Вместо блока `Workspace map` с листингом и счётчиками —
  три строки координат: `Workspace root:`, `Workspace repository:`, `Working directory:` (без
  пустой строки между ними). `entries`/`paths`/`(N files)` не рендерятся нигде.
- **Брифы разнесены по состояниям** — новый `src/ir/briefs.ts`: одна функция на состояние,
  `stateBrief` в `project.ts` стал диспетчером. Research/Patch/Construction/Recovery получают
  координаты плюс свой подмножество environment; Verification — только environment; End — пусто.
- **End пишет отчёт сам.** `SESSION_REPORT_PROMPT` и отдельный вызов модели для отчёта удалены
  (`driver.ts`, `session_agent.ts`, `llm/session_agent.ts`, `types.ts`). `end.instruction` велит
  писать финальный GitHub-flavored Markdown прямо в `stop`. `NODE_INSTRUCTIONS`/`terminal`
  ситуационный промпт удалён полностью; критерий End остался пустым.
- **Критерий Orientation переписан — и это починило нестабильность.** Было: три конъюнкта
  знания плюс расплывчатая инструкция о том, что писать и когда останавливаться; 6 из 39
  прогонов тратили ход на `list`/`bash` внутри Orientation («already known… let me list to
  ground»). Стало: `the reply names the workspace root, the repository status, and the acceptance
  the request declares`; инструкция — «три строки, root и status уже на ленте, acceptance —
  слова запроса». После правки: **69/69 прогонов закрывают Orientation на t1, ноль вызовов
  инструментов внутри** (серии route4/5/6, 13 задач × K=3).
- **Полные прогоны 5 задач × K=3 (`/tmp/full1`, `live-step --auto`, без `--turn`).**
  13 из 15 дошли до конца, 3.75₽. `request_addressed`: cmhc r2/r3, db-wal r1, fix-code r1–r3,
  fix-git r1–r3, regex-log r1–r3. `observer_halt`: cmhc r1. Два прогона db-wal (r2/r3) убиты
  вручную на t8 — их журналы неполные. Ходов 11–31 (медиана ~14).
  `bench/live-step.ts` не запускает верификатор, поэтому reward по этим логам не считается.
- **End выдаёт Markdown, и он разный.** 13 завершённых отчётов: 1.3–2.8 тыс. символов, H2-разделы
  (`Summary`/`Root cause`/`Change`/`Verification`/`Still open`), таблица при перечислении файлов,
  код-блок для паттерна/JSON. Одно отклонение — `cmhc-r1` без H2, с жирными метками.
- **Найден дефект движка: `move` не проверяет достижимость.** В `fix-code-vulnerability-r1`
  (серия route5) модель на переходном ходу вызвала `move(orientation)` из закрытой Orientation —
  движок принял, в журнале `orientation → orientation`. Причина: `move.state` в схеме —
  `z.enum(LIVE_ISLAND_IDS)`, а `classify` (`src/loop/classify.ts:40`) проверяет только
  «состояние закрыто», но не «цель есть в `ISLANDS[island].next`». Аудит 92 прогонов: ровно один
  такой случай. Переигровка того же контекста 20 раз: Patch 14, Research 6, Orientation 0 — то
  есть выброс, не систематическая тяга. **Не исправлено** (владелец: «пока забьём»).
- **`live-step` теряет причину `observer_halt`.** `graph.ts:599` кладёт её в
  `AgentResult.stopText`, но `bench/live-step.ts` пишет в `turns.ndjson` только `stopReason`.
  Одна строка (`stopText: run.stopText`) сделала бы halt диагностируемым.
- **Проверено офлайн:** `npm run typecheck` чистый; **601 passed / 64 файла**
  (`SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'`).
- **Не сделано:** документация про `localization` не вычищена (`docs/states_ru.md`,
  `docs/testing.md`, `docs/system_prompt*`, `docs/benches/*`, `docs/plans/*`) — отложено
  владельцем до конца правок кода.

## 2026-11-04 — Два живых прогона после слияния (observer off) и предложения

- **Зачем observer off.** Единственный прогон после слияния (42 хода) выигрывал за счёт хинта
  наблюдателя (seq=124), который называл фикс прямо; сравнить вклад слияния по нему нельзя.
  Оба прогона ниже — `SKEIN_OBSERVER=false`, `--net off`, задача та же
  (`custom-memory-heap-crash`).
- **Прогон A, `--turns 24` (дефолт): 29 ходов, 1.348₽, reward=1, `max_turns`.**
  `O@t0 → P@t2`, `Patch` не закрылся: 24 + grace 5 = 29. Приёмка при этом выполнена —
  `release exit=0` на t10; верификатор смотрит на файл, а не на состояние, поэтому reward=1.
- **Прогон B, `--turns 40`: 36 ходов, 2.222₽, reward=1, `request_addressed`.**
  `O@t0 → P@t2 → V@t29 → End@t34`, все шесть проверок зелёные, включая valgrind.
  Разбивка стоимости: Orientation 3 хода / 0.049₽ (2%); **Patch 26 ходов / 1.938₽ (87%),
  пик контекста 108 523 символа**; Verification 5 / 0.160₽ (7%); End 2 / 0.075₽ (3%).
- **Что осталось.** В B после t13 (изменение уже держится) ушло ещё ~15 ходов: gdb/objdump-
  археология «почему регистрация работает именно так» (t16–t21) и погоня за valgrind-овским
  `still reachable: 73 728 bytes` — это EH-pool libstdc++ (`eh_alloc.cc:373`), не утечка; агент
  это распознал, но поздно. `Patch` закрылся на t28, через 12 ходов после того, как критерий
  фактически выполнялся. Плюс один отказ `stale_base` на t22 (write после длинной bash-серии)
  стоил двух ходов (read → write заново).
- **Дисперсия.** Два прогона с идентичной конфигурацией дали 29 и 36 ходов, 1.35₽ и 2.22₽.
  Разброс больше измеряемого эффекта: утверждение «29 против 42/65» неверно, честное —
  «не хуже, крайний случай 65 ходов не воспроизвёлся, механизм поломки ушёл».

## 2026-11-05 — Предложения 1–3 разобраны: `stale_base`, критерий `Patch`, дефолт бюджета

- **Поправка к записи ниже.** Утверждение «`stale_base` стоил двух ходов» неверно: в прогоне B
  он занял **три** (t23 отказ, t24 read, t25 write). Дополнительно: `still reachable` в этом
  запросе — **не чужой**, запрос прямо требует «There must be no memory leaks detected by
  Valgrind», то есть это часть приёмки. Поэтому пункт 2 предложений ниже в этой части
  переформулирован: valgrind из критерия не вычёркивается, он переносится в Verification.
- **Замер по записанным прогонам (Слой 0, без live).** Метрика: первый ход, где приёмка
  выполняется → закрытие состояния. `fix-ocaml-gc`: 1–4 хода (все 2026-10-23 — 1). CMHC
  42 и 65 ходов — по 4. **Аномалия одна — CMHC-36: 15 ходов.** Её состав: t14 приёмка держится;
  t15–t17 повторный release, debug, запуск (в запросе); t18–t22 археология механизма
  (gdb/objdump, `_Facet_Register_impl`); t23–t25 `stale_base`; t26–t28 сборка + valgrind —
  работа Verification, которая потом заняла всего 5 ходов/7%. То есть механизм закрытия в целом
  здоров, а 15 ходов распадаются на три названные причины, а не на «долго думал».
- **Пункт 3 сделан: `stale_base` отдаёт содержимое.** `commandRefusal` возвращал голую строку,
  и это срабатывало раньше ветки `write`, поэтому сообщение на `:1415` («changed since it was
  read; re-read first») было **недостижимо**. Теперь отказ несёт `stale: { path, ref, version }`,
  наблюдение рисует текущее содержимое файла (приём уже работал у неудачного `edit`) и записывает
  текущую версию, которую `fold` фиксирует как observed, — повторный write/edit проходит без
  отдельного read-хода. Мёртвая ветка удалена. Тесты `REF-EDIT-STALE`/`REF-WRITE-STALE` обновлены
  и проверяют сам ретрай.
- **Пункт 2 сделан (текст): критерий `Patch` стал решаемым.** Убран повисший конъюнкт «the result
  has the declared form» — теперь эту форму никто не объявляет, и
  doxa не могла решить критерий внутри состояния, поэтому добирала уверенность (это же
  §5.2 `state_testing` — «will to certainty» — но с конкретной причиной в тексте). Новый
  критерий: `… and the change holds: every file the task needs is created or updated, it builds
  with the command the request declares where it declares one, and the symptom the request names
  is gone`. В `instruction` и `hint` названа граница: объяснение механизма и приёмочные проверки
  запроса (leak-проверки, тестсьюты) — работа Verification. Синхронизированы `patch.next[0].when`
  и `transitionRule("patch")`. Размер критерия не вырос (297 против 300 символов).
- **Пункт 1 НЕ сделан — и почему.** «Поднять дефолт 24→40» в коде отсутствует: `settings.ts`,
  `sandbox-run.ts`, `harness.ts`, `run.ts`, `sandbox-smoke.ts`, `.env.example`, README — всюду 24;
  у `custom-memory-heap-crash` поля `maxTurns` нет. 36-ходовой прогон прошёл с **явным**
  `--turns 40` (`sandbox-run.ts:44`: явный флаг перекрывает дефолт), поэтому он ничего не
  доказывает про дефолт. Пара A (29 ходов, `max_turns`) и B (36, `request_addressed`) — это и есть
  демонстрация разницы 24 против 40. Отдельно: `settings.maxTurns` песочницей не читается вовсе
  (только `bench/run.ts`), так что поднимать надо не одно значение, а четыре точки или ставить
  `maxTurns` на задачу, как у `fix-ocaml-gc` (60). Решение владельца — отдельным шагом.
- **Проверено офлайн:** typecheck чистый; **596 passed / 40 skipped**. Live не запускался.

### Предложения из записи 2026-11-04 (состояние на 2026-11-05)

1. **Дефолт `maxTurns` в песочнице мал.** `tests/sandbox/sandbox-run.ts:44` берёт
   `task.maxTurns ?? 24`, у `custom-memory-heap-crash` поле не задано; `settings.maxTurns`
   (`SKEIN_MAX_TURNS`) тоже 24. После слияния только `Patch` занимает 26 ходов, поэтому
   прогон A упёрся в потолок при уже выполненной приёмке. Варианты: поднять дефолт до 40 или
   задавать `maxTurns` на задачу в `tests/sandbox/tasks/*`.
   **Статус 2026-11-05: не сделано** (решение владельца; затрагивает четыре точки, см. запись выше).
2. **У `Patch` нет границы «изменение держится — остановись».** Критерий (`change holds`,
   форма проверена) выполняется на t13, а состояние живёт до t28: агент объясняет механизм и
   разбирается с `still reachable`, хотя это не часть критерия. Это 87% стоимости прогона и
   главная утечка. Вариант: явная строка в `patch.instruction`/`hint` о том, что объяснение
   механизма и разбор чужого `still reachable` в критерий не входят, — но это правка
   поведения, её надо решать отдельно и мерить K≥3.
   **Статус 2026-11-05: сделано в тексте, не проверено live.** Уточнение: `still reachable`
   здесь **не чужой** — запрос требует отсутствия утечек по Valgrind. Поэтому строка отделяет
   не «valgrind не нужен», а «valgrind — работа Verification», и критерий перестал требовать
   необъявленную форму. Мерить K≥3 — отдельным go-ahead.
3. **Отказ `stale_base` на write после длинной bash-серии** повторяется в обоих прогонах
   (t25 в A, t22 в B) и стоит двух ходов. Стоит посмотреть, нельзя ли отдавать в контексте
   актуальную версию файла, который агент только что прочитал, вместо отказа.
   **Статус 2026-11-05: сделано.** Отказ несёт текущее содержимое и версию; ретрай проходит без
   read-хода. Уточнение: в B это t23–t25, три хода, а не два.

## 2026-11-04 — Перезамер `fix-ocaml-gc` и `custom-memory` (K=1), дефект хинта

- **`custom-memory-heap-crash`: 65 ходов, 5.954₽, reward=1, `request_addressed`.** Старая
  медиана **57 была цензурирована бюджетом 60**: две ячейки из трёх кончались на 57 и 59, одна
  упёрлась в `max_turns` ровно на 60. С `--turns 80` задача закрывается сама на 65. Путь
  больше не четырёхцикловый: `O → P → V → End`, 4 состояния. Patch — 43 хода из 65 и
  3.78₽ из 5.95₽. Все 6 проверок приёмки, включая valgrind, проходят.
- **`fix-ocaml-gc`: 29 ходов, 2.470₽, reward=1, 40/40 тестов.** Попадает в диапазон 26–30 из
  §4.3, счёт ходов устойчив. Правка одной строки на t16, сборка и тестсьют t23–t25. Один
  `llm call failed` (пустой стрим) около t13, повторён, на результат не повлиял.
- **Не чистое сравнение движков:** ячейки 2026-10-24 — `deepseek-v4.1-flash-1017` (BytePlus),
  сегодняшние — `deepseek-v4-flash-latest` (routerai). 65 против 57 и 2.470 против 1.500 —
  не «регрессия движка», часть разницы даёт модель.
- **Наблюдатель: два прогона, ни один хинт не дал нового знания.** На `custom-memory` второй
  хинт (t24) велел поставить breakpoint на `_Facet_Register_impl`, что агент уже сделал; 11
  последующих ходов начинаются с «the hint is stale — I already did that» и стоят **0.886₽**
  из 5.95₽, дважды правка писалась по устаревшему совету. На `fix-ocaml-gc` хинт (t12) назвал
  `pool_sweep` и точную строку, но агент вывел это сам на t11. Порог тут не виноват: при 9 он
  срабатывает вовремя. Дефект — у хинта нет понятия актуальности: он не сверяется с ходами
  после триггера и не отзывается. Тот же корень, что у выдуманных числовых смещений.
- **Документация.** `task_benchmarks` §4.6 и §12.6 (оба зеркала) — текущие замеры; §12.6
  отдельно фиксирует цензуру бюджета. `best_bench` — пометка «superseded» на старом «регрессе»
  и правка шапки. `request_observer_plan` §10 — разбор двух прогонов.
- **Не сделано:** сравнение с opencode не снять — адаптер против v2.2.5 передаёт удалённый
  `--variant` (`tests/sandbox/opencode.ts:157`).

## 2026-11-04 — Наблюдатель: state-лента, порог 9, фикс рендера результата

- **Лента наблюдателя вместо обзорных инструментов.** `defaultObserverTools`/`ObserverTools`
  удалены: наблюдатель получает одну детерминированную ленту состояния (`stateTape` в
  `src/session/outline.ts`) — запрос, список `move` и все ходы состояния, в котором сработал
  триггер, по порядку: рассуждение → действие → наблюдение, с адресами узлов. Reasoning идёт
  **до** действия, которое он предварял. `hint` не несёт поля `state` — оно в шапке ленты.
  Обзорных вызовов нет: всё, что наблюдателю можно прочитать, уже в ленте.
- **Фикс рендера результата (регрессия в самом `stateTape`).** `write`/`edit` вешают
  `mutates` на `file:<path>` и **никогда** не создают `result`-узел, поэтому 135 из 143
  `write` и 146 из 158 `edit` рисовались как `-> no result`. Введена экспортируемая
  `actionResultText` (`src/ir/project.ts`); `stateTape` и `observationBody` переиспользуют её.
  Проверено: **0** ложных `no result` из 272 успешных `write`/`edit` по 19 современным
  прогонам (было 27). Проваленный вызов — исключение: `failed()` вешает `result` на
  наблюдение с `payload.failed: true`, и он рисуется как результат.
- **Порог `state_long` 13 → 9** (`DEFAULT_STATE_LONG_TURNS`, `src/config/settings.ts`;
  `SKEIN_STATE_LONG_TURNS` по-прежнему перекрывает). `detectTriggers` не менялся. Обоснование
  замером по записанным прогонам: срабатывает 16/19 против 11/19, и в 15/16 случаев — **до**
  того, как ответ записан; лента наблюдателя вдвое короче (11.5k против 17.8k токенов,
  median), запас — median 7 ходов. На `cobol` порог 9 даёт 11–16 ходов запаса против 7–12
  при 13. Триггер `budget` **не менялся** (решение владельца).
- **`password-recovery` перестала быть пробником наблюдателя.** Девять прогонов 2026-11-04:
  **9/9 reward=1**, median 17 ходов / 1.433₽. Самые короткие (13 и 15 ходов) прошли **без
  триггера**, а пароль агент выводил раньше хинта. Все действия внутри состояния — разные
  команды, трэшинга нет, поэтому `state_long` здесь мерит производительность, а не потерю
  дороги. Механизм «наблюдатель нужен, когда агент сбился» на этой задаче не проверяется.
- **Сравнение с opencode** (`best_bench_ru.md`, батч 2026-11-04): вызовов модели 18 против 12,
  действий в среде **12 против 19**, всего входа 154 774 против 229 539, свежего 39 062 против
  20 927, кэш 77% против 91%, ₽ 1.177 против 0.953 (1.23×). «Шаги» напрямую сравнивать нельзя:
  opencode делает 2–3 инструмента за вызов модели (`tools/step = 1.58`), Skein — один (1.00).
- **Известный дефект, не исправлен:** наблюдатель изобретает числовые смещения, которых нет в
  ленте (например `1048671` и `3145726` при фактическом `3145727`). Logos проверяет только
  существование id доказательств, не совпадение цитируемого содержимого.
- **Адаптер opencode сломан против v2.2.5:** `tests/sandbox/opencode.ts:157` передаёт
  `--variant`, которого больше нет (`Unrecognized flag`); вариант задаётся как
  `provider/model#variant` и уже стоит в конфиге (строка 106). Флаг лишний.
- **Файлы:** `src/session/outline.ts`, `src/ir/project.ts`, `src/config/settings.ts`,
  `src/llm/{observer,structured}.ts`, `src/loop/graph.ts`, `src/session/{driver,observer,
  session_memory,session_outline,types}.ts`, `tests/{outline,triggers,observer*}.test.ts`,
  `bench/{rollout,live-step}.ts`, `bench/observer-turn.ts` (новый инструмент: прогон
  наблюдателя на одном записанном ходе без контейнера). Typecheck чистый; офлайн
  **593 passed / 40 skipped**.

## 2026-11-03 — Research = Research + Recovery, маршруты, артефакты, узкие пробы

- **Merge:** `recovery` больше не живое состояние; Research поглотил его. `LIVE_ISLAND_IDS` без
  `recovery`; `ISLANDS.recovery` остаётся только для старых журналов. `move` не может выбрать
  recovery (`isIsland` проверяет live-набор), базовый промпт и переходы его не рисуют.
- **Research:** `what` = `solve a situation: derive the required result from the material or the
  specification`; criterion — Recovery: `the task's required result exists in its declared form,
  is derived from the material or the specification, and matches what the material or the request
  contains`. Убраны `investigate/produce result it yields`, `reconstruct`, ветка Construction и
  запрет «do not carry it out». Read-only проверка на копии разрешена.
- **Маршруты:** `O → P` (дефект в существующем артефакте) / `O → R` (ситуация: результат вывести
  из материала/спеки) / `O → C` (построить новый артефакт). `Research → Construction` удалено —
  Construction остаётся отдельным.
- **Environment:** без заголовка `Environment`, без `tools:`/`missing`. Только
  `Workspace root`, `Network is available`, `Version-control tools`, `Build tools`, `Compilers`,
  `Installed interpreters`, `Test tools`, `Available package managers`. `core/crypto/data/archive/net`
  не рендерятся; `tools` убран из `PROBE_KINDS`.
- **Finish-строка:** projection добавляет `Artifacts: <paths>` из явных `write`/`edit` action-нод
  (не shell/билд-мутации). Закрытое состояние больше не теряет факт артефакта при элизии ходов.
- **B2:** `inspect narrowly` (targeted `grep`/малое окно, не дамп региона) и `stop, do not re-run
  a check`.
- **Результаты (K=3, net on, `--turns 24`):** password **3/3**, 17 ходов, **0.799₽**; fix-code
  **3/3**, 23, **0.734₽**; db-wal **3/3**, 24, **0.966₽**. Для сравнения password до merge —
  2/3, 24, 1.412₽. `fix-code` r3 — `max_turns`, reward=1.
- **Файлы:** `src/ir/{islands,environment,project}.ts`, `src/llm/{tools,schemas}.ts`,
  `src/loop/{graph,prompt/blocks}.ts`, `src/session/session_workspace.ts`, тесты. Typecheck чистый;
  офлайн **586 passed / 40 skipped**.
- **Открыто:** закрытие Verification (`fix-code` r3); остальной Recovery-класс (`crack`, `git-leak`);
  Hybrid-маршрут `git-leak` требует `R → P`, а этого ребра в `next` нет (движок `move patch`
  принимает, но prompt его не предлагает); исторические benches не переписаны.

## 2026-11-03 — IR: плоские ходы вместо plan/item/alts

- **Схема:** `request --move--> move --turns--> turns --turn--> action`; у действия —
  `result`/`mutates` как раньше. Внутри state — монотонный список ходов, без `item` и
  альтернатив.
- **Удалено:** `firstUnfulfilledItem`, `itemFulfilled`, `cursorOf`, `planExhausted`, `itemOf`,
  `actionSuperseded`, `altMarker`/`attemptReason`, `stateAttempt`/observer-tool `attempt`.
- **Переименовано:** `planOf`→`turnsOf`, `ensurePlan`→`ensureTurns`, `placeMove`→`appendTurn`,
  `renderPlan`→`renderTurns`; `NodeKind` `plan`/`item`→`turns`, `EdgeKind`
  `plan`/`items`/`alts`→`turns`/`turn`.
- **Ситуации:** `plan`/`working` слиты в `working`; открытое состояние ничего не дописывает в
  `buildMessages`.
- **Потребители:** tools/project/attempts, session outline/memory/general, TUI view-model.
- **Промпт:** B2 явно запрещает реконструировать external/upstream по памяти (reference —
  зацепка, не оракул).
- **Проверки:** typecheck чистый; офлайн **583 passed, 40 skipped**; sandbox offline 7 passed.
- **Live (`live-trace`, 6+5 grace):** Orientation — t0 `move`, t1 текстовый stop;
  Patch — t5 `move`, t6 `read`,
  t7 `recall`, t8 `read`, t9–t10 `bash`, затем `max_turns`. Ошибок нет, `stop`-тула нет;
  повторный `read` на t6→t7 — просто следующий ход, без alternative-маркера. `fixed=false`
  из-за cap, не регрессия; трейс `bench/runs/sandbox-live-2026-11-03T13-27-31-502Z-fix-ocaml-gc`.
- **Live K=3 (`live-trace`, 6 ходов):** во всех трёх Orientation — t0 `move`, t1 текстовый
  stop; дальше маршрут нестабилен: r1 → Research, r2 → Patch, r3 →
  Patch→Research. Все `max_turns` на 6, ошибок/отказов нет; 0.22–0.30₽/прогон
  (~0.75₽).
- **Live K=3, maxTurns=40 (`live-trace`):** завершены 2 из 3 (третий прерван). Оба
  `fixed=true`, `max_turns` на 45 (40+5 grace), 45 ходов, 0 отказов, `stop`-тула нет;
  r1: O→P→V→P→V, r2: O→P→V→P. Токены/стоимость: 294k/22.9k in/out, cache 83%,
  2.56₽; 331.9k/17.3k, cache 88%, 1.97₽.
- **Real sandbox K=3, `fix-ocaml-gc`, `--turns 20`, net off:** reward **1/3**; два прогона
  упёрлись в `max_turns` (20+5 grace)
  в Patch/Verification. Стоимость 1.247 / 1.574 / 1.563₽ (mean 1.461₽); in 181k / 312k / 284k,
  cache hit 77 / 86 / 84%. 20+grace мало для reward.
- **Real sandbox K=3, `fix-code-vulnerability`, `--turns 20`, net off:** **3/3 reward=1**.
  Turns 25/21/20; cost
  0.803 / 0.747 / 0.749₽ (mean 0.766₽); in 144k / 109k / 118k, cache 80 / 74 / 77%.
  Patch доминирует по стоимости. Для сравнения opencode net-off (matrix 2026-10-24-fix-code):
  8/14/9 шагов, cost ~0.34/0.52/0.27₽, fresh 8.4–13.5k, cache 92–94%, out 1.2–3.0k.
  Наш разрыв — fresh input (28k vs 10.9k), число шагов (22 vs 10.3) и visible output
  (3.55k vs 1.91k); reasoning сопоставим (0.85k vs 0.79k). Исторический Skein net-off:
  21–26 ходов, ~0.750₽.
- **Real sandbox K=3, `fix-git`, `--turns 20`, net off:** 3/3 reward=1, но маршрут у всех
  **O→Research→Recovery→End** — fix-git с текущим промптом не доходит до Patch.
  Turns 17/20/20; cost 0.689/1.158/0.893₽ (mean 0.913); in 71k/113k/118k, cache 71/74/77%.
  Opencode net-off: 8–10 шагов, ~0.204₽; исторический Skein: 19–22 хода, ~0.744₽
  (документированный O→P→V).
- **Real sandbox K=3, `custom-memory-heap-crash`, `--turns 20`, net off:** reward **1/3**;
  все три упёрлись в `max_turns` на 25 (run2/run3 — в
  Patch/Construction). Cost 1.541 / 1.532 / 1.632₽ (mean 1.568₽); in 266k / 231k / 168k,
  fresh 34k / 42k / 41k, cache 87 / 82 / 76%, out 12.5k / 10.7k / 12.6k.
  Opencode net-off: 27 / 20 / 18 steps, cost ~1.401 / 1.377 / 2.132₽ (mean 1.637₽),
  fresh 36.4k, cache 93.6%. Cost parity/чуть дешевле; reward ограничен 25-turn cap.
- **Открыто:** старые журналы с `plan/items/alts` не читаются (bench/replay работают с
  Context/actions, не с IR); `docs/{walkthrough,concepts,ir_operations}.md` ещё упоминают
  plan/item и требуют отдельного прохода.

## 2026-11-03 — Task: text stop, без динамического хвоста

- **`stop` tool убран** с поверхности задачи; оператор `stop` в IR остаётся. Непустой текст без
  tool call в `working`/`terminal` синтезирует `stop` (`why` = текст) в `executeNode`;
  на `request`/`transition` tool обязателен (`move`/`decline`).
- **Хвост убран:** `buildMessages` больше не добавляет `turnInstruction`/`planInstruction`.
  `hint` и `Done when` рендерятся в шапке открытого state (`renderState`); правило про
  сохранность материала перенесено в B2. В шапке теперь и явное «критерий выполнен → ответь
  текстом, без tool call».
- **Sandbox probe:** `runSandbox` теперь прокидывает `probeSession`, поэтому Orientation
  видит карту workspace (root/repo/entries), а не вынужден делать `list`/`git status`.
  Это была причина трёх ходов в первом live-trace.
- **Промпт:** B1 — критерий выполнен → ответ текстом без tool call; B2 — dedicated tools
  first, `bash` только когда они не могут; обновлены `end`/orientation.
- **Файлы:** `src/llm/{tools,structured}.ts`, `src/loop/{propose,graph}.ts`,
  `src/ir/{project,islands,traversal}.ts`, `src/loop/prompt/{blocks,index}.ts`.
- **Тесты:** `tests/loop.test.ts` (+text stop, terminal, transition), обновлены
  surface/projection/tape/messages/prompt.
- **Проверки:** typecheck чистый; офлайн **583 passed, 40 skipped**; sandbox offline
  (`fix-ocaml.test.ts`, `metrics.test.ts`) — 7 passed; `bench/rollout --dry` ок.
- **Live (`live-trace`, 6 ходов, после probe):** Orientation — t0 `move`, t1 текстовый stop
  (2 шага); t5 `move` Research.
  `max_turns` на 6 — ожидаемый cap; `stop` в tools нет. Первые 3 шага в Orientation были
  из-за отсутствия `probe` (нет карты workspace) — исправлено.
- **Reasoning:** `stop`-узел теперь хранит `payload.reasoning`; `live-trace` пишет
  `reasoning.ndjson` и печатает скрытое reasoning рядом с action.
- **Открыто:** текст без tool call в `working` может закрыть state преждевременно; повторный
  текст на `transition` даёт `llm_error` (repair в `invokeTools`); длинный текст
  промежуточного state целиком попадает в `Finish`-строку (t4 в live — ~1.2k симв.);
  стоит просить 1–2 предложения для не-End state.

## 2026-11-03 — TUI: @-файлы и слэш-команды

- **`@`:** меню файлов над композером (`workspace.listFiles`, `SKIP_DIRS`), фильтр по
  подстроке с приоритетом basename, `↑/↓`, `Enter`/`Tab` вставляют `@path`, `Esc` закрывает.
  Индекс пересобирается при каждом открытии меню. Вставка — только путь, без содержимого;
  dot-файлы и пути с пробелами не поддерживаются.
- **`/`:** меню команд `new`/`help`/`tasks`/`pause`/`resume`/`cancel`/`quit`/`mouse`/
  `verbose`/`status`/`clear`; `//` — литеральный слэш, неизвестная команда не уходит в модель.
  `/new` создаёт новую in-memory сессию, чистит trace/паузу/снапшоты; телеметрия кумулятивна;
  команда запрещена во время run и паузы.
- **Файлы:** `src/tui/completion.ts`, `CompletionPanel` в `src/tui/panels.tsx`,
  `src/tui/app.tsx`; тесты `tests/tui_completion.test.ts`, дополнен `tests/tui_app.test.tsx`;
  `docs/plans/tui_plan*.md`.
- **Проверки:** typecheck чистый; офлайн **579 passed, 40 skipped**.
- **Коммит:** `99ea7fc`.

## 2026-11-03 — Палитра/токены TUI, контракт ответа general

- **Палитра:** `src/tui/theme.ts` переведена на точные роли из темы opencode
  (`packages/tui/src/theme/assets/opencode.json` в апстриме): light/dark, markdown
  (heading/code/link/strong), syntax. Активный блок — белый фон в light и чуть светлее
  в dark; markdown-цвета не перекрашиваются. Activity-индикатор — braille + `working ·`.
- **Markdown:** убран кап 100 колонок и отступ — вывод снова на всю ширину панели
  (`src/tui/trace_lines.ts`). Узкая мера была компенсацией тёмного фона, а не плотности.
- **Токены:** header — `ctx` + Σ `in/out/cache/rsn`; панель задачи — `in` = текущий
  контекст (последний input), `out` = out+reasoning, плюс `cache`; по ходу — только
  `in/out`. `view_model.ts` собирает `cachedInputTokens` и `contextTokens`.
- **Многословность general:** причина — не бриф и не «глубина чтения». Сырой бриф
  «расскажи о проекте» дал 2 хода/2 чтения, но 4083 симв. (контроль с расширенным
  брифом — 4388). В opencode 1.19.5 для DeepSeek выбирается
  `packages/opencode/src/session/prompt/default.txt` с жёстким контрактом краткости,
  которого не было у general. После переноса в `GENERAL_BASE_PROMPT` (без дублей) —
  1694–2010 симв. / 707–871 out на трёх прогонах. Модельно-специфичные промпты
  (gpt/claude/gemini/kimi/trinity) отложены: без live-проверки на этих моделях
  рискованно.
- **Проверки:** typecheck чистый; офлайн **560 passed, 40 skipped**.
- **Коммиты:** `9fa9a5f` (палитра/токены), `d196ea1` (контракт general), `014c726`
  (markdown на всю ширину).

## 2026-11-03 — Session/general prompts, text stop, AGENTS.md

- **Session prompt:** `SESSION_BASE_PROMPT` переписан положительно: маршрут по результату
  (`respond` — ответ из диалога; `general` — ответ требует разведки, ничего не меняется;
  `start` — изменение workspace/команда). Убраны `request`/`plan`, отрицания и дубли;
  форматирование и цитаты относятся только к `respond`. Описания `respond`/`general`/`start`
  приведены в соответствие.
- **General stop:** `general_stop` убран. `invokeTools` получил `allowText`; general
  принимает текстовый ответ и переводит его в штатный `stop`-узел (`stop` edge, provenance
  llm). Task по-прежнему требует tool call.
- **Reasoning на ленте:** `historyOf` снова кладёт `payload.reasoning` в assistant-сообщение.
  До этого general не видел своих прошлых рассуждений и каждый ход заново интерпретировал
  вопрос.
- **Tool surface:** general получил `grep`/`list`; `general_bash` переименован в `shell` и
  описан как fallback; `read`/`recall` получили узкие general-описания.
- **AGENTS.md:** general получает `AGENTS.md` как engine-recorded project instructions
  (`projectInstructionsText` + `generalContextText`). Это снимает главную причину похода
  в `tests/`: без глоссария «коллекции» читались как test fixtures; с `AGENTS.md`
  («ProofWriter collection notes (eval harness)») general сразу идёт в `docs/`/`evals/`.
- **TUI:** markdown на всю ширину панели (кап 100 и отступ позже убраны); activity-индикатор
  анимируется (теперь braille `⠋⠙⠹…` + `working ·`) только при running.

**Наблюдения live (ankyra, копия в /tmp):**
- text stop сам по себе (run4) и tool surface как в opencode (run5) не уменьшили ходы
  (10 + 10); stop-фраза (run6) сократила ответы, но не ходы.
- после `AGENTS.md` g1 в CLI: первый action — `evals`/`docs`, не `tests`; 9 ходов.
- g2 напрямую с `AGENTS.md`: 7 ходов, 8 tool calls, 3 465 симв. — сопоставимо с траекторией
  opencode (`docs` → `reasoning_roadmap` → collection-доки → ответ).
- `npm run typecheck` чистый; офлайн **560 passed, 40 skipped**.
- Observer для general не добавляли: систематики нет, term-детур снят; вернуться, если
  будет стабильно 9–10 ходов или повторные чтения без новых наблюдений.

## 2026-11-01 — TUI, general, task loop

- **General:** бриф session-агента ограничен глубиной запроса (без инвентаризации и
  аудита, которых не просили); у general свои `general_bash`/`general_stop` (read-only,
  Markdown-отчёт), facts из probe, snapshot при входе и `restoreChanged` при выходе.
  Session-агент больше не получает карту дерева (только root), поэтому бриф не перечисляет
  каталоги и файлы. `read` отдаёт до 32K, и его результат хранится в истории general целиком;
  остальные tool-результаты — 2k (голова + 400 хвоста, `recall obs:…`). После
  `max_turns` — один финальный вызов без инструментов с запретом домысливать. Промпт
  требует общего вывода, ясного академического языка и отсутствия лишних деталей.
- **Task loop:** LangGraph удалён. `src/loop/graph.ts` — обычный `while`, `src/loop/state.ts` —
  типизированная запись. `@langchain/langgraph`/`@langchain/core` убраны из зависимостей.
  У интерактивной task нет дефолтного `maxTurns`; `--max-turns` остаётся явным лимитом
  для bench/headless, `budget`-триггер работает только при нём. `state_cycle`/`state_long`
  observer'а остаются. Два пустых ответа подряд → `no_decision`. Завершённый run без
  терминального `end` помечается `abandoned`, а не `suspended`.
- **Checkpoint:** общий `SKIP_DIRS` (`src/tools/skip_dirs.ts`) для `list`/`grep` и снапшота;
  `restoreChanged` восстанавливает только изменённые пути. На `ankyra` снапшот сканирует
  263 файла / 6 МБ / ~2 мс вместо 492 МБ.
- **TUI:** фоновые панели с зазором; блоки сообщений на всю ширину, collapse/expand
  кликом (при `SKEIN_MOUSE=true`/`Ctrl-G`) или `Tab`+`Space`; Thought-блоки с таймингом;
  цветной diff для `edit`; подсветка кода (авто для fence без языка); композер 5 строк
  с переносом и курсором между символами; история ввода `Up/Down`; правая панель —
  текущее состояние, ходы (`tN · токены · время`), суммы по состоянию и задаче; observer
  кратко показывается в статусе. Mouse capture по умолчанию выключен (нативное выделение),
  alternate-scroll — для колеса; `Ctrl-G` переключает capture.
- **Логи:** `SKEIN_LOG` — JSONL, по умолчанию `<project>/.skein/session.log`
  (`off`/свой путь). Пишет реплику, бриф, model calls с usage, tool-таргеты, observer,
  stopReason и ответы; reasoning — до 4k. Полные выводы инструментов остаются в
  `.skein/observations`.
- **Проверки:** typecheck чистый; офлайн **556 passed, 40 skipped**. Live: `general-live`,
  `session-live`, `observer-live` прошли; `fix-ocaml.live` падает на `max_turns` и на чистом
  `HEAD` тоже (существующая проблема, не регрессия).
- **Открыто:** почему простая задача уходит в долгий construction (нужен `session.log`
  следующего прогона); эскалация observer/no-progress guard — после разбора лога;
  `fix-ocaml.live`; персистентность сессии; L0 при переполнении; стоимость.

## TUI (сделано, 2026-10-31)

- **Основной режим:** `npm run cli` открывает Ink-TUI в alternate screen. Старый построчный
  REPL остаётся за `--plain`; `Enter` отправляет, `Ctrl-J` — новая строка, `Ctrl-C` —
  прервать/выйти, `Ctrl-D` — выйти.
- **Живой прогресс:** `src/session/progress.ts` — side-channel `ProgressEvent`; его испускают
  `src/loop/graph.ts`, `src/session/{session_agent,observer,driver}.ts`. События:
  `turn_started`, `model_call_started/finished`, `tool_started/finished`, `events_added`,
  `state_changed`, `turn_finished`, `paused`, `report_started/finished`.
- **Панели:** header (`ctx` — вход последнего model call агента сессии, `Σ in/out` — суммарный расход всех вызовов, задачи, ходы, вызовы, workspace, модель, режим), main trace,
  постоянная панель текущей задачи справа (состояния, диапазоны ходов, токены, действия,
  полный `stop.why`), read-only история задач слева по `Ctrl-T`, activity, composer,
  pause/help overlay. Панели юнитов нет: `reading`/`session`/`observer` — внутренние адреса;
  история показывает только `task`.
- **View-model:** `src/tui/view_model.ts` — состояния из `move`, токены по turn-диапазонам из
  task-телеметрии, wall-clock из TUI store, исходы как факт (`open at`, `stop.why`,
  `cancelled at`). Header считает `Σ` по всем model calls (`usageTotals`), включая
  session-agent, поэтому расход виден и без запуска задачи; `ctx` — вход последнего вызова
  именно агента сессии, а не задачи, и не сумма (сумма больше окна, потому что контекст
  переотправляется каждый ход).
- **Markdown:** `marked` → спаны; `lowlight` подсвечивает код; `string-width` переносит по
  колонкам; таблицы, списки, blockquote, ссылки, inline-код. `theme.ts` — тёмная/светлая
  палитры, автоопределение по `COLORFGBG`, override `SKEIN_THEME=light|dark`. Заголовки и
  синтаксис приглушённые.
- **Файлы:** `src/tui/{app,panels,trace_lines,markdown,highlight,theme,view_model,run,types}`,
  `src/session/progress.ts`, `src/cli.ts`.
- **Тесты:** `tests/tui_app.test.tsx`, `tui_markdown.test.ts`, `tui_progress.test.ts`,
  `tui_view_model.test.ts`.
- **General-юнит:** `UnitType "general"` — один рабочий сегмент с той же IR-формой
  (`request → move(general) → plan → items → actions → observations → stop`), read-only
  инструменты `read`/`grep`/`list`; assistant-ответ хранится на stop-узле, `stop.why` — короткий
  итог. Операция `general` в session-агенте; routing: `respond` / `general` / `start`. Панель и
  история общие, отдельного окна нет. Файлы — `src/session/general.ts`, `src/llm/general.ts`;
  тест — `tests/general_unit.test.ts`. Существующие task/island-промпты не менялись.
- **Осталось:** `probe`/`fetch` в general; transcript
  viewer (`Ctrl-O`) с нативным scrollback/поиском, OSC 8 ссылки,
  copy-code, раскрытие tool-результатов, потоковый текст модели, mouse/изображения/Mermaid,
  персистентность сессии и выбор сессии, стоимость. Детали — `docs/plans/tui_plan.md`.

## Статус

- **4a реализован:** триггеры, минимальная сессия, `RequestObserver`, `hint`/`memo`/`halt`,
  инструменты обзора.
- **4b реализован:** статусы внимания, L0/L1, session-unit, операции `respond`/`start`,
  инструменты `read`/`unit`/`state`/`turns`/`body`/`search`, reading-unit, драйвер
  `runSessionTurn`, REPL, CLI.
- **4c реализован:** прерывание как пауза на границе шага, возобновление с журнала и отмена с
  полным откатом задачи из снапшота входа. Единообразно для агента сессии, задачи и
  наблюдателя; `AbortSignal` протянут через модельные адаптеры, обрыв модели не ретраится и не
  становится `llm_error`. В REPL: `Esc` — пауза, `Ctrl-C` — меню с `c`, повторный `Ctrl-C` на
  паузе — выход; меню `r`/`c`/`q`. Отмена задачи пишет `rollback` в журнал и предупреждает,
  если снапшота нет.
- **Снапшоты:** хранилище перенесено из `tests/sandbox/checkpoint.ts` в
  `src/tools/checkpoint.ts` без переписывания (hardlink-клон, дельта, кэш сигнатур), добавлен
  `restoreTree`; `fsWorkspace` получил опцию `checkpoints`, CLI чистит хранилище на границах
  сессии.
- **L0:** в агенте сессии больше не усекается (`truncate: false`); строки append-only;
  у session-unit фиксируются запрос, переформулировка и возврат.
- **Телеметрия:** `src/session/telemetry.ts` — usage, снимки контекста, model/tool calls,
  pause/resume/cancel, `usageTotals`/`unitStats`/`sessionSummary`/`contextTimeline`; CLI пишет
  в in-memory sink. Панели/UI нет.
- Typecheck чистый; офлайн-набор: **560 passed, 40 skipped**. Live/bench для 4c и TUI не запускались; general-live и session-live пройдены.
- **Синтетический live-сценарий пройден:** `read` — один ход; `body` по `obs:reading:1`;
  `respond`; затем `start` с переформулировкой, включающей правило; задача создала
  `Makefile`/тест и `make test` прошёл. `tasks=1, replies=2`.
- **Разделение инструментов (A, 2026-10-31):** у session-агента больше нет
  `read`/`grep`/`list`/`probe`; остались memory/outline (`unit`/`state`/`turns`/`body`/`search`)
  и операции `respond`/`general`/`start`. Чтение материала — general-unit, изменения — task.
  Старые `session-tools-live` и `session-research-live` удалены; их место заняла
  `general-live`.
- **Live-синта `general-live` пройдена:** анализ → `general`, coding task не открыт,
  general-unit прочитал 6 файлов (`list`/`read`), ответ Markdown с путями, `tasks=0,
  general=1, turns=4`.
- **Live-синта `session-live` пройдена на всех маршрутах:** «прочитай NOTES.md» → `general`
  (4 хода, `list`/`read`/`grep`), «какое там правило?» → `respond`, «создай Makefile/тест» →
  `start`; `routes=["general","respond","start"]`, `tasks=1, general=1, replies=1`.
- **Post-task report:** после `start` драйвер просит агента сессии написать Markdown-report;
  событие `report` пишется в тот же session-unit. Report — отдельная plain-комплита по
  детерминированному следу задачи, без инструментов.
- **View-слой:** `src/session/view.ts` показывает calls/results сессии, ходы задачи, answer и
  report. Результаты инструментов — preview 600 символов с `… [truncated; use --verbose]`;
  `--verbose` раскрывает полный результат и reasoning в блоке `Thought:` (как collapsed
  «Thought» в opencode).

## Что реализовано

### 4a

- `src/session/{types,session,triggers,observer,outline,apply}.ts`.
- Триггеры `budget`/`state_cycle`/`state_long`; observer-unit; `hint`/`memo`/`halt`.
- `SKEIN_OBSERVER`, пороги в `src/config/settings.ts`.

### 4b — память и сессия

- `src/session/types.ts`: unit-типы `task|general|observer|session|reading`; статусы внимания
  (`active|suspended|abandoned|completed`), `abandoned` зарезервирован и не порождается.
- `src/session/session.ts`: журнал сессии append-only, стек, `pending`, `utteranceSeq`,
  `attentionOf`; события `suspend|resume|abandon|operation|refusal`.
- `src/session/session_outline.ts`: L0/L1; L0 включает ответ/операцию, отказ и reasoning;
  для general — детерминированный trace действий (`read`/`grep`/`list`) и preview answer;
  reading-unit показывает полный размер.
- `src/session/session_memory.ts`: `state` (L2), `turns` (ходы + reasoning), `body` (L4),
  `search` (L4); `body` отклоняет не-наблюдения.
- `src/session/reading.ts`: standalone reading-unit, `read(path)`, preview + полный размер
  (`bytes`/`lines`) + адрес; session-агент его больше не создаёт (материал читает general).
- `src/session/session_agent.ts` + `src/llm/session_agent.ts`: bounded loop (12 ходов),
  reasoning, `surveyLimit`, memory/outline tools only (без workspace), текстовый ответ без tool
  call превращается в `respond`; ответы — GitHub-flavored Markdown до ~350 слов.
- `src/session/operations.ts`: `respond`, `general` и `start` (≤4000); отказ пишется в журнал
  сессии (`refusal`) и виден в L0.
- `src/session/driver.ts`: `runSessionTurn` — `respond`, `general` или `start`; general и task
  изолированы, контекст передаётся только текстом переформулировки.
- `src/session/repl.ts`, `src/cli.ts`, `npm run cli`.
- `src/loop/graph.ts`: `AgentInput.open` для открытия task-unit в существующей сессии.
- `src/session/session_workspace.ts`: read-only `SessionWorkspace` (`read`/`version`/`listFiles`/
  `grep`/`probe`) и форматтеры с окном/курсором. В session-agent не подключён: чтение материала
  делает general-unit через обычные task-инструменты `read`/`grep`/`list`.
- `src/session/general.ts` + `src/llm/general.ts`: general-unit (один `move(general)`, план,
  read-only `read`/`grep`/`list`, `stop`; assistant-ответ на stop-узле).
- `src/session/{types,session,session_outline}.ts`: событие `report` в журнале сессии и его
  след в L0.
- `src/session/driver.ts` + `src/llm/session_agent.ts`: post-task `report` (`SESSION_REPORT_PROMPT`,
  `modelSessionReporter`); trace = состояния задачи, изменённые файлы, исход, число ходов.
- `src/session/view.ts`: терминальный рендер `renderTurn` (calls/results, task/general moves/actions,
  answer/report, `--verbose` для reasoning); `src/session/repl.ts` реэкспортирует.

### 4c — прерывание, откат и телеметрия

- `src/abort.ts`: `isAborted`.
- `src/llm/{structured,session_agent,observer}.ts`: `abortSignal`; `usage`/`model` в
  `Proposals`/`SessionReply`/`ObserverReply`; обрыв не ретраится.
- `src/loop/{graph,state,propose}.ts`: `paused` в состоянии/результате, проверки на границе
  шага, `telemetry` в `AgentDeps`.
- `src/session/{session_agent,observer}.ts`: `signal`, `startTurn`, `paused`, `telemetry`.
- `src/session/driver.ts`: `paused` в `SessionTurnResult`, `resumeTurn`, `cancelTurn`, полный
  откат по снапшоту, событие `rollback`, запись pause/resume/cancel в телеметрию.
- `src/session/repl.ts`/`src/cli.ts`: режим паузы, меню, `Esc`/`Ctrl-C`, очистка снапшотов.
- `src/tools/{checkpoint,workspace}.ts`: `restoreTree`, опция `checkpoints`,
  `clearCheckpoints`; тестовый путь оставлен shim'ом.
- `src/session/telemetry.ts`: контракт и производные представления; `src/session/session_outline.ts`:
  L0 без усечения для агента сессии.
- `src/ir/{events,graph}.ts`: событие `rollback`.

### Тесты и сценарии

- `tests/session_attention|outline|operations|agent|memory|reading|workspace_tools|view|driver|repl|scenario.test.ts`.
- `tests/session_pause.test.ts`: пауза/возобновление/отмена задачи, сессии и наблюдателя,
  откат по снапшоту, предупреждение без снапшота, REPL-меню, классификация обрыва.
- `tests/telemetry.test.ts`: usage, снимки контекста, производные представления.
- `tests/checkpoint.test.ts`: `restoreTree` и точечное восстановление.
- `tests/sandbox/session-live.ts` — live-синта с подробным логом (general read, session
  calls/results, reasoning, task turns, `task answer`).
- `tests/sandbox/general-live.ts` — live-синта анализа: `general`, read-only инструменты,
  Markdown-ответ с путями, без coding task.

## Результаты live-прогонов

1. Первый: чтение через task (12–15 ходов), ответа на «какое правило» не было; выяснилось, что
   текстовый ответ модели выбрасывался, а `body` принимал неверные id.
2. Второй: лимиты 800 → 2000/4000, отказ и reasoning в L0. Чтение всё ещё через task;
   модель уходила в уточнения, `да` не подходило к вопросу.
3. Третий (после reading-unit и исправлений): `read` — один ход, `body` по `obs:reading:1`,
   `respond`; затем `start` с переформулировкой, включающей правило; задача создала
   `Makefile`/`tests/test_app.py`, `make test` — `exit 0`, `Ran 1 test … OK`. Файл
   `src/app.txt` не менялся (не требовался). `tasks=1, replies=2`.
4. CLI (`tsx src/cli.ts --dir …`): `list`/`grep`/`read` → Markdown-ответы; затем `start` →
   `task r1` и post-task `report` с разделами Changes/Verification/Caveat. Служебные строки
   `[n] move/stop` показываются только с `--verbose`; reasoning — тоже.
5. General (`general-live`): запрос «разбери по шагам, как устроен запуск задачи на
   бенчмарке» по мини-проекту → `general`, 4 хода, `list`/`read`, Markdown с путями; coding
   task не открылся.
6. CLI по копии репозитория: «как устроен post-task report» → `grep`/`list`/`read`, Markdown с
   путями и строками; task не открывался.

## Возможные типы unit'ов

Сейчас есть `task`, `general`, `session`, `observer`, `reading`. Новый тип оправдан, если у работы
свой корень и журнал, нужен отдельный след в L0 и адресуемые наблюдения, и она не сводится
к одному tool-call внутри session-unit'а.

| Кандидат | Зачем | Оценка |
|---|---|---|
| `search` / `list` | «где используется X», «что лежит в каталоге» | **сделано как tools** `grep`/`list`, без unit: один tool-call, снимок мира, тело вне ленты не нужно |
| `fetch` | URL → файл/наблюдение, внешняя документация | следующий кандидат в факт-unit, если нужен адресуемый источник |
| `command` / `check` | один запуск команды: версия, тест, проверка | не нужен: это Verification внутри `task`; сессия read-only |
| `job` | долгий процесс: start/poll/stop, свой журнал | не нужен: background уже в `task` |
| `review` | проверка diff/тестов и замечания | не unit: island внутри `task` |
| `delegate` | подзадача со своим журналом | отклонено: против non-goals «не строить субагентов» |

`probe` (окружение, пакетные менеджеры, интерпретаторы, material) — тоже **tool**, а не unit:
он отдаёт уже записанный `SessionProbe` по `kind` и кэшируется на сессию.

Виды работы внутри `task` (`orientation`, `research`, `patch`, `recovery`,
`construction`, `verification`, `end`) — это острова, а не типы unit'ов; новый «тип задачи»
не требует нового unit'а, а другого маршрута по островам.

## Наблюдатель для general — что попробовать

**2026-11-03:** general закрывается текстом; `general_stop` убран. Причина похода в
`tests/` — отсутствие `AGENTS.md` в контексте, а не отсутствие observer'а. Observer отложен
до систематики (стабильно 9–10 ходов / повторные чтения без новых наблюдений).

Сейчас `RequestObserver` подключён только к `task` (`src/loop/graph.ts`): триггеры
`state_cycle`/`state_long`/`budget`, task-лента, решение `hint`/`memo`/`halt`, запись в
журнал task. У general наблюдателя нет — только `generalMaxTurns` и финальный вызов без
инструментов. Идея: тот же механизм раз в N шагов смотрит ленту general и, если нужно,
вставляет system-сообщение; но для general есть отдельные проблемы.

**Что не подходит как есть:**
- `detectTriggers` (`src/session/triggers.ts`) заточен под task: `currentMove`/`moveIsland`/
  `stateEntries`. У general один `move` со state `general`, острова нет: `state_cycle` не
  срабатывает, `state_long` меряет ходы в move (дефолт 20 при `generalMaxTurns=9`), `budget`
  требует явного `maxTurns`.
- `alreadyFired` делает триггер one-shot на anchor. Для «каждые N шагов» нужен интервальный
  триггер (epoch/шаг), а не один раз за состояние.
- `defaultObserverTools` (`outline`/`state`/`turns`/`attempt`/`body`/`rendered`) — task-модель;
  general-лента собирается в `historyOf`/`messagesOf` (`src/session/general.ts`), там нет
  task-`outline`/`state`.
- `applyReaction` кладёт `hint`/`memo` в журнал, и task рендерит их через `advisoriesOf` в
  `project`; `runGeneralAgent.messagesOf` их не рендерит.
- `halt` для task завершает run (`observer_halt`). Для general это нарушило бы инвариант
  «state closed only by the doxa's `stop`»: нужен либо только `hint`/`memo`, либо `halt` →
  финальный вызов без инструментов, после которого doxa сама зовёт `general_stop`.
- Пауза/возобновление: observer-unit живёт в session (стек, `observerDepth`); в
  `resumeTurn` general-ветка observer не умеет. Нужно либо поддержать, либо не давать
  general-observer паузить run.
- Стоимость: observer — отдельный model call. «Каждые N шагов» должны быть ограничены
  (`surveyLimit`, `maxTurns`) и не запускаться на каждом ходу.

**Минимальный срез, который стоит попробовать:**
1. **Триггер `general_steps`.** Каждые N `apply`-действий (или ходов) в открытом general-unit;
   N=3–5, настройка. Детерминированный триггер пишется в session (`recordTrigger`), не зависит
   от модели. Считать действия, а не только ходы: проблема — именно число инспекций.
2. **General-observer tools:** `general_brief` (запрос/бриф), `general_actions`
   (action→observation с id), `general_render` (тот же `messagesOf` без system-хвоста),
   `general_body` (полное тело observation по id). Read-only, `surveyLimit` 2–3.
3. **Решение:** сначала только `continue`/`hint`; `memo`/`halt` — после проверки. `hint`
   обязан ссылаться на id действий/наблюдений, иначе это не факт, а мнение.
4. **Вставка:** `hint` — узел `hint` в журнале general (как task) и transient system-turn в
   `messagesOf` на следующем ходу; `memo` — до конца unit. Task-`project`/`buildMessages` не
   трогать.
5. **Инварианты:** observer не закрывает general; закрытие — только `general_stop`;
   `project` остаётся детерминированным; hint не попадает в task-ленту.
6. **Тесты:** фейковый observer — (a) `continue` → новых system-сообщений нет; (b) `hint` →
   следующий turn видит `Tape-agent hint: …`; (c) триггер ровно каждые N действий;
   (d) если включаем `halt` — финальный turn без инструментов, затем `general_stop`.
   Offline; live — только с go-ahead.

**Открытые вопросы:**
- Что считать шагом: ход general, `apply`-действие или новый observation? «Каждые 5 шагов» —
  от чего?
- Наблюдатель видит только бриф или и исходную реплику пользователя? Сейчас general-unit
  знает только бриф; исходная реплика есть у session/driver.
- Нужен ли `halt` для general, или достаточно `hint` «достаточно, отвечай»?
- Держать observer-журнал в session (как task) или это side-channel без unit? В TUI observer
  показывается кратко в статусе.
- Как observer понимает «надо поправить» без task-specific эвристик: повторные чтения,
  отсутствие нового знания, выход за бриф, преждевременная глубина? Промпт observer должен
  быть общим, решение — по ленте, не по имени задачи.
- Стоимость: один observer call каждые N шагов; сравнить на live с текущим `maxTurns` +
  финальным вызовом.

## Оставшиеся вопросы

- **`no_decision`.** Реализован: `empty_reply`/`max_turns` пишется в журнал сессии, виден в L0
  и в view (`session: no decision (…)`); unit остаётся `suspended`. Следующий шаг — отличать
  «модель ничего не сказала» от «упёрлись в cap» в политике (сейчас только reason).
- **Лимит исследования.** Вопрос по репозиторию упёрся в старый `maxTurns=6` и дал
  `session: no action`; поднято до 12, после чего тот же вопрос ответил за 6 ходов. Esc/Ctrl-C
  теперь реализованы, но cap остаётся предохранителем для headless/явного лимита; политика
  `empty_reply` vs `max_turns` — открыта.
- **Навигация по id.** Live показал ошибки `body(unit="reading")` и `body(id="reading:1")`.
  Описания и `body` уже исправлены; нужен повторный live-прогон, чтобы убедиться.
- **Подтверждение.** Заложено промптом (`respond` с формулировкой → `start`), но live-синта
  его не проверяет. Нужен сценарий с веткой подтверждения.
- **Ctrl-C/Esc.** Реализованы: `Esc` — пауза, `Ctrl-C` — меню с `c`, повторный `Ctrl-C` на
  паузе — выход. Меню текстовое, визуального выделения `c` нет. Live-прогон паузы,
  возобновления и отмены ещё не делался — нужен go-ahead.
- **Персистентность.** Сессия живёт в памяти процесса; `.skein/session.json` не реализован.
  Снапшоты чистятся на границах сессии; политика хранения/очистки внутри сессии — отдельно.
- **Стратегии возобновления.** Пауза/возобновление текущего unit'а работает; возобновление
  уже пройденного unit'а — новая задача с новой формулировкой, без копирования IR, отдельный
  срез. `revise` отложен.
- **`attempt` (L3), пины, `abandoned`, reading island.** Отложены.
- **L0 при переполнении.** L0 не усекается; если полный L0 превысит контекстное окно, нужен
  явный warning/error, а не усечение — пока не реализовано.
- **Стоимость.** Телеметрия собирает usage; счётчика стоимости, панели и live-meter ещё нет.
- **Снапшоты.** Включают `.git` и тяжёлые каталоги (кроме `.skein`/секретов); производительность
  приемлема, но политика хранения и стоимость на больших деревьях — открытый вопрос.
- **TaskAgent на первом ходу** видит только `move`/`decline` и каждый раз это осмысляет; это
  нормальное поведение state machine, но стоит проверить, не тратит ли оно ходы.

## Команды

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'
npm run cli -- --dir <project>            # TUI
npm run cli -- --dir <project> --plain    # old REPL
SKEIN_THEME=light npm run cli -- --dir <project>
```

Live (только с go-ahead):

```sh
SKEIN_LIVE=true npx tsx tests/sandbox/session-live.ts
SKEIN_LIVE=true npx tsx tests/sandbox/general-live.ts
```
