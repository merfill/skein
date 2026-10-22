# Handoff — session 6: state tape, replacement of the per-turn tail (2026-10-22)

> Рабочий документ: фиксирует состояние перед новой сессией. В этой сессии работали с
> промтами состояний; код и доки изменены, offline-тесты зелёные. Live-эксперименты шли
> пошагово на `fix-ocaml-gc`, полный прогон не завершён.

## 1. База

- HEAD/базовая линия до сессии: `c97a34d` (session-3), ветка `main`.
- Рабочий baseline-прогон: `bench/runs/sandbox-tasks/2026-10-20T18-27-57-021Z-fix-ocaml-gc`
  — 24 хода, L=6, reward=1, 1.402₽. Там **был** per-turn tail.
- Модель: `routerai/~deepseek/deepseek-v4-flash-latest`, temp 0.1 (шумно, K≥3).
- Live/контейнерные прогоны — только с явного разрешения владельца.

## 2. Что уже сделано в коде

### 2.1 Терминология и блоки

- Терминальное состояние `finish` → `end`, label `End`, `what: complete the request`.
  Старые журналы: `moveIsland` читает `"finish"` как `"end"`.
- `BASE_BLOCKS` перенумерованы: **B1 role, B2 principles, B3 states, B4 moves**.
- Ситуационные промты больше не `B…`: `request`, `plan`, `working`, `transition`,
  `terminal` (в коде остались только `request`/`transition`; см. 2.2).
- `stop` больше не привязан к состоянию в описании инструмента:
  `Call stop to stop. why = a detailed account of why you are stopping — up to ~50 words.`
- Из отказов убран `stop` (`state_open`, `not_addressed`, `interpreted`); коллизия
  `finish`/`Finish state` разведена.
- `Patch` больше не ждёт change из `Finish`-строки: «the cause is the one the Finish line
  names — apply the change it implies». Мёртвый `Previous failed attempt` из hint убран.

### 2.2 Лента состояния (главное изменение)

Открытое состояние:

```text
[system] Start state <Label>
         Goal: <what>.
         Done when: <criterion>.
         <Island.instruction>

[system] <stateBrief: Workspace map / Environment>

[system] <Island.hint>

... native tool calls + results ...
```

Закрытое:

```text
[system] Start state <Label>
         Goal ...
         Done when ...
         <instruction>

[system] Finish state <Label> — <why>
```

- `user: what:` внутри состояния удалён.
- Per-turn хвосты (`turnInstruction`/`planInstruction`) удалены.
- `Previous failed attempt` больше не рендерится; запись несут `Finish state`-строки.
- `brief`/`hint` элидируются при закрытии; `start`/`finish` остаются.
- `buildMessages` добавляет только `request` (system) и `transition` (user); для
  `plan`/`working`/`terminal` вставок нет.

### 2.3 Граф состояний

- Удалены: `Research → Patch`, `Recovery → Patch`, `Recovery → Localization`,
  `Construction → Localization`.
- `Recovery.what`: `recover the required result from the source`.
- `Localization → Patch`: `the target is named and a cause is suspected`.
- Текущий Localization-контракт (после экспериментов A/B/AB):

```text
Done when: the target is named — the file, record, image, or function — and a suspected cause
is named — the expression, step, or encoding that conflicts with the source's own comment/invariant.

Hint: Once you can name the target and a conflict with the source's own invariant, that is
enough — stop. The request's changes are one defect. Put the detailed reason in the `why`: the
target and the conflict. Do not change the target.
```

Инструкция Localization — исходная, с «the implementation and the definitions or headers it
uses — and inspect those». B2 — исходный (с `validate assumptions by reading`).

## 3. Live-эксперименты и что выяснили

Шли по ходам `bench/step.ts` на `fix-ocaml-gc` (контейнер). Полный прогон не завершён.

### 3.1 Baseline (со старым tail) останавливался

- t7: 12 216 символов reasoning — модель нашла баг:
  `pool_sweep`, line 650: `p += Whsize_hd(hd)` после `p += wh * Wosize_hd(hd)` —
  двойной сдвиг; siblings (`calc_pool_stats`, compaction, verification) делают `p += wh`.
- t8: 1 011 символов — «I have the target… That's enough. Stop.»
- В контексте t8 **последним сообщением был per-turn tail**:
  `… This state's done criterion: "…". When it holds, \`stop\` — and nothing else. …`

### 3.2 Без tail модель не останавливается

Текущие прогоны (step1/2/3, probe_t6*, A/B/AB) стабильно:

- находят тот же баг (`p += Whsize_hd` вместо `p += wh`);
- затем либо уходят сверять с upstream/оригиналом, либо убеждают себя, что
  `Whsize_hd = wh`/`1` и «Correct»;
- читают `pool_allocate`, `calc_pool_stats`, `compact.c`, `shared_heap.c` повторно;
- **не вызывают `stop`**.

Примеры reasoning на t6–t8: 672 → 1244 → 3172; 1277; 695; 611. Стоимость Localization
в неудачных ветках ~1.4–1.9₽ и растёт.

### 3.3 Проверенные гипотезы (все не остановили)

1. Убрать из B2 «analyze / validate assumptions by reading» — не помогло.
2. `EXTRA_SYSTEM`: «acceptance (build/tests) belongs to later states» — не помогло.
3. Убрать из Localization instruction «the definitions or headers it uses» — не помогло
   (ушла в `pool_allocate`, потом аудит).
4. Убрать sibling из stop-критерия (A) — не помогло.
5. Убрать «why it is wrong» из hint (B) — не помогло.
6. A+B вместе — не помогло.
7. Смотреть tool prompts (`read`/`grep`/`list`/`recall` «page/continue from», `webfetch`,
   `move` «do not derive the result») — владелец отверг: это не причина; `webfetch`
   убирать нельзя (можно `curl` через bash).

### 3.4 Ключевой вывод

- Проблема не в одной фразе stop. Baseline останавливался, потому что критерий стоял
  **последним в ленте** (per-turn tail). Без tail модель решает всю задачу (fix+tests),
  а не подсостояние, и теряет найденный конфликт при повторном выводе.
- Владелец **запретил возвращать tail** («никакого хвоста»). Значит, нужен другой
  механизм остановки/границы, не per-turn cue.
- OpenCode не опровергает это: у него нет Localization-состояния, он идёт до фикса.

## 4. Открытый вопрос для следующей сессии

Как получить остановку Localization **без per-turn tail**:

1. Сделать границу Localization/Patch не нужной: слить в одно продуктивное состояние
   «найди и исправь» (как opencode). Тогда модель идёт до фикса, а не до подозрения.
2. Оставить границу, но найти не-текстовый механизм: например, менять/ограничивать
   поверхность инструментов в Localization так, чтобы аудит не продолжался (обсуждать
   осторожно; `webfetch` не трогать).
3. Проверить модель/temperature: temp 0 или более сильная модель; текущая теряет
   арифметику (`Whsize_hd = 1+wosize` → «1») и не коммитится.
4. Пересмотреть сам state split: возможно, Localization не должна существовать как
   отдельное состояние для code-defect задач.

**Не повторять:** per-turn хвост, удаление `webfetch`, «жёсткие» формулировки
«do not read another window» (owner: сбивают модель), правки tool-prompts «page/continue».

## 5. Тесты и команды

- `npm run typecheck` — чисто.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — 361 passed, 40 skipped.
- Live (только по разрешению): `TAPE_DIR=... npx tsx bench/step.ts fix-ocaml-gc <seq.json>`.
- Baseline для сравнения: `bench/runs/sandbox-tasks/2026-10-20T18-27-57-021Z-fix-ocaml-gc`
  (contexts/t007.txt, t008.txt; reasoning.ndjson).

## 6. Состояние git

- Ветка `main`, база `c97a34d`; изменения этой сессии — в коммите (prompt/tape/blocks).
- Untracked handoff-файлы предыдущих сессий не коммитились.
