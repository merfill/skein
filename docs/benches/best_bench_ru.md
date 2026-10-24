# Skein — лучшие бенчмарк-прогоны (таблица лидеров)

> Русское зеркало `docs/benches/best_bench.md`.
> Живая таблица лучших прогонов. Топ-10 держим здесь.

## Как считаем места

Выше — лучше, в таком порядке:

1. **`reward`** — вердикт верификатора задачи (1 важнее 0);
2. **позитивное самозакрытие** (у Skein: `stop = request_addressed`; агент без протокола
   остановки здесь равноценен) важнее прогона, который лишь исчерпал бюджет;
3. **меньшая стоимость** (₽; если агент стоимость не сообщает — прокси по времени), затем
   меньше шагов.

Один прогон — одна строка. В каталоге прогона лежит трасса (`metrics.json`, `result.json`;
opencode пишет ещё `opencode.txt`).

> **2026-10-23, восстановленный state-слой, reasoning on, net off, K=3:** `fix-ocaml-gc` —
> **3/3 reward=1**, 25–29 шагов, **1.342 / 1.412 / 1.437₽** (median **1.412₽**). L закрылась
> на t10 / t8 / t11; median входа **163 568** (fresh 51 084 + cache 115 968, 71%) против
> opencode net-off **981 082**, reasoning **3 812** против **15 852**. См. «Батч 2026-10-23».

> **2026-10-23, rootless D + relative paths, net off, K=3:** `fix-ocaml-gc` — **3/3 reward=1**,
> 27–29 шагов, **1.633 / 1.732 / 1.822₽** (median **1.732₽**). L закрылась на t8 / t10 / t10;
> median входа **196 449** (fresh 64 353 + cache 135 680, 69%). Против pre-rootless батча
> median **+23%** стоимости; разрыв — в Patch (8–9 ходов против 6–8), не в Localization.
> См. «Батч 2026-10-23 — rootless D».

> **2026-10-23, breadth:** `fix-code` / `fix-git` / `custom-memory` — **3/3 reward=1**;
> 25 / 19 / 60 ходов, **0.942 / 0.847 / 3.822₽**. `fix-git` прошёл без Verification;
> `custom-memory` — регрессия (60 ходов, 4 цикла). См. «Батч 2026-10-23 — breadth».

> **2026-10-23, breadth rootless D + relative paths:** `fix-code` / `fix-git` /
> `custom-memory` — **3/3 reward=1**; 20 / 20 / 60 ходов, **0.769 / 0.833 / 3.114₽**.
> `fix-code`/`fix-git` — `request_addressed`; `custom-memory` — `reward=1`, но
> **`max_turns`** (без self-closure). См. «Батч 2026-10-23 — breadth, rootless D».

> **2026-10-23, recovery (Research → Recovery), net off, K=1 на задачу:**
> `password-recovery` / `db-wal-recovery` / `crack-7z-hash` — **3/3 reward=1**, 26 / 22 / 23
> хода, **2.531 / 1.278 / 0.965₽**. Все `request_addressed`, маршрут
> `O → Research → Recovery → End`. См. «Батч 2026-10-23 — recovery».

> **2026-10-20, final conduct, net on, K=3:** `fix-ocaml-gc` — **3/3 reward=1**,
> 24/29/30 шагов, **1.402 / 1.634 / 2.410₽** (median **1.634₽**). Первый end-to-end
> прогон промта, где hint = conduct, tail = conduct → goal → criterion → stop, а в
> Localization добавлены directory/definitions + sibling-сравнение. Против opencode
> (5 прогонов, median 1.974₽) — **−17%**; общий input в 3.7× меньше (201k против 748k),
> cache hit хуже (71% против 96%). См. «Батч 2026-10-20» ниже.

> **2026-10-18, terminal-bench breadth:** `db-wal-recovery`, `log-summary-date-ranges`,
> `cobol-modernization`, `fix-code-vulnerability`, `password-recovery` — **5/5**;
> `crack-7z-hash` — **3/3** завершившихся (2 прерваны). Обобщённые состояния + workspace
> checkpoint/revert. См. «Батч 2026-10-18» ниже.

> **2026-10-17, финальный батч:** 5/5 `fix-ocaml-gc --net on`, 29–50 шагов,
> **1.031–2.521₽** — см. «Финальный батч» ниже. Таблица ниже — лидерборд;
> новый лучший net-on — run4 `26-682` (1.031₽ / 32 шага) и run3 `25-612` (1.036₽ / 29 шагов).

## Таблица

| # | дата (UTC) | агент | задача | режим | reward | шагов | вызовов | in | out (виз + реа) | cache | время | каталог |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **★** | 2026-10-23 | Skein | `fix-ocaml-gc` | **net off** — восстановленный state-слой, reasoning on; **1.342₽**, лучший по стоимости | **1** | 26 | 32 | 163 568 | 6 796 (2 984 + 3 812) | 71% | — | `bench/runs/sandbox-tasks/2026-10-23T04-29-17-477Z-fix-ocaml-gc` |
| 1 | 2026-10-23 | Skein | `fix-ocaml-gc` | **net off** — восстановленный state-слой, reasoning on; **1.412₽**, лучший по входу (151 935) | **1** | 25 | 33 | 151 935 | 6 944 (2 995 + 3 949) | 66% | — | `bench/runs/sandbox-tasks/2026-10-23T04-29-19-623Z-fix-ocaml-gc` |
| 2 | 2026-10-23 | Skein | `fix-ocaml-gc` | **net off** — восстановленный state-слой, reasoning on; **1.437₽** | **1** | 29 | 38 | 208 780 | 7 092 (3 322 + 3 770) | 76% | — | `bench/runs/sandbox-tasks/2026-10-23T04-29-21-776Z-fix-ocaml-gc` |
| 3 | 2026-10-17 | Skein | `fix-ocaml-gc` | **net off** † — reasoning на ленте (бывш. ★: лучший по стоимости/входу до 2026-10-23) | **1** | 27 | 34 | 159 475 | 10 681 (2 901 + 7 780) | 72% | — | `bench/runs/sandbox-tasks/2026-10-17T05-16-41-582Z-fix-ocaml-gc` |
| 4 | 2026-10-23 | Skein | `fix-ocaml-gc` | **net off** — rootless D + relative grep/list; **1.633₽** | **1** | 27 | 27 | 196 293 | 7 636 (3 031 + 4 605) | 69% | — | `bench/runs/sandbox-tasks/2026-10-23T16-32-18-116Z-fix-ocaml-gc-AAFw9y` |
| 5 | 2026-10-23 | Skein | `fix-ocaml-gc` | **net off** — rootless D + relative grep/list; **1.732₽** | **1** | 29 | 29 | 196 449 | 8 130 (3 798 + 4 332) | 67% | — | `bench/runs/sandbox-tasks/2026-10-23T16-32-18-094Z-fix-ocaml-gc-sVz2Qi` |
| 6 | 2026-10-23 | Skein | `fix-ocaml-gc` | **net off** — rootless D + relative grep/list; **1.822₽** | **1** | 29 | 29 | 239 499 | 9 046 (3 428 + 5 618) | 73% | — | `bench/runs/sandbox-tasks/2026-10-23T16-32-18-093Z-fix-ocaml-gc-bH2YAw` |
| 7 | 2026-10-17 | Skein | `fix-ocaml-gc` | **net off** † — reasoning на ленте (A/B) | **1** | 34 | 44 | 173 000 | 14 923 (3 296 + 11 627) | 71% | — | `bench/runs/sandbox-tasks/2026-10-17T04-57-57-012Z-fix-ocaml-gc` |
| 8 | 2026-10-17 | Skein | `fix-ocaml-gc` | **net off** † — reasoning на ленте (A/B) | **1** | 32 | 40 | 222 135 | 14 603 (3 274 + 11 329) | 75% | — | `bench/runs/sandbox-tasks/2026-10-17T05-16-41-598Z-fix-ocaml-gc` |
| 9 | 2026-10-14 | Skein | `fix-ocaml-gc` | **net on** † — **лучший net on и лучший Skein по стоимости без reasoning на ленте (Фаза 18: активные директивы)** | **1** | 29 | 37 | 252 551 | 16 198 (3 177 + 13 021) | 78% | — | `bench/runs/sandbox-tasks/2026-10-14T05-37-29-796Z-fix-ocaml-gc` |
| 10 | 2026-10-09 | opencode 1.18.35 | `fix-ocaml-gc` | **net off** | **1** | 27 | 41 | 1 213 834 | 21 987 (3 398 + 18 589) | 96% | 322s | `bench/runs/sandbox-tasks/2026-10-09T15-51-47-367Z-fix-ocaml-gc-opencode-off` |

Номера строк — текущие (2026-10-23); в разделах ниже `(#N)` относится к таблице на момент
того прогона.

Из топ-10 выпали (в этот раз): **`2026-10-15T19-24-07`** (net on, 52 шага, 7.30₽),
**`2026-10-11T13-21-36`** (net on, 33 шага, 2.93₽) и **`2026-10-11T05-13-47`** (net on,
35 шагов, 4.85₽). Ранее выпали: **`2026-10-13T11-39-19`** (net on, goal-into-move, 52 шагов),
**`2026-10-11T13-50-03`** (net off, 45 шагов), **`2026-10-13T11-51-44`** (net off,
goal-into-move, 49 шагов), **`19-02`** (net on, 46 шагов, 6.97₽), **`08-40`**
(net on, 50 шагов, стоимость не записана), **`07-02`** (net off, 13.78₽) и **`18-30`** (net on,
12.68₽) — их описания остались в разделах ниже. С добавлением rootless-батча выпали
opencode-строки: **`2026-10-09T16-01-20`** (net on, 33 шага, 434s), **`2026-10-11T06-30-03`**
(net on, 33, 314s) и **`2026-10-11T06-52-33`** (net off, 24, 279s); их трассы остаются в
каталогах.

## Батч 2026-10-23 — восстановленный state-слой, reasoning on, net off, K=3

`npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --net off --turns 60`, 3 параллельно,
официальный verifier. Рабочее дерево на базе `b1ea154`, без коммита: state-слой как в
`c97a34d` (entry `Start`/brief/instruction/`what` + per-turn tail
`hint → what → done → closure`, `planInstruction`/`turnInstruction`), base B1–B4 — текущий;
`reasoningTape` по умолчанию **on**.

| run | шагов | вызовов | in | fresh | cache | hit | out (виз + реа) | L stop | Patch | Verification | ₽ | reward |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|--:|--:|
| `04-29-17` | 26 | 32 | 163 568 | 47 600 | 115 968 | 71% | 6 796 (2 984 + 3 812) | t10 | t11–16 | t17–23 | **1.342** | **1** |
| `04-29-19` | 25 | 33 | 151 935 | 51 327 | 100 608 | 66% | 6 944 (2 995 + 3 949) | t8 | t9–15 | t16–22 | **1.412** | **1** |
| `04-29-21` | 29 | 38 | 208 780 | 51 084 | 157 696 | 76% | 7 092 (3 322 + 3 770) | t11 | t12–19 | t20–26 | **1.437** | **1** |
| **median** | **26** | **33** | **163 568** | **51 084** | **115 968** | **71%** | **6 944 (2 995 + 3 812)** | — | — | — | **1.412** | — |

Все три — `request_addressed`, `reward=1`; правка одна и та же и верная:
`p += Whsize_hd(hd)` → `p += wh` в `pool_sweep` (`runtime/shared_heap.c`). В run3 был один
транспортный retry (`No output generated`), ходы не потеряны.

**Сравнение с opencode в той же песочнице** (`bench/runs/sandbox-tasks/*-opencode-*`).
Net-off — честное плечо (без upstream); всего было K=5 (2 net-off + 3 net-on).

| метрика | Skein K=3 | opencode net-off K=2 | opencode all K=5 |
|---|---:|---:|---:|
| шагов | 25 / 26 / 29 (median 26) | 24 / 27 (median 25.5) | 24–33 (median 27) |
| всего in | median **163 568** | median 981 082 | median 748 329 |
| fresh in | median **51 084** | median 39 642 | median 33 449 |
| cache read | median **115 968** | median 941 440 | median 714 880 |
| cache hit | **71%** | 96% | 96% |
| out | median **6 944** | median 18 911 | median 11 993 |
| visible out | median **2 995** | 3 059 | 3 245 |
| reasoning | median **3 812** | 15 852 | 8 748 |
| ₽ | median **1.412** | — (в metrics нет) | — |

Относительно opencode: total input **0.17×** (net-off) / **0.22×** (all); output **0.37×** /
**0.58×**; reasoning **0.24×** / **0.44×**. Но **fresh input у нас больше** (1.29× / 1.53×), а
cache hit хуже (71% против 96%): проекция элидирует закрытые состояния, поэтому суммарный
контекст радикально короче, но кэшируется хуже. Visible output практически совпадает.
K мал (3 против 2/5), temp 0.1 — это направление, не статистика.

Трассы: `bench/runs/sandbox-tasks/2026-10-23T04-29-17-477Z-fix-ocaml-gc`,
`…04-29-19-623Z…`, `…04-29-21-776Z…`.

## Батч 2026-10-23 — rootless D + workspace-relative paths, net off, K=3

`npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --net off --turns 60`, 3 параллельно,
официальный verifier. Текущее дерево на `63563cb` + незакоммиченный D: образ задачи стартует
rootless, file-tools/`bash`/jobs/checkpoint идут в контейнере (store `/tmp/.skein`), verifier —
в отдельном контейнере; `grep`/`listFiles` возвращают **workspace-relative** пути, как
`fsWorkspace` (не `/app/...`). State layer/prompt — как в `8dc3102`. Это чистый прогон:
без abort, все три дошли до официального verifier.

| run | шагов | вызовов | in | fresh | cache | hit | out (виз + реа) | peak chars | L stop | Patch | Verification | ₽ | reward |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|---|--:|--:|
| `16-32-18-116` | 27 | 27 | 196 293 | 60 613 | 135 680 | 69% | 7 636 (3 031 + 4 605) | 48 388 | t8 | t9–17 | t18–24 | **1.633** | **1** |
| `16-32-18-094` | 29 | 29 | 196 449 | 64 353 | 132 096 | 67% | 8 130 (3 798 + 4 332) | 58 812 | t10 | t11–18 | t19–26 | **1.732** | **1** |
| `16-32-18-093` | 29 | 29 | 239 499 | 65 035 | 174 464 | 73% | 9 046 (3 428 + 5 618) | 72 420 | t10 | t11–19 | t20–26 | **1.822** | **1** |
| **median** | **29** | **29** | **196 449** | **64 353** | **135 680** | **69%** | **8 130 (3 428 + 4 605)** | **58 812** | — | — | — | **1.732** | — |

Все три — `request_addressed`, `reward=1`, verifier `PASS test_tests_output`; правка одна и
та же: `p += Whsize_hd(hd)` → `p += wh` в `pool_sweep` (`runtime/shared_heap.c`). В каждом
прогоне был один retryable `No output generated` (в Verification); ходы не потеряны.

**Против pre-rootless батча `04-29`** (host `/app` + host fast-path `grep/list`):
median шагов **29 vs 26**, in **196 449 vs 163 568** (+20%), fresh **64 353 vs 51 084**
(+26%), cache hit **69% vs 71%**, out **8 130 vs 6 944** (+17%), ₽ **1.732 vs 1.412**
(+23%), peak chars **58 812 vs 58 504** (равно). L закрывается так же/лучше (t8/t10/t10
против t10/t8/t11); разрыв — в **Patch** (9/8/9 ходов против 6/7/8) и в большем fresh-входе.
Относительные пути убрали раздувание `/app/...`, но не объясняют остаток: это model/provider
variance + лишние `grep`/`bash`/`read` в Patch. K=3, temp 0.1 — направление, не статистика.

Трассы: `bench/runs/sandbox-tasks/2026-10-23T16-32-18-116Z-fix-ocaml-gc-AAFw9y`,
`…16-32-18-094Z-…-sVz2Qi`, `…16-32-18-093Z-…-bH2YAw`.

## Батч 2026-10-23 — breadth: `fix-code`, `fix-git`, `custom-memory` (net off, K=1)

Три остальные задачи набора `O → L → P → V`, по одному прогону, параллельно:
`npx tsx tests/sandbox/sandbox-run.ts <task> --net off --turns 60`. То же рабочее дерево,
что и в батче `fix-ocaml-gc` выше (восстановленный state-слой, reasoning on).

| задача | ходов | вызовов | in | fresh | cache | hit | out (виз + реа) | L stop | маршрут | ₽ | reward |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|--:|--:|
| `fix-code-vulnerability` | 25 | 29 | 131 597 | 38 669 | 92 928 | 71% | 3 399 (2 525 + 874) | t9 | L t3–9 → P t10–17 → V t18–23 → End t24 | **0.942** | **1** |
| `fix-git` | 19 | 24 | 90 466 | 30 306 | 60 160 | 67% | 4 297 (2 689 + 1 608) | t6 | L t3–6 → P t7–17 → **End t18** (V пропущена) | **0.847** | **1** |
| `custom-memory-heap-crash` | 60 | 88 | 525 154 | 107 362 | 417 792 | 80% | 25 979 (8 000 + 17 979) | t9 | L t3–9 → P t10–21 → V t22–27 fail → L t28–42 → P t43–51 → V t52–58 pass → End t59 | **3.822** | **1** |

Все — `request_addressed`, reward 1.

- **`fix-code-vulnerability`.** Guards в `_hkey`/`_hval` на `\n`/`\r`/`\0` + `report.jsonl`
  с `["cwe-93","cwe-20"]`; pytest и verifier прошли.
- **`fix-git`.** Нашёл dangling commit `650dba4` («Move to Stanford»), сверил с
  `resources/patch_files`, сделал cherry-pick/merge; `/tmp/recover.sh` — проверяемый рецепт.
  Модель **не заходила в Verification**: `Patch → End`; verifier всё равно прошёл.
- **`custom-memory-heap-crash`.** Финально `user.cpp` вызывает `std::_Facet_Register_impl()`
  в `user_init()` — facet-узлы аллоцируются до активации custom heap; обе сборки и valgrind
  чистые. Но путь дорогой: **4 цикла** и ровно 60 ходов (бюджет исчерпан на последнем ходу),
  17 979 reasoning, 3.822₽.

**Против session3 (K=3, `docs/plans/handoff_2026-10-20_localization_session3_ru.md`):**
fix-code 0.942₽ (было 0.81–1.32), fix-git 0.847₽ (было 0.86–1.30), custom-memory 3.822₽
(лучший cmh3 — 32 хода / 2.15₽; cmh1 3.80₽ без закрытия). То есть fix-code/fix-git — в норме,
**custom-memory — регрессия** по ходам и стоимости. K=1 на задачу, temp 0.1 — это наблюдение,
не статистика.

Трассы: `bench/runs/sandbox-tasks/2026-10-23T05-04-29-581Z-fix-code-vulnerability`,
`…05-04-31-786Z-fix-git`, `…05-04-33-824Z-custom-memory-heap-crash`.

## Батч 2026-10-23 — breadth, rootless D + workspace-relative paths (net off, K=1 на задачу)

`npx tsx tests/sandbox/sandbox-run.ts <task> --net off --turns 60`, три задачи параллельно,
по одному прогону, официальный verifier. Текущее дерево на `63563cb` + незакоммиченный D:
rootless, `grep`/`listFiles` возвращают workspace-relative пути. State layer/prompt — как в
`8dc3102`.

| задача | ходов | LLM/tool | in | fresh | cache | hit | out (виз + реа) | peak chars | stop | ₽ | reward |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|--:|--:|
| `fix-code-vulnerability` | 20 | 20/20 | 89 667 | 30 019 | 59 648 | 67% | 3 240 (1 998 + 1 242) | 19 027 | `request_addressed` | **0.769** | **1** |
| `fix-git` | 20 | 20/24 | 84 542 | 33 726 | 50 816 | 60% | 3 285 (2 378 + 907) | 21 627 | `request_addressed` | **0.833** | **1** |
| `custom-memory-heap-crash` | 60 | 60/70 | 504 734 | 94 878 | 409 856 | 81% | 18 968 (6 892 + 12 076) | 69 266 | **`max_turns`** | **3.114** | **1** |

`fix-code`/`fix-git` — чистые self-closure. `custom-memory` — `reward=1` по verifier, но
**не закрылся сам**: 60 ходов, последний ход `move`, не `stop`. Провайдерских retry в этих
трёх не было.

**Против pre-rootless breadth-батча `05-04`:**

- `fix-code`: **20 vs 25** ходов, **0.769 vs 0.942₽** (−18%), in **89 667 vs 131 597** (−32%).
- `fix-git`: **20 vs 19**, **0.833 vs 0.847₽** (−2%), in **84 542 vs 90 466** (−7%).
- `custom-memory`: **60 vs 60**, **3.114 vs 3.822₽** (−19%), in **504 734 vs 525 154** (−4%);
  но там `request_addressed`, здесь **`max_turns`** — стоимость лучше, закрытие хуже. В один
  ряд с закрытыми прогонами его не ставить.

Трассы: `bench/runs/sandbox-tasks/2026-10-23T17-15-08-536Z-fix-code-vulnerability-ztbKKL`,
`…17-15-08-508Z-fix-git-oYsqqe`, `…17-15-08-496Z-custom-memory-heap-crash-gUHPBo`.

## Батч 2026-10-23 — recovery (Research → Recovery), net off, K=1 на задачу

`npx tsx tests/sandbox/sandbox-run.ts <task> --net off --turns 40`, три задачи параллельно,
по одному прогону, официальный verifier. Текущее дерево на `63563cb` + незакоммиченный D:
rootless, `grep`/`listFiles` — workspace-relative. State layer/prompt — как в `8dc3102`.
Все три — Recovery-класс: `O → Research → Recovery → End`, без Localization/Verification.

| задача | ходов | LLM/tool | in | fresh | cache | hit | out (виз + реа) | peak chars | маршрут | ₽ | reward |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|--:|--:|
| `password-recovery` | 26 | 26/30 | 274 211 | 64 419 | 209 792 | 77% | 19 208 (6 337 + 12 871) | 66 760 | O → R → Recovery → End | **2.531** | **1** |
| `db-wal-recovery` | 22 | 22/25 | 133 968 | 39 888 | 94 080 | 70% | 7 924 (3 941 + 3 983) | 27 829 | O → R → Recovery → End | **1.278** | **1** |
| `crack-7z-hash` | 23 | 23/29 | 150 852 | 35 780 | 115 072 | 76% | 4 344 (2 653 + 1 691) | 28 365 | O → R → Recovery → End | **0.965** | **1** |

Все — `request_addressed`, `reward=1`; в каждом прогоне на ленте есть `Start state Research`
и `Start state Recovery`; provider retry не было.

**Против recovery-батча 2026-10-18** (5×40, средние, другой промт/harness — ориентир, не
статистика):

- `password-recovery`: 26 ходов против 34.2, in 274 211 против 234.1k, out 19 208 против 11.5k,
  **2.531 против 1.590₽** — дороже из-за reasoning 12.9k; ходов меньше.
- `db-wal-recovery`: 22 против 28.4, in 133 968 против 143.1k, out 7 924 против 9.0k,
  **1.278 против 1.160₽** — близко.
- `crack-7z-hash`: 23 против 30.7, in 150 852 против 159.5k, out 4 344 против 5.4k,
  **0.965 против 0.925₽** — близко.

Трассы: `bench/runs/sandbox-tasks/2026-10-23T17-24-05-064Z-password-recovery-JqJ0AD`,
`…17-24-05-074Z-db-wal-recovery-4eqN0L`, `…17-24-05-071Z-crack-7z-hash-L9Gpoj`.

## Батч 2026-10-20 — final conduct, net on, K=3

`npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --net on`, 3 параллельно, бюджет 60,
официальный verifier. Промт: hint = conduct; tail = **conduct → goal → criterion → stop**;
Localization — list directories + definitions + sibling comparison; Patch — previous
`Finish` line + «read the definition — the file that defines it, not a usage» + sibling
confirmation.

| run | шагов | вызовов | in | fresh | cache | hit | out (виз + реа) | ₽ | reward |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `18-27-57-021` | **24** | 24 | 137 379 | 45 987 | 91 392 | 67% | 7 763 (2 916 + 4 847) | **1.402** | **1** |
| `18-27-57-452` | 30 | 30 | 201 464 | 58 104 | 143 360 | 71% | 7 743 (3 664 + 4 079) | **1.634** | **1** |
| `18-27-56-831` | 29 | 29 | 270 713 | 68 985 | 201 728 | 75% | 15 641 (3 303 + 12 338) | **2.410** | **1** |
| **median** | **29** | **29** | **201 464** | **58 104** | **143 360** | **71%** | **7 763** | **1.634** | — |

Все три — `request_addressed`, `reward=1`. Среднее по трём: 1.815₽; сумма 5.446₽.

**Против opencode (5 прогонов, `net on/off`, все reward=1):**

| | Skein K=3 | opencode K=5 |
|---|---:|---:|
| шагов | 24 / 29 / 30 (median 29) | 24–33 (median 27) |
| ₽ | **1.402 / 1.634 / 2.410, median 1.634** | 1.455–2.793, median 1.974 |
| fresh in | 45 987–68 985 (median 58 104) | median 33 449 |
| всего in | median 201 464 | median 748 329 |
| cache hit | 67–75% | 95–97% |
| out | median 7 763 | median 11 993 |

Итог: **median на 17% дешевле opencode**; выигрыш — за счёт в 3.7× меньшего общего
контекста (закрытые состояния элидируются). Свежий input и cache hit у нас хуже.

**Оговорки.** В каждом прогоне был транзиентный `EPIPE` от API (внутренний retry, ходы не
потеряны). Официальный verifier — PASS (`reward=1`). Каталоги:
`bench/runs/sandbox-tasks/2026-10-20T18-27-56-831Z-fix-ocaml-gc`,
`…18-27-57-021Z…`, `…18-27-57-452Z…`. Тесты: `typecheck` чистый,
offline `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — 363 passed.

## Батч 2026-10-18 — обобщённые состояния, checkpoint/revert, terminal-bench breadth

> Это **не строки топ-10** (он про `fix-ocaml-gc`): сводка по остальным ported-задачам и по
> инфраструктуре песочницы. Все прогоны — `tests/sandbox` (Docker, без Harbor), та же модель,
> бюджет 40 ходов, если не указано иное.

**Промт/проекция.** Четыре состояния обобщены без новых островов: Orientation — «map the
material and how success is judged»; Localization — «find the target in the material»; Patch —
«make the change the goal names»; Verification — «check the change against the goal's
acceptance». Маркеры `Start state` / `Finish state` — `system`, закрытие —
`Finish … — your stop reason: …`. Добавлены provenance/honesty-правило («не синтезировать
значения; проверка, читающая только свой вывод, — не acceptance»), state-specific
`bash`/`webfetch`/write-контракт (`toolDescriptionsFor`), preserve-инвариант («копируй raw-
артефакты до команд, которые могут сделать checkpoint/удалить/перезаписать») и правило
`Verification → Patch` по умолчанию в `transitionInstruction`.

**Harness: workspace checkpoint.** Read-only снапшот task root:
`<root>/.skein/checkpoints` — content-addressed блобы + hardlink-деревья `trees/<n>/`
(initial после `setup`, далее per-turn), `restore.sh`/`README`; в контейнер монтируется
read-only (docker `-v :ro`, bwrap `--ro-bind`). Недоступные host-процессу файлы (root-owned
`john/run/john.log`) **пропускаются best-effort**: иначе snapshot падал и run завершался
`llm_error` — это дало ложные 0/5 на crack в первом батче. Revert последнего Patch теперь
восстанавливает **только изменённые им пути** (bash/write/apply_patch/удаления) из pre-patch
checkpoint; `reconcile` пишет один `mutate absent` для исчезнувшего witnessed-файла.

**Результаты (5×40, reward):**

| задача | reward | шагов (диапазон) | in (fresh + cache, hit) | out (виз + реа) | ₽/прогон | ₽ итого |
|---|---:|---:|---:|---:|---:|---:|
| `db-wal-recovery` | 5/5 | 28.4 (23–38) | 143.1k (26.5k + 116.5k, 81%) | 9.0k (4.1k + 4.9k) | 1.160 | 5.801 |
| `log-summary-date-ranges` | 5/5 | 18.6 (18–19) | 76.2k (18.7k + 57.5k, 76%) | 4.5k (2.9k + 1.6k) | 0.675 | 3.377 |
| `cobol-modernization` | 5/5 | 32.4 (29–40) | 236.7k (46.9k + 189.8k, 80%) | 17.6k (6.6k + 11.1k) | 2.175 | 10.875 |
| `fix-code-vulnerability` | 5/5 | 21.4 (20–23) | 103.9k (21.4k + 82.5k, 79%) | 3.4k (2.5k + 0.9k) | 0.655 | 3.277 |
| `password-recovery` | 5/5 | 34.2 (25–40) | 234.1k (38.5k + 195.5k, 84%) | 11.5k (4.4k + 7.2k) | 1.590 | 7.948 |
| `crack-7z-hash` | 3/3* | 30.7 (28–32) | 159.5k (27.4k + 132.2k, 83%) | 5.4k (3.2k + 2.2k) | 0.925 | 2.774 |

\* crack: 3 завершившихся **после фикса** checkpoint; 2 из 5 убиты abort'ом. Первый батч (до
фикса) дал 0/5 `llm_error` — это был баг harness, не задачи. Для чистого 5/5 нужен ещё прогон.

**db-wal: два батча.** Checkpoint-only (до revert-интеграции): 5/5, **3.83₽**, 117 шагов,
453.2k in (103.6k fresh + 349.6k cache, 77%), 25.7k out (14.8k + 11.0k). Checkpoint + revert:
5/5, **5.80₽**, 142 шага, 715.4k in (132.7k + 582.7k, 81%), 44.8k out (20.5k + 24.3k). Рост —
два recovery-прогона (30 и 38 шагов): в одном `sqlite3` удалил WAL и модель восстановила его из
`trees/1`; в другом bash-XOR Patch провалил Verification, и checkpoint-revert вернул pre-patch
WAL. Быстрые 3 прогона близки к checkpoint-only: 4.10k in/ход, 98 reason/ход, 0.0335₽/ход.

**opencode в нашей песочнице (только local; Harbor не используем).** Цена opencode берётся из
`reasoning.ndjson` (`usage.cost`, тот же провайдер/модель); для одного fix-ocaml-прогона цена не
захвачена и оценена по тем же ставкам (15₽/1M fresh, 0.41₽/1M cache, 83₽/1M output — сходится с
фактической ценой в пределах 0.03₽).

| задача | агент | reward | шагов | in (fresh + cache, hit) | out (виз + реа) | ₽/прогон |
|---|---|---:|---:|---:|---:|---:|
| `password-recovery` | Skein (5) | 5/5 | 34.2 | 234.1k (38.5k + 195.5k, 84%) | 11.5k (4.4k + 7.2k) | 1.590 |
| `password-recovery` | opencode (5) | 5/5 | 13.2 | 276.6k (24.8k + 251.8k, 91%) | 6.3k (2.0k + 4.3k) | 0.992 |
| `fix-ocaml-gc` net on | Skein (5) | 4/5 | 37.8 | 272.1k (56.9k + 215.1k, 79%) | 15.8k (4.3k + 11.6k) | 2.235 |
| `fix-ocaml-gc` net on | opencode (3) | 3/3 | 30.7 | 943.6k (30.9k + 912.7k, 97%) | 11.5k (3.4k + 8.1k) | ~1.79 |

Вывод: opencode экономнее по шагам и итоговой цене (`password` −38%, `fix-ocaml` −20%), но
тащит гораздо больше кешированного контекста; Skein дешевле **на шаг**, но делает больше шагов.
Для `cobol`/`fix-code`/`log-summary`/`crack`/`db-wal` локальных opencode-прогонов нет —
сравнение с Harbor исключено по указанию владельца; нужен отдельный локальный батч.

**Что показали старые провалы.** `log-summary` (`06-26-26-152`) закрылся за 6 ходов: старый
orientation→finish, «only move» на переходе и артефакт, объявленный готовым без наблюдения.
Текущий промт дал 5/5 (18–19 ходов). `fix-code` false pass (`06-23-57`): `pytest` прошёл, а
`report.jsonl` не создан; старый план закрытого состояния элидировал failed read. `cobol` 2/5 →
5/5, `fix-code` 3/5 → 5/5, `password` 4/5 → 5/5 после обобщения состояний и бюджета 40.

**Каталоги.** db-wal checkpoint-only: `2026-10-18T12-19-*`; db-wal checkpoint+revert:
`2026-10-18T12-35-*`; log-summary: `12-56-*`; cobol: `13-06-*`/`13-08-*`/`13-09-*`; fix-code:
`13-09-37`, `13-10-*`; password: `09-*`; crack: `13-14-51`, `13-15-04`, `13-15-42`; opencode
password: `06-54-*`; opencode fix-ocaml: `2026-10-09T16-01`, `2026-10-11T06-05`, `06-30`.

**Проверка.** `npm run typecheck` — зелёный; offline
`SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **346 passed**.

## Финальный батч (2026-10-17) — literal why, failed-attempt block, Verification→Patch

`fix-ocaml-gc --net on`, 5 параллельных прогонов. **5/5 `reward=1`**, `request_addressed`,
0 отказов, без `max_turns` и без финальных transport `llm_error`. Это текущий лучший
net-on батч: 29–50 шагов, **1.031–2.521₽**; все пять прогонов дешевле прежнего
net-on #4 (2.645₽).

| прогон | шагов | вызовов | in | fresh | cache | hit | out (виз + реа) | reason/out | ₽ | каталог |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|
| run1 `23-095` | 31 | 31 | 168 981 | 40 469 | 128 512 | 76.1% | 9 662 (3 358 + 6 304) | 65.2% | 1.465 | `2026-10-17T18-13-23-095Z-fix-ocaml-gc` |
| run2 `24-334` | 31 | 32 | 196 317 | 37 472 | 158 845 | 80.9% | 7 441 (3 940 + 3 501) | 47.1% | 1.263 | `2026-10-17T18-13-24-334Z-fix-ocaml-gc` |
| run3 `25-612` | 29 | 29 | 169 773 | 32 176 | 137 597 | 81.0% | 5 703 (3 009 + 2 694) | 47.2% | 1.036 | `2026-10-17T18-13-25-612Z-fix-ocaml-gc` |
| run4 `26-682` | 32 | 32 | 165 380 | 35 207 | 130 173 | 78.7% | 4 914 (3 147 + 1 767) | 36.0% | 1.031 | `2026-10-17T18-13-26-682Z-fix-ocaml-gc` |
| run5 `27-653` | 50 | 50 | 299 093 | 57 304 | 241 789 | 80.8% | 19 605 (5 409 + 14 196) | 72.4% | 2.521 | `2026-10-17T18-13-27-653Z-fix-ocaml-gc` |
| **итого** | **173** | **174** | **999 544** | **202 628** | **796 916** | **79.7%** | **47 325 (18 863 + 28 462)** | **60.1%** | **7.315** | — |

Средние: 5 778 input/ход, 274 output/ход, 165 reasoning/ход, 0.0423₽/ход, 1.463₽/прогон.
Пик контекста — 58 331 chars (run1). run5 — 34.5% стоимости и 49.9% всего reasoning.

**Что изменилось.**

- **Verification `stop.why` — literal retelling.** Команда, exit status и фактический текст
  ошибки; без диагноза кода и без «почему фикс не сработал». Модель больше не пишет
  «the applied patch is wrong» вместо ошибки.
- **`Previous failed attempt` в Localization и Patch** теперь берёт **модельный `why`** упавшей
  Verification и фактический diff последнего Patch; механический `lastFailingRun`/`git`/exit
  в блок не попадает. Блок говорит `has been reverted` и `Do not repeat this change`.
- **`Verification → Patch`** — новое ребро: если координаты Localization ещё верны, а не сработала
  только правка, модель может идти прямо в Patch. `isFailedVerificationMove` откатывает
  неудачный Patch на оба перехода (`Patch`/`Localization`). В run5 модель так и сделала:
  `verification → patch → verification`, 1 revert, 50 ходов; runs 1–4 — прямые.
- **Per-state `Island.hint` + общий closure-хвост:** Orientation — `pwd`/build/check; Localization —
  sibling walkers; Patch — «только названное изменение, не повторять failed attempt»;
  Verification — pass/fail/environment; Finish — `stop`. `turnInstruction` больше не смешивает
  состояния.
- **Model layer — AI SDK:** `createOpenAICompatible`, `generateText`/`streamText`, reasoning/usage
  из SDK; LangChain-адаптер и SSE-парсер удалены, `@langchain/openai` убран. `SKEIN_STREAMING`
  (дефолт on) выбирает `streamText`; reasoning на ленте по-прежнему `SKEIN_REASONING_TAPE`.
- Тесты: **336 passed** офлайн; typecheck чистый. План/статус — `docs/plans/ai_sdk_migration_plan_ru.md`.

**Stage-проверка ребра.** На двух отдельных stage-сэмплах sample1 (`624–627`) и затем на пяти
модель выбирала Localization (2/2 и 5/5), несмотря на доступное ребро: в Verification она видит
literal-ошибку и закрытый Patch, но не failed diff. В полном run5 ребро всё же сработало.
Один батч — не статистика; важно, что Localization после ошибки закрывается, а Patch с блоком
даёт верный tail.

Логи: `/tmp/opencode/fix-ocaml-final/run{1..5}.log`.

## Предыдущая версия (2026-10-17) — reasoning на ленте (A/B)

`fix-ocaml-gc --net off` (†), reward **1**, `request_addressed`, 0 отказов. Докса теперь видит
на ленте **свои прошлые рассуждения** — как в opencode (Vercel AI SDK) / OpenAI Agents SDK.

**Что реализовано.** Провайдерский адаптер (`src/llm/provider.ts`) round-trip'ит
`reasoning_content` (RouterAI отдаёт `reasoning`, LangChain его теряет), движок журналит
reasoning хода на узлах-действиях (`payload.reasoning`), проекция показывает его на
assistant-сообщении хода; фича **on** по умолчанию, `SKEIN_REASONING_TAPE=false` — выключатель
для A/B.

**Прогоны (net off, †, все reward 1):**

| прогон | шагов | вызовов | in | out (виз + реа) | cache | ₽ | локализация закрылась |
|---|--:|--:|--:|--:|--:|--:|--:|
| **runB** `05-16-41-582` (★) | **27** | 34 | **159 475** | 10 681 (2 901 + 7 780) | 72% | **1.60** | t11 |
| run1 `04-57-57-012` | 34 | 44 | 173 000 | 14 923 (3 296 + 11 627) | 71% | 2.00 | t14 |
| runA `05-16-41-598` | 32 | 40 | 222 135 | 14 603 (3 274 + 11 329) | 75% | 2.09 | t14 |

**Против opencode-off (†, `2026-10-11T06-52`):** вход **159–222k против 748 329** — в **3.4–4.7×** меньше
при том же reward. Это структурно: лента Skein — проекция IR (закрытые состояния элидируются,
наблюдения обрезаны), тогда как opencode пере-отправляет весь транскрипт и свой reasoning
целиком. Накладные на вход/выход состояния (5 `move` + 5 `stop` = 10 из 34 вызовов в runB) —
цена протокола; она окупается тем, что каждое состояние ведёт свою дешёвую ленту без дрейфа.

**A/B (reasoning on/off; тот же код и харнесс, меняется только `SKEIN_REASONING_TAPE`):**

| | локализация закрылась (t) | reason локализации | reason за прогон | fresh-вход | ₽ |
|---|---|---|---|---|---|
| **ON** (K=4) | 14, 15, 14, 11 | ~6.5k (медиана) | ~10.2k | ~49k | ~1.9 |
| **OFF** (K=3) | 14, 11, 14 | ~11.4k (медиана) | ~25.7k | ~49k | ~3.1 |

**Вывод.** Reasoning на ленте **не двигает момент закрытия локализации** (медиана ходов = 11 и
там, и там): исходная гипотеза «позднее закрытие от того, что модель не видит свой вывод» **не
подтвердилась**; прежний baseline n=30 был артефактом гарнитуры (удалённый replay-харнесс
`bench/step.ts` против полного цикла движка). Но фича даёт **меньше reasoning (~2.5×) и дешевле (~40%)**: добавленный контекст
почти весь уходит в `cacheRead` (fresh-вход равен ≈49k), а reasoning-токены (output, дорогой
тариф) падают. Поэтому оставлена **основным вариантом**.

## Стриминг-транспорт (A/B), 2026-10-17

`fix-ocaml-gc --net off` (†), K=3 на плечо; меняется один фактор — `SKEIN_STREAMING`
(on — `model.stream()` + склейка чанков; off — прежний не-стриминговый `invoke`). Промпт и
проекция те же (reasoning на ленте включён).

| плечо | reward | ходы | ₽ | fresh-вход | reason |
|---|---|---|---|---|---|
| **ON** | 1, 1, **0** | 29, 31, **60** | 2.13, 1.92, 5.23 | 55.6k, 49.6k, 126.3k | 12.2k, 11.0k, 32.1k |
| **OFF** | 1, 1, 1 | 32, 45, 30 | 1.98, 3.25, 1.62 | 53.1k, 72.3k, 46.7k | 10.0k, 20.3k, 7.4k |

**Механика.** Reasoning приходит дельтами (`delta.reasoning`) и переименовывается адаптером
(`fromChunk`); на ленте снова лежит (`payload.reasoning`, 56 записей за прогон, `reasoning.ndjson`
пишется). Ни одного `llm_error`; usage/cost берутся из терминального чанка; ретрай по
`finish_reason:"length"` срабатывает (ON-фейл: t58 `reason=8192` = потолок, дальше краткостный
повтор). Idle-таймаут не наблюдался.

**Вывод.** Транспорт работает и не хуже по стоимости на удачных прогонах; ON 2/3 против OFF 3/3 —
в пределах шума (единственный ON-фейл — неверная правка → цикл verification→localization, тот же
класс флейка, что и раньше; n мал). Оставлено **on по умолчанию**, `SKEIN_STREAMING=false` —
откат/плечо A/B.

Прогоны: ON `2026-10-17T08-04-06-897Z`, `08-19-58-026Z`, `08-29-13-482Z`; OFF
`08-10-30-333Z`, `08-38-55-578Z`, `08-49-29-101Z`.

## Последняя версия (2026-10-15) — наблюдаемые критерии состояний

`fix-ocaml-gc --net on`, reward **1**, `request_addressed`, 52 хода, 7.30₽
(`bench/runs/sandbox-tasks/2026-10-15T19-24-07-130Z-fix-ocaml-gc`). Разбивка по состояниям:

| состояние | ходы | закрытие |
|---|---|---|
| Orientation | t1–t4 | layout/build known |
| **Localization** | t5–t36 | `why`: «Offending file: **ocaml/runtime/shared_heap.c** — function **pool_sweep** (line 650): `p += Whsize_hd(hd)`…» |
| **Patch** | t37–t40 | один `edit`: `p += Whsize_hd(hd);` → `p += wh;` (верная однострочная правка) |
| **Verification** | t41–t50 | `make -C testsuite one DIR=tests/basic` → passes |
| Finish | t51 | `request_addressed` |

**Что нового в формулировках** (правится вручную):

- **наблюдаемые критерии** состояний (`src/ir/islands.ts`): `Localization` = «the failure is
  located — the file(s) and the offending code are named»; `Patch` = «the fix is applied in the
  workspace»; `Verification` = «the request's acceptance command now passes» (было «the cause is
  understood» / «the change is in the workspace» / «the failing command now passes»);
- **`stop`** (описание инструмента): результат состояния, без «next state»; `why` обязателен;
- **`turnInstruction`** (рабочий нудж): называет критерий явно, убраны «otherwise … single next
  step» и next-state-осколок;
- **`transitionInstruction`** (хинт перехода): ссылается на строку `Finish state <label>` только
  что закрытого состояния как **источник** `what`/`done`; `done` у `move` — обязателен.

**Ключевой эффект:** локализация **закрылась** (наблюдаемый критерий) и назвала
файл:функцию:строку + виновный код; Patch **унёс файл** в `what`/`done` и сделал **одну точечную
правку** — без `stale_base`-шторма. Против регресса `2026-10-15T15-36-50` (reward 0, локализация
не закрылась за 60 ходов) — см. «Фаза 20». Осталось: локализация всё ещё длинная (32 хода);
батчинг-`stale_base` корень не тронут (правка была однострочной).

## Фаза 20 — лента состояний (`Start state` / цель / `Finish state`), 2026-10-15

Новая лента: `move`/`stop` — **не вызовы инструментов**, а маркеры `Start state <label>` /
`Finish state <label> — <why>`; цель состояния — ход `user` (запрос, конкретизированный), а сам
запрос — временный `user`-ход, показываемый только на решении о состоянии (`docs/ir_semantics_ru.md` §7).
**Виртуальная спека (живой прогон, без Docker/Harbor;** `npx tsx tests/sandbox/live-trace.ts 40`**;
вердикт спеки `fixed`, не верификатор задачи):**

| вариант | вердикт | ходов | вызовов | in | out (виз + реа) | cache | стоимость | каталог |
|---|---|---|---|---|---|---|---|---|
| до фикса `recall` | fixed ✔ / `request_addressed` | 30 | 30 | 81 117 | 9 024 (2 617 + 6 407) | 76% | 1.02₽ | `…sandbox-live-2026-10-15T14-32-34-954Z-fix-ocaml-gc` |
| **после фикса `recall`** | fixed ✔ / `request_addressed` | **21** | 21 | 47 572 | 3 267 (1 682 + 1 585) | 79% | **0.42₽** | `…sandbox-live-2026-10-15T15-34-29-956Z-fix-ocaml-gc` |

**Фикс `recall`** (`recall`/`search` стали узлами состояния — тело живёт в ленте до `stop`; рабочий
набор и TTL сняты): отказов **0** (было 6), `recall` **2** (было 9, петля t7–t13 ушла), вход вдвое
меньше. Пошаговая таблица ниже — прогон «до фикса».

### Песочница Docker, `fix-ocaml-gc --net on` — **РЕГРЕСС** (reward 0), 2026-10-15

`npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --net on` → reward **0**, `stop=max_turns`,
**60 ходов**; in **1 721 338** (fresh 150 266 + cache 1 571 072, 91%), out 104 320 (**виз 9 304 +
реа 95 016**), **14.3₽**, chars 2 200→**147 952** (пик); один reasoning-шторм (t39: реа 8 192).
Каталог: `bench/runs/sandbox-tasks/2026-10-15T15-36-50-341Z-fix-ocaml-gc`.

**Диагноз.** Orientation закрылась ок (t0–t4, чистый `stop`), но **локализация не закрылась вовсе**
(t5–t59) и ушла **мимо**: отладка bootstrap (`boot/ocamlc`, `./configure`, `make world`, gdb) и затем
**`major_gc.c`** (маркировка/`Is_young`/`pb_push`, `Debug_free_major`, диффы с upstream-референсами
major_gc) — так и **не дойдя до `shared_heap.c`/`pool_sweep`**; ~19 ходов с провалившимися командами.
Причина — потеря **цепочки между состояниями**. Успешный net-on прошлого дизайна (Phase 18,
`2026-10-14T05-37`, 29 ходов, reward 1) держался на (а) **широкой** цели orientation («Understand how
to build/test … **locate the sweeping/free-space changes in the major GC**, and reproduce the bootstrap
crash» — из неё orientation грепала `runtime/shared_heap.c`) и (б) **`note`** — сводке оставляемого
состояния («Recon: … changes in `runtime/shared_heap.c`/`.h`»), которая нацеливала следующий `move`
(«Read `runtime/shared_heap.c` and `runtime/caml/shared_heap.h` …»). В Phase 20 orientation сужена до
«layout известен», а `note` из контракта `move`/B9 убран — локализация стартовала **без указателя**
(её цель «Find why the compiler crashes during bootstrap» — причинная) и ушла в неверную ветку. В
виртуальной спеке это незаметно (4 файла — «слепая» локализация сразу попадает в `shared_heap.c`);
на реальном дереве — вылезло. **Фикс не выбран** (варианты: вернуть `note`-цепочку / расширить
orientation / нацелить локализацию на «найти файлы»).

**Разбивка по ходам** (прогон «до фикса recall», виртуальная спека, 30 ходов; in / out виз+реа / cache / chars):

| фаза | ход | действие | in | out (виз+реа) | cache | chars |
|---|---|---|---|---|---|---|
| ориентация | t0 | `move` Orientation | 1 471 | 100 (85+15) | 0 | 2 206 |
| | t1 | `list .` | 2 165 | 41 (35+6) | 2 048 | 1 648 |
| | t2 | `read HACKING.adoc` | 2 343 | 155 (146+9) | 2 048 | 2 058 |
| | t3 | **`stop`** | 2 726 | 183 (100+83) | 2 048 | 2 627 |
| локализация | t4 | `move` Localization | 1 448 | 223 (83+140) | 0 | 2 478 |
| | t5 | `list .` | 2 269 | 84 (35+49) | 2 048 | 2 031 |
| | t6 | `read shared_heap.c` | 2 447 | 180 (146+34) | 2 176 | 2 441 |
| | t7 | `recall obs:39` | 2 730 | 293 (129+164) | 2 176 | 2 811 |
| | t8 | `recall obs:39` ✗ | 2 849 | 179 (99+80) | 2 176 | 2 986 |
| | t9 | `recall obs:39` ✗ | 2 927 | 436 (99+337) | 2 304 | 3 094 |
| | t10 | `recall obs:39` ✗ | 2 927 | 282 (69+213) | 2 816 | 3 094 |
| | t11 | `recall obs:39` ✗ | 2 927 | 145 (39+106) | 2 176 | 3 094 |
| | t12 | `recall obs:39` ок | 2 927 | 215 (71+144) | 2 176 | 3 094 |
| | t13 | `recall obs:25` ✗ | 2 942 | 158 (99+59) | 2 176 | 3 130 |
| | t14 | **`stop`** | 3 020 | 190 (99+91) | 2 816 | 3 238 |
| патч | t15 | `move` Patch | 1 552 | 1 022 (87+**935**) | 0 | 2 882 |
| | t16 | `grep Wosize_hd` | 2 778 | 75 (64+11) | 2 048 | 2 444 |
| | t17 | `read shared_heap.c` | 3 045 | 50 (44+6) | 2 048 | 3 055 |
| | t18 | `recall obs:39` ✗ | 3 127 | 172 (39+133) | 2 944 | 3 150 |
| | t19 | `search obs:39` | 3 205 | 736 (104+**632**) | 2 944 | 3 258 |
| | t20 | `grep RLE\|sweep` | 3 658 | 931 (124+**807**) | 2 944 | 4 176 |
| | t21 | `recall obs:39` ок | 3 744 | 576 (39+**537**) | 2 944 | 4 497 |
| | t22 | **`edit pool_sweep`** | 3 914 | 958 (142+**816**) | 3 584 | 4 796 |
| | t23 | `read shared_heap.c` | 3 914 | 70 (44+26) | 2 944 | 4 551 |
| | t24 | **`stop`** | 4 046 | 88 (79+9) | 3 840 | 4 762 |
| верификация | t25 | `move` Verification | 1 639 | 942 (95+**847**) | 1 280 | 3 188 |
| | t26 | `bash make -C testsuite …` | 2 471 | 72 (64+8) | 2 176 | 2 768 |
| | t27 | **`stop`** | 2 612 | 84 (64+20) | 2 432 | 3 019 |
| финиш | t28 | `move` Finish | 1 718 | 252 (173+79) | 0 | 3 466 |
| | t29 | **`stop`** → request_addressed | 1 576 | 132 (121+11) | 0 | 3 276 |

**Не сравнимо с топ-таблицей** (другой харнесс: виртуальная спека, не `sandbox-tasks`/Harbor).
Полный `sandbox-tasks` прогон на новой ленте — отдельно.

### 2026-10-14 — Фаза 18 (активные директивы), два варианта формулировки

Промпт-правки (директивы состояний в императив, `Now:` в описании состояния) проверены полным
прогоном `fix-ocaml-gc` в двух вариантах формулировки локализации/наблюдения: **pre-fix**
(«make the edit this turn» — правка внутри локализации) и **post-fix** («name it, then `stop`» —
выравнивание под протокол).

| вариант | net | шагов | reason | costo | stop | каталог |
|---|---|---|---|---|---|---|
| **pre-fix** | on | **29** | **13 021** | **2.645₽** | request_addressed | `bench/runs/sandbox-tasks/2026-10-14T05-37-29-796Z-fix-ocaml-gc` |
| pre-fix | off | 60 | 168 345 | 17.921₽ | **max_turns** | `bench/runs/sandbox-tasks/2026-10-14T06-26-36-654Z-fix-ocaml-gc` |
| post-fix | on | 51 | 52 542 | 6.746₽ | request_addressed | `bench/runs/sandbox-tasks/2026-10-14T06-47-00-005Z-fix-ocaml-gc` |
| post-fix | off | 57 | 97 696 | 20.408₽ | request_addressed | `bench/runs/sandbox-tasks/2026-10-14T06-59-11-252Z-fix-ocaml-gc` |

**Pre-fix net on — лучший net on за всю историю** (29 шагов, 2.645₽ против 33/2.93₽ у #6).
Механизм: «правь в этот ход» форсирует решение в локализации и гасит пере-вывод. **Но pre-fix net
off — регресс** (`max_turns`): правка в локализации нарушает протокол «локализация называет — патч
правит», и Patch открывается с уже сделанной правкой (модель в reasoning видит «line 650 shows
`p += edit` — maybe already fixed?» и перевыводит). **Post-fix net on хуже и pre-fix, и истории** —
без «edit now» возвращается медленный путь. Оставлен **pre-fix** (лучший net on); net-off-петля —
отдельная проблема (reference-trap + правка не в том состоянии), разбор — в
`docs/plans/prompt_stall_investigation_ru.md` §6.

**Пометки об условиях.** † — прогон **после удаления оракула**: верификатор задачи
(в т.ч. harbor-овский `tests/test.sh`, называющий ломающий тег `tag_purposefully_broken_sweeping_changes`)
больше **не** кладётся в workspace агента — он ставится только после хода агента, перед проверкой
(`tests/sandbox/harness.ts`, `stageVerifier`). ‡ — прогон **с утечкой**: утёкший `test.sh` лежал в
workspace, и opencode прочитал из него репозиторий и тег автора бенчмарка.

**Честная матрица 2×2 (все reward=1, оракул убран).** В строке меняется только доступ к сети,
в столбце — агент.

| | opencode | Skein |
|---|---|---|
| **net on** | opencode `06-30`: 7 388 reasoning / 1 430 864 in / 33 шага | Skein `13-21`: 20 105 / 702 152 / 33 |
| **net off** | opencode `06-52`: 13 114 / 748 329 / 24 | Skein `13-50`: 77 717 / 981 165 / 45 |

Снятие сети почти не меняет opencode (7 388→13 114), но резко поднимает reasoning Skein
(20 105→77 717, ×3.9) и число шагов (33→45): без оракула (upstream через `webfetch` → 403)
модель перебирает `bash` и жжёт reasoning. Разрыв без сети ещё шире: **opencode 13 114 против
Skein 77 717 (≈5.9×)**. Дороговизна Skein не сводится к доступу к оракулу — она растёт именно
от его отсутствия. Оба столбца Skein — один и тот же промпт (Фаза 14), так что это честная
пара net on/off.

## Новая точка отсчёта и A/B индекса инструментов (B12), 2026-10-11

Новая точка отсчёта — строка **#5**: net on, reward 1, **само-`stop`**, **33 шага / 2.93₽** —
лучший прогон Skein на сегодня. Состояние на момент записи: промпт структурно переписан
(Фаза 14, S1–S4 — контракт, ситуация запроса, ситуация цели); блок **B12** (индекс
инструментов) удалён; на месте нативная поверхность инструментов, `bash workdir`/`timeout`,
фикс `call` у seed-действия (без `human OBSERVATION`) и рендеринг краша; ренейм `list`↔`glob`
**откачен** (`list { path?, include?, from? }`). Однострочная правка
`p += Whsize_hd(hd);` → `p += wh;` в `pool_sweep`; модель сама вызвала `stop`.

**Как получилось.** Гипотеза была, что дрейф модели в `bash`-штурм связан с удалением индекса
инструментов. Поставили контролируемый A/B: два прогона `--net on --turns 40` на одном и том
же дереве, различается **только** наличие B12 в промпте.

| B12 | шагов | вызовов | `edit` | `stop` | in | out (виз + реа) | cache | стоимость | каталог |
|---|---|---|---|---|---|---|---|---|---|
| **есть** | 40 | 40 | 1 | **max_turns** | 1 043 903 | 56 162 (3 314 + 52 848) | 95% | 6.44₽ | `bench/runs/sandbox-tasks/2026-10-11T13-06-44-848Z-fix-ocaml-gc` |
| **нет** (#5) | 33 | 33 | 3 | **request_addressed** | 702 152 | 23 003 (2 898 + 20 105) | 88% | 2.93₽ | `bench/runs/sandbox-tasks/2026-10-11T13-21-36-838Z-fix-ocaml-gc` |

Оба решили задачу (reward 1) — правку модель находит в обоих случаях. Но с индексом модель
читала и диффила больше, сделала **одну** правку и **не остановилась** (упёрлась в
`max_turns`, реа 52 848); без индекса — **три** правки, чистый `stop` и **вдвое** дешевле.
Причина: описания инструментов в промпте работают как (плохо написанные) якорные примеры,
которым модель подражает. **Решение: B12 удалён**; описания остаются только в поле `tools`
запроса (инвариант §1.4 `docs/system_prompt_ru.md`). Оговорка: по одному прогону на ветвь —
направление ясное, но не статистика.

**Текущая пара net on/off (Фаза 14).** `--net off` на том же промпте — строка **#6**: reward 1,
само-`stop` на t44, но **45 шагов / 6.04₽** (реа **77 717**, виз 3 577; in 981 165, fresh
80 301, cache 92%). Без сети `webfetch` к upstream идёт на хостовый allowlist-прокси и получает
**403** — все **4** попытки провалились (t13, t18, t23, t31), модель ушла в `bash`-перебор
(**27** вызовов против 16 в net on) и сделала правку лишь на **t39** (против t20 в net on). Два
кап-хита (t32, t39, по 8 192 реа) — **24%** стоимости; top-8 ходов по reasoning — 63%.
Итог: без оракула reasoning ×3.9, стоимость ×2.1 при почти том же свежем вводе.

Для истории — прежняя точка отсчёта (то же дерево, но промпт **до** Фазы 14, без B12):
`2026-10-11T10-38-01` (net off, 32 шага, 58 551 реа, 10.43₽) и `2026-10-11T10-25-39`
(net on, 40 шагов, 62 438 реа, 12.06₽). Reward-0 прогоны того же дня:
`2026-10-11T09-18-55` (60 ходов, 142 270 реа, 25.46₽) и `2026-10-11T10-04-08`
(эксперимент с ренеймом `glob`: 60 ходов, 154 361 реа, 27.16₽ — `glob` ни разу не вызван).

## Архитектура «цель внутрь move» (состояние = цель), 2026-10-13

Перепроектирование: узел `goal` и оператор `create_goal` удалены — состояние (`move`) несёт
свой текст цели (`what`), план висит прямо на `move`, а первый пункт плана — обычный `apply`
(`docs/plans/archive/goal_into_move_plan_ru.md`). Поверхность инструментов = фронт (`applicable`),
поэтому после `stop` предлагается только `move` (цикл после остановки невозможен по
построению). Промпт — Фаза 14 плюс эти изменения. Два прогона `fix-ocaml-gc`:

| | opencode (baseline) | Skein goal-based (Фаза 14) | Skein goal-into-move |
|---|---|---|---|
| **net on** — reward | 1 | 1 | **1** |
| net on — шагов / вызовов | 33 / 36 | 33 / 33 | 52 / 71 |
| net on — in | 1 430 864 | 702 152 | **507 700** |
| net on — out (виз + реа) | 11 399 (4 011 + 7 388) | 23 003 (2 898 + 20 105) | 23 758 (5 040 + 18 718) |
| net on — cache | 97% | 88% | 63% |
| net on — стоимость / время | ~314 s | **2.93₽** | 5.04₽ |
| **net off** — reward | 1 | 1 | **1** |
| net off — шагов / вызовов | 24 / 31 | 45 / 45 | 49 / 72 |
| net off — in | 748 329 | 981 165 | **537 153** |
| net off — out (виз + реа) | 15 834 (2 720 + 13 114) | 81 294 (3 577 + 77 717) | **44 498** (5 044 + 39 454) |
| net off — cache | 96% | 92% | 64% |
| net off — стоимость / время | ~279 s | **6.04₽** | 6.70₽ |

**Токены.** Вход **вдвое меньше** (net off: 981 165 → 537 153; net on: 702 152 → 507 700), но
состав другой: *свежий* ввод **вырос** (net off 194 497 против ~80 301; net on 186 292 против
~84 258), а `cacheRead` **упал** (≈322–343k против ~618–900k), отсюда и низкий cache-hit
(63–64% против 88–92%). Причина: лента теперь перестраивается на каждом состоянии — `move`
несёт `what`, состояния и переходы меняют префикс, план пересоздаётся первым `apply` — поэтому
переиспользование кэша хуже; но суммарный вход всё равно меньше. `out` почти тот же по
величине, но в нём больше **видимого** вывода (≈5 040 против 2 898–3 577: модель пишет `what`
на каждое состояние) и, главное, меньше **reasoning**.

**Главный эффект — reasoning без сети упал вдвое:** 77 717 → **39 454** (×0.51). С сетью
reasoning почти тот же (20 105 → 18 718). Стоимость сопоставима (net off +11%: 6.04 → 6.70₽;
net on дороже: 2.93 → 5.04₽ — но там число шагов выросло 33 → 52). Шагов больше (52/49 против
33/45) — объявленных состояний и переходов теперь реально несколько, а не одно.

**Против opencode.** Разрыв по offline-reasoning сузился с ≈5.9× до **≈3.0×** (13 114 →
39 454), по net-on — с ≈2.7× до ≈2.5× (7 388 → 18 718). По входу новая архитектура теперь
**ниже** opencode в обоих режимах (507 700 против 1 430 864 с сетью; 537 153 против 748 329
без).

**Мотивирующий прогон.** Прошлая (goal-based) промежуточная версия на том же дереве дала
reward 0 (`no_progress`, 46 ходов): после единственного `stop` доxa 19 ходов чередовала
`create_goal`/`apply`, потому что недопустимый инструмент всё ещё предлагался. Новая
архитектура убрала сам оператор — в этих прогонах отказов всего **2** (net on) и **5** (net off).

## Анти-VCS чистка промта (B19 + B7), 2026-10-13

Ревью промтов нашло причину git-рефлекса, описанного в `docs/tools_ru.md` §5–6: обязательный
пункт «не полагайся на VCS» в промте **отсутствовал**, а описание `bash` называло
`git status/diff/log`. Правки:

- **B19** (новый, в базе): «воркспейс — источник правды: не предполагать VCS, `git`, diff или
  историю; сбой `git` не повторяется».
- **B7** переписан — убрано «make the first action a DISCOVERY one (e.g. `bash ls`)»; теперь
  «сделай первый шаг состояния … опирайся на цель и ленту; истории изменений не ищи».
- **Описание состояния** (`What / Done when`) переехало из переинжектируемого каждый ход блока в
  единственный `system`-ход на ленте (показывается один раз при входе); инструкция ситуации
  теперь дописывается **в конец** и временна (в историю не пишется). Чистка блоков: B0+B1 слиты,
  B18 удалён, дубли trust / «apply refused» сняты.

Прогон (net on, †): reward 1, `request_addressed`, 46 шагов / 66 вызовов, in 761 596
(fresh 127 228 + cache 634 368, hit 83%), out 48 548 (4 699 + 43 849), **6.97₽**. Против **того
же дня на промте до чистки** (goal-into-move): reward 1, но `max_turns`, 60 шагов, 22.64₽ — теперь
само-закрытие за 46 шагов и втрое дешевле. Два зонда `git` выжили (t9, t24), но в шторм не ушли;
отказов 0. По шагам — середина (лучший 33, #5); по входу — ниже старых строк (900k–2,1M), выше
goal-into-move (507k).

## opencode на `fix-ocaml-gc` (наша песочница)

Прогоны: `tests/sandbox/opencode-run.ts` (Docker, **без Harbor**) запускает opencode
внутри образа задачи `alexgshaw/fix-ocaml-gc:20251031`; результат оценивает верификатор самой
задачи (`check.code = 0`, `PASS test_tests_output`). Модель
`routerai/~deepseek/deepseek-v4-flash-latest`, `--variant low`.

- **net off (#1).** `--network bridge` + `HTTP(S)_PROXY` на хостовый прокси-белый список,
  разрешающий только `routerai.ru` (github 403). Локализовал чтением, без upstream-копии:
  27 шагов, 41 вызов (`bash 27, read 12, grep 1, edit 1`). Одна правка; reward 1.
- **net on, ‡ (#2).** Обычный `--network bridge`: opencode клонирует `github.com/sadiqj/ocaml`
  и по истории git находит ломающий коммит, затем правит. 33 шага, 32 вызова
  (`bash 31, edit 1`). Дешевле по токенам (клон заменяет чтение), но медленнее и возможен
  только с сетью. **Важно:** репозиторий и тег он взял из утёкшего `tests/test.sh` (пометка ‡),
  то есть это прогон с оракулом в дереве.
- **net on, † (#3).** После удаления оракула (`stageVerifier`): тег автора больше не в дереве.
  opencode всё равно решает (reward 1), но путь другой — ручная деривация (пик reasoning
  ~10 426 симв. на одном ходе) и затем поиск **в публичном** upstream через GitHub API:
  находит реальный коммит/PR OCaml, качает `shared_heap.c`, `diff`, правит. 33 шага, 36 вызовов
  (`bash 30, read 5, edit 1`); вход вырос до 1 430 864 (поиск по сети), а reasoning — 7 388,
  то есть не вырос. Контекст-пик 215 100 символов. Вывод: убрать утечку необходимо, но на
  **net on** публичный upstream остаётся легитимным оракулом для реального бага OCaml.
- **net off, † (#4).** После удаления оракула и с закрытой сетью (allowlist-прокси: `webfetch`
  и `curl` к github → **403**). opencode всё равно решает (reward 1), локализовав
  **чтением + сравнением**: строка-аномалия `p += Whsize_hd(hd)` в `pool_sweep` против
  правильного паттерна `p += wh` в соседних циклах того же файла (`pool_finalise`,
  `verify_pool`, `calc_pool_stats`). 24 шага, 31 вызов (`bash 19, read 10, webfetch 1, edit 1`),
  in 748 329, reasoning **13 114** (пик 10 156 на одном ходе), 279 s. **Самый дешёвый по шагам
  прогон и «без оракула» вовсе.**

Все — не строки Skein: это baseline opencode на той же задаче/песочнице. Записано по просьбе
владельца.

## Skein на `fix-ocaml-gc` (наша песочница)

`npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc` (Docker, **без Harbor**) запускает агента
внутри образа задачи; результат оценивает верификатор самой задачи (`check.code = 0`,
`PASS test_tests_output`). Модель `routerai/~deepseek/deepseek-v4-flash-latest`,
`SKEIN_REASONING_EFFORT=low`, бюджет задачи 60 ходов.

- **net on (#10, `19-02`) — текущий net on (анти-VCS чистка).** 46 шагов, 66 вызовов (все
  приняты), чистый `stop = request_addressed`; **6.97₽** (in 761 596: fresh 127 228 + cache
  634 368 = 83%; out 48 548: 4 699 + 43 849; пик контекста 142 602). Первый прогон после B19/B7 и
  переноса описания состояния в ленту. Локализация чтением, `edit` 1×, затем `./configure` `make`
  `make -C testsuite one DIR=tests/basic`; верификатор прошёл. Два `git`-зонда (t9, t24) не разрослись.

- **net on (#5, `13-21`) — новый лучший.** 33 шага, 33 вызова, `edit` 3×, чистый
  `stop = request_addressed`; **2.93₽** (реа 20 105; стартовый контекст ~2.3k символов — без
  индекса инструментов). Промпт Фазы 14 (S1–S4), **B12 удалён** — см. A/B выше. Однострочная
  правка `p += Whsize_hd(hd);` → `p += wh;` в `pool_sweep`; верификатор прошёл.
- **net off, † (#6, `13-50`) — текущий net off.** 45 шагов, 45 вызовов, `edit` 1×, чистый
  `stop = request_addressed` на t44; **6.04₽** (реа 77 717; `bash` 27, `fetch` 4 — все 403).
  Без оракула правка только на t39, два кап-хита (t32, t39). Промпт Фазы 14 (B12 удалён), та же
  однострочная правка `pool_sweep`; верификатор прошёл.
- **net on (#7, `05-13`).** 35 шагов, 35 вызовов (все приняты), чистый
  `stop = request_addressed`; 4.85₽. Первый прогон после фиксов
  нативных ролей и дедупликации: маркер альтернативы больше не переклеивает тело провала,
  а у нативных узлов его нет вовсе. Пик контекста упал с 352k до 94 450 символов (−73%),
  свежий ввод — 79 494 (−59%), reasoning — 54 999 (−39%), стоимость — вдвое. Та же
  однострочная правка в `pool_sweep` (`p += Whsize_hd(hd);` → `p += wh;`); верификатор
  прошёл. Пошаговый reasoning — в `reasoning.ndjson`.
- **net on (#8, `18-30`).** 41 шаг, 41 вызов (все приняты). Срезанный промт — без `sketch`/`why`
  плюс правило короткого reasoning / запрета припоминания кода в B13 — снизил reasoning до
  89 555 (с 104 504 ниже) и дал чистый `stop = request_addressed`; 12.68₽. Та же однострочная
  правка в `pool_sweep` (`p += Whsize_hd(hd);` → `p += wh;`); верификатор прошёл. Модель всё
  ещё качала upstream дважды (дифф-искательство осталось), контекст вырос до 352k символов
  (пик); один ход упёрся в completion-cap и восстановился через reasoning-off ретрай.
  Пошаговый reasoning — в `reasoning.ndjson`.
- **net on (#9, `08-40`).** 50 шагов, 50 вызовов (48 ок / 2 отказа). Первый reward-1 на
  ревизованном IR. Локализовал чтением (`read`/`grep` по `runtime/shared_heap.c`), скачал
  upstream `shared_heap.c`, сделал `diff` и ту же однострочную правку; завершился `llm_error`
  (сбой модели), а не само-`stop`, — работа к тому моменту сделана. Время не записано.
- **net off, † (#10).** Честное «без оракула и без сети»: хостовые `fetch`/фоновый `run` через
  allowlist-прокси (github → 403; `fetch` вызывался 2× и провалился). 31 шаг, 31 вызов (все
  приняты), чистый `stop = request_addressed`; 13.78₽. Reasoning вырос до **77 942** (in 702 484,
  fresh 55 060, cache 92%; пик контекста 78 572) — выше, чем с сетью (#7): без оракула Skein
  выводит строку вручную. Та же однострочная правка `p += Whsize_hd(hd);` → `p += wh;`.

## 2026-10-24 — сеть, приёмка `test.sh`, network probe, Construction A/B

**Harness.** Docker-задача теперь принимается родным `tests/test.sh` в контейнере агента
после него; reward читается из `/logs/verifier/reward.txt`, а не из exit code. `--net`
управляет только агентом: `on` — bridge, `off` — сеть снята; verifier всегда с сетью, потому
что `test.sh` сам ставит runtime (`uv`/Python). `checkIn`/`SKEIN_VERIFIER_IMAGE` ушли из
task-пути. В probe добавлен engine-owned `network: on|off`; он рендерится в environment brief.

**`regex-log`, old prompt + probe, K=3.** Все reward=1.

| режим | turns (median) | ₽ median | reasoning median |
|---|---:|---:|---:|
| net off | **13** (13/13/13) | **1.842** | 17 362 |
| net on | 16 (18/13/16) | **1.599** | 10 641 |

**opencode в той же песочнице, `test.sh`.** net on — 15 шагов / ~1.61₽; net off — 17 шагов /
~1.62₽ (цена оценена по ставкам провайдера). Python в образе нет; opencode с сетью on сам его
не ставит и проверяет Perl.

**Construction A/B — отрицательный.** Новый промт (declared engine, do not weaken) дал off
median 17 / 1.906₽, on 15 / 1.762₽ против old+probe 13 / 1.842₽ и 16 / 1.599₽. Ребро
`Orientation → Construction` дало off 17 / 2.022₽, on 13 / 2.025₽. Оба откачены. Дешёвый
`bench/turn.ts --rebuild` показал, что выбор перехода корректен (`regex-log` 9/9 Construction,
`cobol` 3/3 Research, `openssl` 3/3 Construction), но Research структурно полезен: без него
reasoning переезжает в Construction и стоимость растёт.

Каталоги: `bench/runs/sandbox-tasks/2026-10-24T07-00-47-*` (old off),
`…07-11-47-*` (old on), `…06-21-55-*` / `…06-50-22-*` (prompt A/B),
`…07-08-30-*` / `…07-51-06-*` / `…07-54-46-*` (edge A/B),
`…05-41-47-*` / `…05-44-35-*` (opencode on/off).

## Дальше

- **2026-10-18:** checkpoint/revert и обобщённые состояния дали 5/5 на
  db-wal/log-summary/cobol/fix-code/password; crack — 3/3 (нужен чистый 5/5). Локальные
  opencode-прогоны есть только для password и fix-ocaml; для остальных задач сравнительный
  ряд ещё не снят.
- Добавлять других агентов/задачи по мере прогонов (`sandbox-tasks/`), держа топ-10 по
  правилу выше.
- Пара `net off` (Skein и opencode, пометка †) **прогнана**; честная матрица 2×2 — выше.
  Реализовано: `sandbox-run.ts --net off` (хостовые `fetch`/фоновый `run` через allowlist-прокси).
- Разрыв по offline-reasoning **закрыт**: эволюция net off ~5.9× (goal-based) → ~3.0×
  (goal-into-move) → **~0.8×** (2026-10-17, reasoning на ленте: Skein ~10.2k против opencode-off
  13 114). Остаётся разрыв по **входу** — за счёт проекции он теперь в пользу Skein (159–222k
  против 748 329).
