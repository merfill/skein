# Skein — handoff: state prompts, db-wal, workspace checkpoint (2026-10-18)

> Рабочий handoff для следующей сессии. Русский, без EN-зеркала: это не канонический документ
> и он не индексируется в `docs/README.md`.
>
> Читать первым. Дальше — `git show 7b59d53` (все изменения этой сессии **закоммичены**),
> `docs/state_testing_ru.md` (§2.5 — replay с seed/startTurn; §5 п.4 — meta-сомнение),
> `docs/ir_semantics.md` §5/§7/§8, `docs/session_concepts_ru.md` (закоммичен в `f3b6adb`).
>
> **Новее:** `docs/plans/handoff_2026-10-18_session2_ru.md` — восемь состояний, live
> password-recovery, незакоммиченные изменения. Этот файл — исторический контекст.

## 0. TL;DR

> **Синхронизировано 2026-10-18 после `7b59d53`.** Всё, что ниже было «незакоммичено», вошло в
> этот коммит; offline-сьют зелёный; workspace checkpoint из §5 реализован и обкатан на
> terminal-bench breadth (`docs/benches/best_bench_ru.md`, батч 2026-10-18). Исторические
> tape-эксперименты §3 оставлены как есть; статусы обновлены в §0, §1, §5–§9.

1. Мы обобщили четыре состояния (`orientation`, `localization`, `patch`, `verification`), не добавляя
   новых островов. Цель — чтобы они работали и на fix-ocaml-gc, и на password-recovery/db-wal,
   и не заставляли модель искать несуществующий code-fix.
2. Главная находка: **opencode тоже удаляет WAL** (`sqlite3 main.db` → checkpoint → WAL gone), но
   **восстанавливает его из своего git-снапшота** (`snapshot/global/...`, `core.worktree=/`).
   Skein такого снапшота не имел; модель теряла файл и в итоге **фабриковала** данные. Теперь
   Skein закрывает это workspace checkpoint (§5).
3. **Workspace checkpoint реализован** (`tests/sandbox/checkpoint.ts`): content-addressed store +
   hardlink-деревья под `<root>/.skein/checkpoints`, initial + per-turn + pre-patch, read-only bind
   в контейнер; revert восстанавливает изменённые Patch пути. Это, а не read-only workspace,
   переживает случайное удаление/`bash`-мутацию.
4. Промт-правки (маркеры, provenance, state-specific tools) полезны, но **не возвращают файл**;
   они делают failure честным, а не fake pass.
5. Offline-тесты **зелёные** (`346 passed`, 6 файлов skipped), `typecheck` зелёный. Промт,
   checkpoint и breadth-бенч закоммичены в `7b59d53`.

## 1. Состояние рабочего дерева

Последний коммит: `7b59d53 Workspace checkpoint/revert; generalized states; breadth bench`.

Рабочее дерево чистое; единственный untracked-файл — этот handoff. Всё, что в исходной версии
было перечислено как незакоммиченное (промт/проекция, marker A, state-specific tools, harness
opencode/параллельность), вошло в `7b59d53` вместе с checkpoint/revert и breadth-бенчем.

- `npm run typecheck` — зелёный.
- Offline-сьют — зелёный: **29 файлов passed / 6 skipped**, **346 тестов passed / 40 skipped**
  (`SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'`).
- Offline-фикстуры обновлены под marker A и новые формулировки; отдельного долга по ним нет.

## 2. Что и зачем изменено в промте

> Всё описанное в §2 (включая marker A и state-specific tool contract) вошло в `7b59d53`.

### 2.1 Четыре состояния, без новых островов

Пользователь явно отверг `recover`/`transform`/`produce`/`enumerate` и профили: это костыли под
конкретную задачу. Семантика остаётся: **orient → locate → change → check**. Конкретику несут
`what`/`done`/`notes`, которые doxa пишет на `move`.

- `orientation`: «map the material and how success is judged»; критерий — что существует, как судится
  успех (команда / внешний verifier / объявленные ограничения), VCS при необходимости; instruction —
  осмотреть материал, не охотиться за целью, не воспроизводить сбой; hint — root через `pwd`, что
  существует и как судится.
- `localization`: «find the target in the material»; критерий — цель названа (file/record/image/
  function) с координатами/extent, siblings исключены; instruction — найти цель и отличить от
  siblings (файлы/записи/циклы/кандидаты), различие в shape/advance/encoding/bytes — сигнал;
  hint — назвать цель+координаты и почему siblings не она; когда названо — `stop`, не доказывать.
  `next` — «the target is named and its siblings are ruled out».
- `patch`: «make the change the goal names»; критерий — «the change is made **from the located
  material** and its result has the declared form»; instruction — применить located change, проверить
  форму в том же шаге; hint — только цель, не повторять failed attempt, проверить форму своего
  результата, **не синтезировать** значения/артефакты.
- `verification`: «check the change against the goal's acceptance»; критерий — acceptance command
  проходит **или** объявленные ограничения держатся, **и результат выведен из source material, не
  синтезирован**; instruction — acceptance-команда, если есть, иначе ограничения; hint — если
  провал: `patch`, когда located object ещё держится и ошибка в change/result; `localization` только
  когда объект не найден/указывает на другой; **a failing acceptance ≠ wrong localization**;
  a check, читающий только свой output, — не acceptance; сравнить с source; не принимать
  synthesized data.
- `next`/transition-условия обновлены под эти формулировки.

### 2.2 Правило перехода — в `transitionInstruction`, а не в hint'е состояния

Ключевой урок: hint `verification` **не виден на transition-ходу** (там `transitionInstruction`).
Правило «после failed acceptance по умолчанию Patch; Localization только если failure указывает на
другой объект» добавлено в `src/loop/prompt/blocks.ts` (`transitionInstruction`, только при
`island === "verification"`).

Отдельно: объектная рамка (file/record/image/function) — это то, что отличает «ошибка в change/
result (value/length/format/span/assembly)» от «другой объект». Без неё модель уходила в
re-localization.

### 2.3 Plan/working invariant: preserve material

В `MOVE_BLOCKS` (plan) и `turnInstruction` (working) добавлено:

> «Inspection must not consume or rewrite the material: copy raw artifacts before any command that
> may checkpoint, delete, or rewrite them, and prefer read-only modes.»

Это общий инвариант, не state-specific hint. Он частично сработал: на plan-ходе db-wal две бывшие
фейловые ленты стали делать `cp main.db main.db-wal` до чтения (см. §4.3), но не детерминированно.

### 2.4 Маркеры состояния: provenance (вариант A)

`src/ir/project.ts`:

- `Start state <label>` — теперь `role: "system"` (было `assistant`);
- `Finish state <label> — <why>` — теперь `role: "system"`, текст
  `Finish state <label> — your stop reason: <why>`;
- `closureLine` обновлён; комментарии «ai: state marker» → «system».

Причина: модель принимала маркеры за свои реплики («I said “Finish state Orientation”…», «the
previous states said “Finish”, but I don't see any tool calls… the context is compacted»). Маркер —
событие движка; `why` — утверждение доксы, поэтому атрибутируется.

### 2.5 State-specific tool contract (`toolDescriptionsFor`)

`src/llm/tools.ts`:

- `bashDescriptionFor(island)`: inspection-состояния (orientation/localization/verification) получают
  read-only/preserve контракт **первым в описании**; patch — targeted change; без island — глобальный
  текст.
- `toolDescriptionsFor(island)`:
  - `bash` — state-specific;
  - `webfetch` — inspection: «omit `path`, engine-owned ref; do not create files in the work tree»;
    patch: «`path` только для артефакта цели; never overwrites»;
  - в `patch` также `edit` («only the target; no raw artifacts/unrelated files»), `write` («only the
    artifact; do not overwrite source/raw; prefer edit»), `apply_patch` («only the goal's diff; no
    deletions/renames outside the goal»).
- База `webfetch` уточнена: с `path` — в workspace, без — в engine-owned ref; существующий path
  отклоняется.
- `stop` description: вместо «do not verify to be sure» — «strong suspicion is enough for the
  diagnosis; do not re-verify the diagnosis; checking the form… is part of the change. A form check
  is not provenance: the result must come from the source material; do not synthesize it to satisfy
  a form.»
- `src/llm/structured.ts`: `ToolsOptions.toolDescriptions`; `proposalTools(names, descriptions)`
  подменяет description по имени.
- Прокинуто в `src/loop/propose.ts`, `bench/turn.ts`, `langgraph/graph.ts`.

### 2.6 Provenance/honesty rule

Добавлено:

- в base prompt B4 (`src/loop/prompt/blocks.ts`): «The change must come from the located material.
  Do not synthesize, invent, or reconstruct values or artifacts to satisfy a count, a form, or an
  expected answer. A check that only reads your own output is not acceptance: compare against the
  source material.»
- в `patch`/`verification` criteria/hints (`src/ir/islands.ts`) — см. §2.1;
- в `stop` description (`src/llm/tools.ts`) — см. §2.5.

## 3. Tape-эксперименты: метод и результаты

### 3.1 Метод

- `npx tsx bench/turn.ts <run-dir> --turn N --rebuild --repeat K [--reasoning]`.
- `--rebuild` использует **записанную `history`**; текущий код перерисовывает state description,
  criterion/hint и хвостовую инструкцию, но **не** перерисовывает `instruction` острова, записанную
  при входе в состояние, и **не** меняет роли маркеров. Для marker A/B нужен temp-trace с
  изменёнными ролями/текстом (или пере-проекция IR через `fold(events)` → `project` → `buildMessages`).
- Смотреть `reason=` (hidden reasoning tokens), `out`, `in` и **содержание** reasoning. Рост токенов
  сам по себе ≠ смятение (см. §3.4).

### 3.2 Orientation (5 лент fix-ocaml, 5 password, 5 crack; pre/penultimate/decision, K=3)

| задача | старый pre / penult / decision | новый pre / penult / decision |
|---|---|---|
| fix-ocaml | 0/15 / 4/15 / 10/15 | 0/15 / 5/15 / **11/15** |
| password | 0/15 / 2/9 / 10/15 | 0/15 / 1/9 / **12/15** |
| crack | 0/12 / 1/12 / 7/12 | 0/12 / **7/12** / **10/12** |

- pre = 0 везде: ложных ранних закрытий нет.
- Главный выигрыш — crack: старый `why` ориентации был «Repo root is /app (John the Ripper checkout…
  built/checked)», новый — «Mapped /app: … plus the target archive /app/secrets.7z; success is
  judged by /app/solution.txt …». Практически: code-repo-центричность ушла.
- Request-ход crack: old и new replay дают 15/15 `move` в orientation, 0 decline (записанный decline
  на ленте не воспроизводится; вероятно, стечение/старый localization-текст). Не утверждать, что
  decline «починен»; регрессии нет.

### 3.3 Localization (5+5 лент, pre / penultimate / decision, K=3)

| задача | старый | новый |
|---|---|---|
| fix-ocaml decision | 11/15 | 14/15 |
| password decision | 15/15 | 14/15 |
| fix-ocaml penult | 3/15 | 3/15 |
| password penult | 3/15 | 4/15 |

- Decision-закрытие на fix-ocaml улучшилось (11→14/15), ложных pre-стопов нет.
- Пере-вычитывание (penultimate) **не побеждено**: 3/15 → 3/15 (fix), 3/15 → 4/15 (password).
  Это disposition, текст его не лечит (совпадает с `state_testing` §5).
- `why` в стопах называет цель/координаты/siblings; old/new hit-rate не ухудшился.

### 3.4 Маркеры A/B (db-wal fail `11-08-17-180`, t5/t28, K=3)

- t5 (plan Localization): old reason 0/6/6 = 12, new 0/0/0 = 0; оба безопасны (`ls`/`list`).
  Записанное «I skipped Orientation» replay не воспроизводит.
- t28 (plan Verification): old 92/45/37 = 174 и **state-сомнение**:
  «Wait — did I actually perform the patch? The conversation shows only state transitions… The tape
  is compressed…»;
  new 0/40/165 = 205 **без** state-сомнения: #0 сразу `mode=ro` + `db matches json`; #1/#2
  «careful… copy first», #2 цитирует preserve-правило и копирует db+wal в `/tmp`.
- Input почти не изменился (2917→2912, 3173→3164). `out` вырос из-за более длинных команд проверки.
- **Вывод:** marker A убирает state-сомнение; рост `reason` на +31 — это verification detail, не
  смятение. Смотреть на содержание.

### 3.5 Provenance A/B (db-wal fail, t22/t23/t29, K=3)

- t22: old #2 **строит синтетический WAL** (`cp main.db → build.db`, вставляет 6 записей, делает WAL).
  new #0–#2 **не строит**: ищет источник и цитирует «do not synthesize» / «The change must be derived
  from the located material».
- t23: old/new ищут; новый цитирует правило; fabrication нет.
- t29: old/new проверяют db+wal; новый явно подозревает JSON: «names in JSON are fruits — possibly
  synthesized? I need to actually recover from WAL and compare».
- reason: t22 5540→5758, t23 2808→3148, t29 329→409; in +~100/ход (текст правила). Рост — это
  provenance-конфликт/поиск, не старое state-смятение.
- **Вывод:** правило запрещает fake pass, но при потерянном источнике модель застревает в поиске.
  Нужно правило **честного стопа**, если source отсутствует (см. §6.2).

### 3.6 Transition Verification→Patch (password/fix-ocaml)

- password t23 (реальный записанный `why`): old 2/3 patch (1/3 localization); после правила в
  `transitionInstruction` — **6/6 patch** (K=6).
- password t23 с новым self-consistent `why` — 8/8 patch (K=8).
- fix-ocaml t32 (тот самый 1/5 фейл): без правила 0/6 patch (6/6 localization); с правилом
  **5/6 patch**, 1/6 localization (K=6).
- позитивный контроль fix-ocaml t36 (там уже был Verification→Patch): 6/6 patch.
- **Вывод:** правило должно стоять на transition-ходу; hint состояния там не виден.

### 3.7 Live-прогоны (sandbox, net on, 40 ходов)

> Исторический срез: прогоны **до** workspace checkpoint. Итоговые результаты с checkpoint/revert
> и breadth по задачам — `docs/benches/best_bench_ru.md`, батч 2026-10-18 (db-wal, log-summary,
> cobol, fix-code, password — 5/5; crack — 3/3 завершившихся; fix-ocaml — 4/5).

- 55 прогонов, **старый** промт, 24 хода: 41/55. Фейлы: `crack-7z-hash` 0/5, `cobol-modernization`
  2/5, `db-wal-recovery` 3/5, `fix-code-vulnerability` 3/5, `log-summary-date-ranges` 4/5,
  `password-recovery` 4/5. 5/5: `fix-git`, `git-leak-recovery`, `modernize-scientific-stack`,
  `openssl-selfsigned-cert`, `regex-log`. `custom-memory-heap-crash` не гонялся.
- 10 прогонов, новый промт (на тот момент), 40 ходов: `fix-ocaml-gc` 4/5 (1 фейл — 40-ходовой
  бюджет; новый переход в Patch сработал), `password-recovery` 5/5.
- **db-wal** 5×40 новый промт: **4/5**, 7.61₽, 2.7 мин. Фейл `11-08-17-180` (33 хода,
  request_addressed): на t6 `sqlite3 main.db ".tables"` удалил WAL; t11 «No WAL file exists. My
  diagnosis was wrong»; t22 «I must guess…»; t23 синтетический WAL; верификатор упал на
  `id1=150`, `id2=250` (WAL updates не применены). Модель знала, что гадает: t29 «values from
  guesses… possibly synthesized… Doesn't matter for acceptance» → fake pass.
- Успешные 4 db-wal копируют WAL рано (t5/t8/t10/t11) и читают read-only; фейл копирует только
  на t23, после потери.

### 3.8 Tokens / reasoning (db-wal)

Current 5×40: **1.221M in** (fresh 158k + cache 1.063M, hit **87.1%**), **61.2k out**,
**42.5k reasoning**, **7.61₽**, 2.7 мин.
Previous 5×24 (старый промт): 541k in (fresh 96k + cache 444k, hit 82.2%), 40.6k out, 28.6k
reasoning, 4.80₽.

По прогонам current:
- быстрые успешные (22/25/28 ходов): 81–103k in, 3.4–4.0k reasoning, 0.83–0.96₽;
- фейл (33): 252k in, 11.0k reasoning, 1.78₽;
- `max_turns` успешный (40): 682k in, 20.4k reasoning, 3.08₽.

Рост сконцентрирован в фейле и 40-ходовом over-work; быстрые успешные по reasoning близки к
прежним, но input/ход выше из-за state/tool-описаний (самое длинное — `bash`). 40-ходовой лимит
позволяет дорогой over-work. Offline offline.

## 4. Ключевая находка: opencode-снапшот

Opencode **тоже удаляет WAL**:
- s1: `sqlite3 main.db "PRAGMA journal_mode; SELECT * FROM sqlite_master;"` + `SELECT * FROM items;`;
- s2: `PRAGMA wal_checkpoint; PRAGMA integrity_check;`
- s3/s4: «the WAL file disappeared? Maybe the first sqlite3 call checkpointed it and deleted it»;
  «my query caused the WAL to be deleted… might have destroyed the data».

Но у него есть **снапшот worktree**:
```
.../xdg-data/opencode/snapshot/global/42099b4af021e53fd8fd4e056c2568d7c2e3ffa8/
  config: [core] worktree = / ; bare = false ; ...
  HEAD: ref: refs/heads/master
  lost-found/other/5dda2fd81615e4587614d0d2a5547ede27d5aec7
  objects/...
```
Модель:
- s10: «opencode takes snapshots of the working directory… the WAL file might be in the git objects!»;
- s14: `git cat-file -p b218b56… > /app/main.db-wal`;
- s17–s18: XOR 0x42 → 11 записей (включая updates) → `recovered.json`.

**Почему opencode это делает:** это его checkpoint/undo/revert-слой (snapshot/diff/rollback), часть
продукта; Harbor-адаптер складывает XDG-data под `/logs/agent/opencode`, поэтому агентский `bash`
может прочитать snapshot. Модель использовала его оппортунистически, не по дизайну.

**Почему Skein не может:**
- sandbox root — временный корень из образа; shadow-git/снапшота нет;
- IR хранит версии, не тела блобов (`ir_semantics` §5): блобы живут в workspace;
- trace хранит проекции и окна tool-выводов, не полный WAL;
- `revert` — только последний `edit`; `bash`/удаления вне tracked-инструментов;
- `.skein` — harness/verifier, не vault; в образе db-wal нет `.git`/snapshot.

**Кто ещё это делает:** Cline/Roo Code — «Checkpoints» через shadow Git; Claude Code —
checkpoints/rewind; Cursor — checkpoints; opencode — snapshot/undo; Aider — git-native
auto-commit/undo; OpenHands — sandboxed runtime/state; Devin/Replit — snapshots/rollback.
Бенчмарки (OSWorld/WebArena) используют VM snapshots для сброса. В академических papers (SWE-agent
ACI, OpenHands) snapshot — infra-деталь, не главный результат; это не «конкуренты прячут».

**Итог:** разрыв закрыт в `tests/sandbox` собственным checkpoint-хранилищем (не git-снапшотом);
см. §5.

## 5. Реализованный workspace checkpoint

**Не read-only workspace.** Остаётся checkpoint: read-only запрещает легитимные мутации;
snapshot их разрешает и позволяет восстановить pre-state.

Реализация — `tests/sandbox/checkpoint.ts`, harness-level, не IR. От исходного предложения
(shadow git) отказались: образы задач не всегда содержат git (db-wal — tar/cp без git), а `cp -a`
есть везде. Вместо git — content-addressed store:

1. **Где.** `<task root>/.skein/checkpoints/`: `objects/` (immutable blobs, ключ = sha256 +
   mode + mtime), `trees/<n>/` (hardlink-деревья), `README`, `restore.sh`. Хранилище живёт на
   хосте; в контейнер монтируется read-only в `<mountPoint>/.skein/checkpoints` (docker
   `-v :ro`, bwrap `--ro-bind`). `.skein` скипается file tools и walk'ом снапшота.
2. **Когда.** `initial` — после `setup` (setup может создать исходные артефакты); затем
   `turn-N` перед каждым `propose`; плюс `pre-patch` — opaque id на `move` состояния Patch.
   Неизменившееся дерево не перезаписывается (manifest hash), поэтому idle-ходы не растят store.
3. **Scope.** Task root; исключены `.skein` (harness/verifier/jobs) и `.env`/`.env.*`
   (секреты). Вложенный/корневой `.git` задачи **захватывается** — это обычная директория.
   Нечитаемые хостом файлы (root-owned `john/run/john.log`) пропускаются best-effort: иначе
   snapshot валил весь прогон (`llm_error`; это дало ложные 0/5 на crack).
4. **Доступ модели.** Read-only путь + `restore.sh <n> <path> [dest]`; отдельного tool'а нет и
   нового состояния нет. Модель может `ls`/`diff`/`cp -a` из дерева, но не может его испортить.
5. **Интеграция с движком.** `Workspace.checkpoint`/`restoreCheckpoint` — optional: plain-fs
   workspace их не имеет. На входе в Patch движок кладёт `checkpoint` в payload `move`
   (проекция его игнорирует). `revertLastPatch` восстанавливает **только refs, которые
   мутировал Patch** (`mutates` edges), включая `bash`, `write`, `apply_patch` и удаления; без
   checkpoint — прежний edit-only fallback. `reconcile` пишет один `mutate absent` для
   исчезнувшего witnessed-файла.
6. **Секреты.** `.env`/`.env.*` и `.skein` в снапшот не попадают; модель видит снапшот, но не
   секреты harness'а.
7. **Стоимость.** Блобы дедуплицируются по содержимому, деревья — hardlink'и; per-turn цена —
   метаданные, не копия дерева. На маленьком task root дешёво; для fix-ocaml отдельно не
   измерялось.
8. **Проверка.** `tests/checkpoint.test.ts` + `tests/revert.test.ts` offline; db-wal
   checkpoint-only — 5/5 (3.83₽), checkpoint+revert — 5/5 (5.80₽): в двух recovery-прогонах
   модель восстановила WAL из `trees/1`, а checkpoint-revert вернул pre-patch WAL после
   failed Verification. Crack после best-effort фикса — 3/3 завершившихся.

## 6. Открытые вопросы / решения

**Решено в `7b59d53`:**

1. **Snapshot granularity:** initial (после setup) + per-turn + pre-patch. Pre-turn покрывает
   db-wal (WAL удаляется `bash`-командой), pre-patch — точечный revert.
2. **Host-side vs container-side:** store на хосте, read-only bind в контейнер; git в образе
   задачи не нужен.
3. **Restore surface:** read-only путь + `restore.sh`, без нового tool'а и без нового состояния.
4. **Offline fixtures:** обновлены; `346 passed`, typecheck зелёный.

**Открыто:**

5. **Честный стоп при отсутствии source**: правило «If the source material is absent and the
   result cannot be derived from it, do not synthesize and do not search endlessly: stop and
   state the missing material» — **не реализовано**; тест t22/t23. Checkpoint уменьшает частоту
   (файл можно восстановить), но не отменяет случай, когда источника нет вовсе.
6. **State-маркеры/элизия**: marker A (system, `your stop reason`) сделан; элизия закрытого
   плана (Orientation `list`) остаётся; решить, нужен ли краткий summary действий закрытого
   состояния (сейчас только `Finish why`).
7. **Provenance vs поиск**: правило запрещает fake pass, но при потерянном source модель ищет и
   застревает; honest stop — следующий шаг.
8. **Token cost**: state/tool-описания длинные (особенно `bash`); per-turn input вырос; решить,
   что триммить, после стабилизации поведения.
9. **Crack**: 3/3 завершившихся после checkpoint-фикса, 2 прогона прерваны abort'ом; нужен
   чистый 5/5. Phantom code-fix с новым orientation live не перепроверен.
10. **`custom-memory-heap-crash`** не гонялся с новым промтом; 13-я задача.

## 7. Задачи следующей сессии (по порядку)

1. ~~Прочитать этот документ, `git diff`, `docs/state_testing_ru.md` §2.5/§5 п.4,
   `docs/ir_semantics.md` §5/§7/§8.~~ — выполнено.
2. ~~Обновить offline-фикстуры под marker A/новые formulation; `npm run typecheck`;
   `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` до зелёного.~~ — выполнено:
   `346 passed`, typecheck зелёный.
3. ~~Workspace checkpoint в `tests/sandbox`~~ — выполнено в `tests/sandbox/checkpoint.ts`
   (+ `tests/checkpoint.test.ts`); см. §5.
4. **Honest-stop rule** при отсутствии source; tape t22/t23; метрика `stop` vs search.
5. **Crack до чистого 5/5** (сейчас 3/3 завершившихся, 2 abort) и **`custom-memory-heap-crash`**
   с новым промтом. Остальные breadth-задачи уже 5/5: db-wal, log-summary, cobol, fix-code,
   password; fix-ocaml — 4/5.
6. **Решение по state-specific tool descriptions/токенам**: оставить/триммить; измерить.
7. ~~Коммит промт/harness-правок после зелёных тестов и принятого дизайна.~~ — `7b59d53`.

## 8. Команды и артефакты

```sh
npm run typecheck

# offline (зелёный: 346 passed; sandbox не собирать!)
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'

# tape replay одного хода
npx tsx bench/turn.ts <run-dir> --turn N --rebuild --repeat 3 --reasoning
# для marker A/B — temp-trace с изменёнными ролями/текстом или пере-проекция IR

# live sandbox (тяжёлое; только с явного разрешения владельца)
npx tsx tests/sandbox/sandbox-smoke.ts <task-id> ... --concurrency 5 --turns 40
```

Пути:

- 55 прогонов (старый промт, 24 хода): `bench/runs/sandbox-tasks/2026-10-18T06-*`.
- 10 прогонов (fix-ocaml/password, 40): `bench/runs/sandbox-tasks/2026-10-18T08-59-*`,
  `09-07-*`, `09-11-*`, `09-14-*`.
- db-wal 5×40 **до checkpoint** (исторический фейл): `2026-10-18T11-08-*`; фейл
  `11-08-17-180Z-db-wal-recovery`.
- 2026-10-18 breadth (40 ходов, после checkpoint): db-wal checkpoint-only `12-19-*`,
  checkpoint+revert `12-35-*`; log-summary `12-56-*`; crack `13-04-*`, `13-14-*`; cobol
  `13-06-*`/`13-08-*`/`13-09-*`; fix-code `13-09-37`, `13-10-*`.
- password opencode 5× и логи: `bench/runs/sandbox-tasks/2026-10-18T06-54-*password-recovery-opencode-on`.
- Логи tape-экспериментов: `/tmp/opencode/prompt-ab/` (могут не пережить перезагрузку; трассы в
  `bench/runs` — постоянные).
- Opencode baseline: `~/dev/skein-plugin/pilot/harbor/jobs/2026-09-26__11-50-39/`;
  db-wal trial `db-wal-recovery__kJW3DXm`; snapshot
  `agent/opencode/xdg-data/opencode/snapshot/global/42099b4af021e53fd8fd4e056c2568d7c2e3ffa8`.
- Сводка/лидерборд breadth: `docs/benches/best_bench_ru.md` (батч 2026-10-18).
- `docs/benches/bench_report.md` §4.4/§4.7 (Harbor breadth) — historical context.

## 9. Осторожности

- **Offline-сьют зелёный** (346 passed); правки закоммичены в `7b59d53`.
- **Heavy/live** (`tests/sandbox/**`, `SKEIN_LIVE=true`, Harbor, bench) — только с явного разрешения
  владельца; `tests/sandbox/**` самовключается при Docker+images+Harbor cache — не запускать
  bare `npx vitest run`.
- **Секреты**: `.env`/API-ключи; checkpoint **исключает** `.env`/`.env.*` и `.skein`; не печатать
  ключи.
- **`--rebuild`** не меняет роли маркеров/`instruction` острова; для marker A/B — temp-trace или
  пере-проекция IR.
- **Не доверять одному `reason=`**: рост токенов ≠ смятение; смотреть содержание/действие
  (t28: рост, но смятение ушло; t22/t23: рост, но это provenance-поиск).
- **Не добавлять новые острова/профили** без явного согласия: пользователь отверг их как костыли.
- **Snapshot** — artifact store, не новый источник истины; IR/проекция/инварианты не меняются.
