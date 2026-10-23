# Handoff — session 9: container-native D, checkpoint backend, verifier container (2026-10-23)

> Рабочий документ для следующей сессии. Русский, без EN-зеркала; фиксирует состояние
> working tree после сессии. Изменения **не закоммичены**. База — `8dc3102` и handoff
> `handoff_2026-10-23_state_layer_reasoning_ru.md`.

## 1. Цель сессии

Довести **D** до конца: file-tools, checkpoint, jobs, verifier и вспомогательные операции
должны исполняться в контейнере задачи, без копирования `/app` на хост. По пути был найден и
исправлен реальный источник «пятиминутных шагов» — не Docker/провайдер, а `signatureMap`.

## 2. Главная находка: 5 минут на `apply bash`

`src/tools/index.ts::signatureMap` перед каждым `apply bash` (и после) вызывал
`workspace.signature(path)` **на каждый файл** из `workspace.list()`. В rootless Docker это
отдельный `docker exec stat` на файл. У `crack-7z-hash` 2673 файла → `2673 × 2 × ~100 мс`
≈ 5 минут на действие. Модель и контейнер были не при чём: контейнер idle, сырые команды
0.06 с.

Исправление:

- `Workspace.signatures?(paths)` — батчевый вариант (`src/tools/workspace.ts`);
- `fsWorkspace` — обычный цикл по `statSync`;
- `signatureMap` использует батч, если он есть;
- `dockerWorkspace` — один `xargs -0 stat -c '%n\0%y\0%z\0%s\0'` на всё дерево
  (`tests/sandbox/docker.ts`).

Проверка offline (scripted replay, без модели): `none`, `a1`, `a2`, `both` завершаются;
`capture` 77–94 мс; t3 `apply` больше не блокирует.

## 3. Checkpoint: backend + Docker store

`tests/sandbox/checkpoint.ts` разложен на:

- `CheckpointBackend` — `scan/hash/writeTree/restore`;
- `HostBackend` — прежний `fs`-код; `createCheckpoint(root)` остаётся для bwrap/virtual/offline;
- `createCheckpointWithBackend(backend)` — общий алгоритм (signature cache, manifest hash,
  content-addressed objects, trees, tokens);
- `tests/sandbox/checkpoint-docker.ts` — `DockerBackend`:
  - `scan` — один `find /app … -printf` с NUL-полями;
  - `hash` — `xargs -0 sha256sum` только для изменившихся;
  - `writeTree` — сгенерированный bash-скрипт `cp`/`ln`/`mkdir` в `/tmp/.skein`;
  - `restore` — `cp -a` + `sha1sum`;
  - store — `/tmp/.skein` в контейнере; `/app/.skein/checkpoints -> /tmp/.skein`.

`HostBackend`/checkpoint-тесты: `tests/checkpoint.test.ts` — 5/5.

## 4. Rootless Docker (D)

`tests/sandbox/docker.ts`:

- `DockerOptions.rootless` — контейнер стартует прямо из образа; **нет** `tar | tar` в
  host temp-root и **нет** `-v root:/app`;
- все file-tools (`read/write/exists/version/signature/applyPatch`), `grep/list/listFiles`,
  `run`, `startJob/pollJob`, `fetchTo` — через `docker exec`;
- `signatures` — батчевый `stat`;
- `root` в rootless — display `/app`; host temp-root пустой (для интерфейса);
- `startJob` — `docker exec -d` + логи/exit-code в `/tmp/.skein/jobs`; `pollJob` — ожидание
  code-файла/хвосты;
- `fetchTo` — host fetch (allowlist/constraints) во временный `.skein` файл, затем запись в
  контейнер;
- `cleanupContainers` больше не нужен mount для `/app`; контейнер удаляется.

`tests/sandbox/harness.ts`:

- для Docker (`task.image` и `stageSolution !== true`) `openTaskWorkspace` идёт в
  `openRootlessTask`:
  - request/check читаются из Harbor cache; `/app` не материализуется;
  - `task.files` пишутся в контейнер; `setup` — `workspace.run`;
  - checkpoint — `createCheckpointWithBackend(new DockerBackend(container))`;
- `checkIn:"task"` — тесты пишутся в контейнер (`stageVerifierInContainer`);
- `checkIn:"host"` — **verifier-контейнер** (`runVerifierCheck`):
  - `/app` стримится task→verifier tar-пайпом;
  - тесты — `docker cp`;
  - образ по умолчанию `alexgshaw/fix-code-vulnerability:20251031` (Python 3.11 + git),
    переопределяется `SKEIN_VERIFIER_IMAGE`;
  - host-копии `/app` нет.
- `stageSolution` (`tests/sandbox/tasks.test.ts`) пока идёт старым host-root путём — это
  offline-тест, не live.

## 5. Прочее

- `tests/sandbox/live.ts`: trace-dir создаётся `mkdtempSync` (случайный суффикс) — параллельные
  прогоны больше не делят каталог; `SKEIN_TIMINGS=1` печатает `capture/model`,
  `SKEIN_TRACE_ACTIONS=1` — аргументы действий.
- `src/ir/islands.ts`: Recovery hint дополнен environment-repair:
  «если нужного инструмента нет в PATH — починить окружение (package manager/network), а не
  переписывать стандартный инструмент».
- Проверялись и **откачены** (не повторять без новой гипотезы): R1 «enough to stop» (полный
  password → reward 0, неверный split), полный content rewrite stop, аддитивный
  `mark unverified` (stop чаще ломался); см. `docs/state_testing_ru.md` §6.

## 6. Результаты

| прогон | ходы | cost | reward/stop | trace |
|---|---:|---:|---|---|
| crack rootless + fix | 24 | 2.000₽ | 1 / request_addressed | `2026-10-23T15-10-44-954Z-crack-7z-hash-OYmijI` |
| db-wal rootless K=2 #1 | 13 | 0.880₽ | 1 / request_addressed | `2026-10-23T14-29-15-642Z-db-wal-recovery-648Tka` |
| db-wal rootless K=2 #2 | 24 | 2.501₽ | 1 / max_turns (шумный сэмпл) | `2026-10-23T14-23-25-904Z-db-wal-recovery-sJFnMA` |

- crack rootless — после фикса; 5-минутных apply нет.
- db-wal #2 — model variance (WAL/checksum rabbit hole), не D.
- Прямые тесты: verifier-контейнер `PASS`; jobs short `done/0`, long `running`.
- `npm run typecheck` — ok.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **363 passed, 40 skipped**.
- `tests/checkpoint.test.ts` — 5/5.

## 7. Что осталось

1. **bwrap D.** Задачи без образа (`regex-log`) пока на host-root/file-tools; `/tmp` —
   per-invocation tmpfs. Нужен либо долгоживущий namespace, либо shared `/tmp` mount.
2. **`stageSolution`** (offline `tasks.test.ts`) — старый host-root путь; live D не затронут.
3. **Verifier image.** `SKEIN_VERIFIER_IMAGE` по умолчанию `fix-code`; если конкретному
   `checkIn:"host"` чекеру нужен отсутствующий инструмент — задать образ/доставить.
4. **`fetchTo`** реализован, но прямым URL-тестом не проверен.
5. **Model variance / watchdog.** 5-минутный signatureMap побеждён; провайдерский стрим всё
   ещё может зависнуть без таймаута. `SKEIN_TIMINGS`/`SKEIN_TRACE_ACTIONS` помогают; watchdog
   (`AbortSignal.timeout`, `SKEIN_LLM_TIMEOUT_MS`) не сделан.
6. **Старые handoff-файлы** session2–5 остаются untracked (`docs/plans/handoff_2026-10-20_*`,
   `2026-10-21_*`); решение за владельцем.

## 8. Файлы сессии

- Код: `src/tools/workspace.ts` (`signatures`), `src/tools/index.ts` (`signatureMap`),
  `src/ir/islands.ts` (Recovery hint).
- Sandbox: `tests/sandbox/checkpoint.ts`, новый `tests/sandbox/checkpoint-docker.ts`,
  `tests/sandbox/docker.ts`, `tests/sandbox/harness.ts`, `tests/sandbox/live.ts`.
- Тесты: `tests/checkpoint.test.ts` (проходят), `tests/prompt.test.ts` (без изменений).
- Доки: `docs/task_testing*`, `docs/state_testing*`, `docs/live_step*`, `docs/testing*`,
  `docs/states_ru.md`, этот handoff.

## 9. Быстрые команды

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'
SKEIN_LIVE=false npx vitest run tests/checkpoint.test.ts

# полный прогон (Docker; rootless D)
npx tsx tests/sandbox/sandbox-run.ts crack-7z-hash --net off --turns 40

# диагностика фаз/аргументов
SKEIN_TIMINGS=1 SKEIN_TRACE_ACTIONS=1 npx tsx tests/sandbox/sandbox-run.ts <task> --net off --turns N

# verifier-образ (если нужен другой)
SKEIN_VERIFIER_IMAGE=alexgshaw/fix-code-vulnerability:20251031 npx tsx tests/sandbox/sandbox-run.ts <task>
```
