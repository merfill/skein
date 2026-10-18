# Skein — handoff 2026-10-18 (session 2): восемь состояний, password-recovery live

> Рабочий handoff для следующей сессии. Русский, без EN-зеркала; не индексируется.
> Предыдущий контекст — `docs/plans/handoff_2026-10-18_ru.md` (opencode-snapshot, checkpoint,
> старые эксперименты); этот файл его дополняет и **новее**.
>
> Код **не закоммичен**. `typecheck` зелёный; offline-сьют **348 passed** (40 skipped).
> Тяжёлые/live-прогоны — только с явного разрешения владельца.

## 0. TL;DR

1. В `src/ir/islands.ts` реализованы **восемь состояний**: `orientation`, `localization`,
   `research`, `patch`, `recovery`, `construction`, `verification`, `finish`.
2. `Localization` снова конкретная: артефакт + причина/инвариант для дефекта кода. `Patch` —
   правка артефакта. `Research` — ситуация + метод + **source-проверка**. `Recovery` — скрипт,
   который перебирает кандидатов и проверяет их source-проверкой; `Construction` — новый
   артефакт/программа. `Verification` — для `Patch`/внешней приёмки.
3. Live step-by-step на `password-recovery` прошёл полный путь
   `Orientation → Research → Recovery → Finish`: Research нашёл ZIP-фрагментацию и CRC
   `0xb0725dc4`, Recovery написал Perl-скрипт с CRC и negative control, пароль
   `8XDP5Q2RT9ZK7VB3BV4WW54` записан. Но цена высокая: **36 turns, 14 319 reasoning, 3.33₽**
   (старый текущий промт: 25 turns, 4 331 reasoning, 1.01₽, но без CRC и с ручной первой парой).
4. Главный тормоз — **Research**: модель ходит по offset’ам one-liner’ами. Прямое указание
   «scratch-скрипт в `/tmp` разрешён» на одном шаге сразу дало **один** `/tmp/probe.pl` —
   значит, аттрактор задаёт **tool contract Research** («inspection only: do not create files»),
   а не state hint.
5. Recovery уже пишет скрипты; дополнительное разрешение «создавать/менять файлы» в его
   instruction **не изменило** поведение (те же 14 ходов). Ошибка Research brief на 1 байт
   (хвост 3145727 vs 3145728) стоила ~4 ходов; source-check её поймал.
6. Следующий шаг: разрешить в Research **один read-only probe-скрипт в `/tmp`** (workspace
   read-only) и проверить с `t6`, K≥3. Плюс требовать в Research brief проверенные или
   приблизительные координаты.

## 1. Что изменено в коде (не закоммичено)

`git status --short` (на момент записи):

```
 M bench/step.ts
 M docs/session_concepts.md
 M docs/session_concepts_ru.md
 M docs/states_ru.md
 M src/ir/islands.ts
 M src/llm/tools.ts
 M src/loop/prompt/blocks.ts
 M tests/islands.test.ts
 M tests/ops/applicable.test.ts
 M tests/prompt.test.ts
 M tests/structured.test.ts
?? docs/plans/handoff_2026-10-18_ru.md
?? docs/plans/task_catalog_2026-10-18_ru.md
```

- `src/ir/islands.ts`: восемь состояний; у каждого `what`/`criterion`/`instruction`/`hint`/
  `applies`/`next`. `research`/`recovery`/`construction` добавлены; `localization`/`patch`/
  `verification` уточнены. Tool sets: `recovery` — INSPECT + `write` (без `edit`/`apply_patch`);
  `construction` — полный write-класс; `patch` — полный; inspection — только INSPECT.
- `src/loop/prompt/blocks.ts`: старт **только Orientation**; `transitionRule` для
  localization/recovery/construction/verification; Finish предлагается только если он есть в
  `next` (из Patch — только Verification); общий хвост `turnInstruction` очищен от
  code-центричных фраз; B4: «result must come from source/spec»; удалён старый code-anchor
  «filenames directory structure».
- `src/llm/tools.ts`: `stop` нейтральный; state-specific `bash`/`webfetch`/`write`/`edit`/
  `apply_patch`; Research — inspection contract (пока **запрещает создание файлов**);
  Recovery — «you may create and modify files; keep source read-only»; Construction — build a
  new artifact.
- `bench/step.ts`: в `contexts/tNNN.txt` теперь печатается **содержимое tool-результатов**
  (раньше только `(answers id)`); добавлен `EXTRA_SYSTEM` — one-step system message для
  counterfactual (не пишется в seq).
- `docs/states_ru.md`: целевой документ по состояниям; tests 348; source-проверка вместо
  «oracle»; Recovery может/должен создавать файлы; handoff через `Finish why`.
- `docs/plans/task_catalog_2026-10-18_ru.md`: каталог 13 задач, opencode/Skein траектории,
  reasoning по состояниям, классы/маршруты. Это **основание** для состояний, данные — до
  реализации.
- `docs/session_concepts{,_ru}.md`: стартовое состояние теперь только `orientation`.
- Тесты: `348 passed`; обновлены `tests/islands.test.ts`, `tests/prompt.test.ts`,
  `tests/ops/applicable.test.ts`, `tests/structured.test.ts`.

Не забыть: старые `docs/system_prompt*.md` и `docs/prompt_state_machine_concept*.md` всё ещё
описывают четыре состояния и «write-class only Patch»; синхронизировать после стабилизации.

## 2. Live-эксперименты password-recovery

Все прогоны — пошаговые `bench/step.ts`; команды в контейнере, модель и лента на хосте.
Trace dirs:

- `bench/runs/sandbox-tasks/2026-10-18T21-22-password-recovery-step` — v1 (старый общий промт,
  до source-check). Застрял в Recovery, ~2.19₽, ~9k reasoning, **не финишировал**.
- `...-step-v2` — успешный путь с source-check. **36 turns, 14 319 reasoning, 3.33₽**. Research
  (13 turns, 11 137 reasoning, 1.64₽) нашёл ZIP/CRC; Recovery (14 turns, 2 840 reasoning,
  1.29₽) написал Perl-скрипт, CRC, negative control; output
  `8XDP5Q2RT9ZK7VB3BV4WW54`; t33 stop, t34 `finish`, t35 terminal stop.
- `...-step-v3` — Research с новым hint «probe/parser; do not walk offsets by hand». На t17
  всё ещё парсил header, 11 turns, 3 405 reasoning, 1.70₽, **не финишировал**.
- `...-step-v3-direct` — на t18 добавлен `EXTRA_SYSTEM`: «scratch-скрипт в `/tmp` разрешён,
  напиши один probe.pl». Модель **написала один** `/tmp/probe.pl`; local header CRC mismatch,
  central directory parse неполный, затем снова ушла в gzip-поиск. t18 ~0.39₽, t19 ~0.42₽.
- `...-step-v2-recovery-instr` — Recovery instruction явно разрешает создавать/менять файлы.
  Recovery: **14 turns, 3 300 reasoning, 0.83₽** (v2: 14 turns, 2 840 reasoning, 1.29₽);
  output корректный, negative control отвергнут. Поведение не улучшилось: Python-детур,
  off-by-one 3145727→3145728, ~4 хода на исправление.

## 3. Выводы по эксперименту

- **Research tool contract — главный аттрактор.** Hint говорит «write probe/parser», а `bash`
  в Research — «inspection only: do not create files». Модель выбирает one-liners. Прямое
  разрешение/указание → один persisted probe-скрипт. Это подтверждено на одном шаге; для
  статистики нужно K≥3.
- **Recovery permission — не аттрактор.** Recovery и так писал скрипты; дополнительное
  «можно создавать файлы» не меняет число ходов. Проблема — метод/brief, не permission.
- **Research brief — handoff.** Recovery видит только `Finish state Research — why`;
  `move.what`/`move.notes` не рендерятся. Brief v2 был подробным (offsets/CRC/prefix/tail), но
  с ошибкой на 1 байт; source-check её поймал, цена — несколько ходов.
- **Source-check работает.** Recovery-скрипт принимает только reassembly с CRC `b0725dc4` и
  отвергает form-fitting negative control. Это закрывает fake-pass, но не гарантирует
  дешёвый путь.

## 4. Следующие шаги (по порядку)

1. **Research tool contract:** в `bashDescriptionFor("research")` разрешить **один read-only
   probe-скрипт в `/tmp`**; workspace остаётся read-only; source не трогать. Убрать
   противоречие с hint. Перезапустить Research с `t6`, K≥3; сравнить с v3/v2.
2. **Research brief:** добавить в hint: «если даёшь координаты в `why`, проверь их по байтам
   или помечай как приблизительные; Recovery проверит source-check». Цель — убрать off-by-one.
3. **Recovery `edit`:** обсудить, дать ли `edit` для своего скрипта/scratch (source read-only).
   Сейчас модель читает и перезаписывает файл целиком; это стоит ходов.
4. **Полный повтор password** с новым Research contract; сравнить turns/reasoning/₽ с v2.
5. **Другие классы:** после стабилизации Research — fix-ocaml (Repair), db-wal (Recovery),
   regex/cobol (Construction); tape A/B и live 5×40.
6. **Docs sync:** `system_prompt*`, `prompt_state_machine_concept*`, `ir_semantics` — старые
   четыре состояния/write-class; обновить после стабилизации.
7. **Commit** только после зелёных тестов и принятого дизайна.

## 5. Команды/артефакты

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'   # 348 passed

# step-by-step (лента/seq уже есть)
TAPE_DIR=bench/runs/sandbox-tasks/2026-10-18T21-22-password-recovery-step-v2 \
  npx tsx bench/step.ts password-recovery /tmp/opencode/password-step/seq-v2.json

# one-step counterfactual
EXTRA_SYSTEM='...' TAPE_DIR=<new-dir> \
  npx tsx bench/step.ts password-recovery <seq.json>
```

- seq/рабочие файлы: `/tmp/opencode/password-step/` (`seq.json`, `seq-v2.json`, `seq-v3.json`,
  `seq-v3-direct.json`, `seq-v2-recovery-instr.json`).
- v2 успешный trace: `bench/runs/sandbox-tasks/2026-10-18T21-22-password-recovery-step-v2`
  (t018 — Research stop, t033 — Recovery stop/output).
- Предыдущий handoff: `docs/plans/handoff_2026-10-18_ru.md`.
- Каталог 13 задач: `docs/plans/task_catalog_2026-10-18_ru.md`.
- Состояния: `docs/states_ru.md`; код: `src/ir/islands.ts`, `src/loop/prompt/blocks.ts`,
  `src/llm/tools.ts`.

## 6. Осторожности

- Не коммитить незакоммиченные изменения без ревью: это прототип восьми состояний.
- `EXTRA_SYSTEM` — только one-step counterfactual; он не попадает в seq/историю.
- `move.notes`/`move.what` не рендерятся: единственный handoff — `Finish why`.
- Не добавлять новые острова/профили без явного согласия.
- Live/heavy — только с явного разрешения; не запускать bare `npx vitest run`.
- Внешний verifier (Harbor/harness) остаётся вне состояний; step-by-step reward не считает.
