# Skein — тестирование на задачах

> Английское зеркало — `docs/task_testing.md`.
>
> Как проверять поведение на настоящих terminal-bench задачах: песочница без Harbor,
> Harbor, пошаговый прогон в контейнере и быстрая проба `bench/turn.ts`.
> Связанные документы: `docs/testing_ru.md` (слои проверки, гейты, метрики),
> `docs/state_testing_ru.md` (лента и состояния), `docs/live_step_ru.md` (драйвер live-step).

## 0. Что выбрать

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

## 1. Песочница без Harbor

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
- `setup` выполняется до агента; **verifier ставится после агента**, чтобы `test.sh` не утёк
  в workspace: `checkIn:"task"` — файлы тестов пишутся в контейнер, `checkIn:"host"` —
  отдельный verifier-контейнер (`SKEIN_VERIFIER_IMAGE`, по умолчанию `fix-code`): `/app`
  стримится task→verifier tar-пайпом, тесты — `docker cp`; host-копии `/app` нет;
- `checkSetup` (например, пересборка OCaml) выполняется перед verifier;
- checkpoint-слой (`CheckpointBackend`; `HostBackend` для bwrap/virtual, `DockerBackend` для
  Docker) даёт read-only снапшоты и revert проваленного Patch;
- `runTask`/`openTaskWorkspace` (`tests/sandbox/harness.ts`) — общий setup для полного
  прогона и пошагового драйвера; для Docker — rootless-путь.

Полезные поля `SandboxTask`: `image`, `workdir`, `mountPoint`, `setup`, `check`,
`checkIn` (`"task"`/`"host"`), `checkSetup`, `maxTurns`, `network`.

### Полный прогон

```sh
npx tsx tests/sandbox/sandbox-run.ts <task-id> [--turns N] [--net on|off]
```

- без `--turns` берётся `task.maxTurns` (например, 60 у `fix-ocaml-gc`), иначе 24;
- `--net off` (рекомендуется) закрывает **хостовый** `fetch` allowlist-прокси (только API
  модели); `run`/jobs в rootless D идут в контейнере. Контейнер задачи остаётся
  `--network none`, если задача не задала `network`;
- каждый прогон пишет `bench/runs/sandbox-tasks/<ts>-<id>-<random>/` (уникальный суффикс —
  параллельные прогоны не делят каталог): `contexts.ndjson`, `result.json`, `metrics.json`,
  `reward.txt`, `reasoning.ndjson`;
- `reward=1` — verifier задачи прошёл; `stop=request_addressed` — движок закрыл запрос;
- для диагностики: `SKEIN_TIMINGS=1` печатает `capture`/`model` timing,
  `SKEIN_TRACE_ACTIONS=1` — аргументы действий.

### Оффлайн-проверка задачи (без модели)

```sh
# no-op → 0, solution/solve.sh → 1; Docker + verifier, без модели
SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts
# медленный fix-ocaml-gc (пересборка), по запросу
SKEIN_SLOW_TASKS=1 SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts -t fix-ocaml
```

Это **не** «бесплатные» тесты: они поднимают контейнеры и образы. Запускать осознанно.

### Виртуальная спека

`tests/sandbox/specs/fix-ocaml-gc.ts` — миниатюрная копия задачи с эмулированными
`make`/testsuite, без Docker и сети:

```sh
SKEIN_LIVE=false npx vitest run tests/sandbox/fix-ocaml.test.ts
SKEIN_LIVE=true npx tsx tests/sandbox/live-trace.ts
```

`live-trace.ts` пишет `bench/runs/sandbox-live-<ts>-fix-ocaml-gc/` и годится для формы
траектории, но не для reward реальной задачи.

### Opencode baseline

```sh
npx tsx tests/sandbox/opencode-run.ts <task-id> [--net on|off]
```

Тот же образ и verifier, другой агент. Трасса: `opencode.txt`, `metrics.json`,
`api-requests.ndjson`, `api-responses.ndjson`, `contexts.ndjson`, `reasoning.ndjson`.

## 2. Harbor

Harbor — официальный runner terminal-bench. Он запускает задачу целиком (среда, агент,
официальный verifier) в Harbor-джобе и нужен для **официальной приёмки** и сравнения
агентов, а не для пошаговой отладки.

```sh
bash bench/harbor/run.sh
# сравнение Skein vs opencode
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

## 3. Пошаговый прогон в контейнере

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

## 4. Быстрая проба: `bench/turn.ts`

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

## 5. Вспомогательные инструменты

- `bench/rollout.ts <run> [--turns N] [--dry]` — строит **свежую** ленту текущей проекцией
  и катит модель вперёд; наблюдения берутся позиционно из записи. Это decision replay, не
  среда.
- `bench/replay.ts <trace-or-scenario> [--limit N] [--offset N]` — те же записанные контексты
  через живую модель.
- `bench/minimal.ts` — no-IR микро-агент (4 сообщения) для A/B хинтов.
- `tests/live/*` — живые сценарные/шаговые тесты (`SKEIN_LIVE=true`), см. `docs/testing_ru.md`.
- `bench/gate.ts` + `baseline.json` — регрессионный gate по метрикам.

## 6. Что читать в трассе

`metrics.json` (`tests/sandbox/metrics.ts`):

- `in` = `freshInput` + `cacheRead`; `out` = `visibleOutput` + `reasoningTokens`;
- `cacheHitRatio`, `costRub`, `contextChars` (`first/last/peak`);
- `perTurn`: `operator`/`tool`, `chars`, `llmCalls`, токены, `refused`.

`contexts.ndjson` — проекция/сообщения по ходам; `result.json` — `stopReason`, `reward`,
verifier и журнал IR; `reward.txt` — вердикт.

## 7. Правила

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

## 8. Шпаргалка

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'

# полный прогон задачи (Docker + verifier)
npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --net off --turns 60

# пошагово, с паузами
npx tsx bench/live-step.ts fix-ocaml-gc --net off --dir /tmp/opencode/loc
touch /tmp/opencode/loc/continue

# быстрый A/B записанного хода
npx tsx bench/turn.ts <run> --list
npx tsx bench/turn.ts <run> --turn 8 --dry
npx tsx bench/turn.ts <run> --turn 8 --repeat 3
npx tsx bench/turn.ts <run> --turns 6-8 --rebuild --append-system "..."

# официальная приёмка / сравнение
bash bench/harbor/run.sh
SKEIN_HARBOR_CONFIG=compare.yaml bash bench/harbor/run.sh
npx tsx bench/agents_compare.ts ~/.skein-bench/harbor/<job>
```

## 9. Если что-то не работает

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
- **Verifier видит свой `test.sh`?** — он ставится только после агента
  (`stageVerifierInContainer` для `checkIn:"task"`, verifier-контейнер для `checkIn:"host"`);
  если правишь harness, не переносить staging до прогона.
- **Контейнер остался** — `docker ps | grep skein`, затем `docker rm -f <name>`; штатно
  `cleanupContainers()` делает это сам.
