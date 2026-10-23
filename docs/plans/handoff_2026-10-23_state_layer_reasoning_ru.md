# Handoff — session 8: state layer restored, reasoning on, one step driver (2026-10-23)

> Рабочий документ для следующей сессии. Фиксирует, что сделано, какие результаты получены,
> что проверено и какие вопросы открыты. В отличие от старых handoff-файлов (session2–5)
> этот коммитится вместе с изменениями сессии.

## 1. База и цель

- HEAD на входе: `b1ea154` («Prompt: stop-aware repair nudge; Localization experiments»).
- Предыдущий handoff: `docs/plans/handoff_2026-10-22_localization_session7_ru.md`.
- Цель: вернуть рабочее поведение Localization (закрытие без reasoning-шторма), не трогая
  B1–B4; оставить один пошаговый драйвер; зафиксировать результаты на задачах и обновить
  документацию.

## 2. Что изменено (коммит этой сессии)

### 2.1 State-слой (возврат к `c97a34d`)

`src/ir/project.ts`, `src/loop/prompt/blocks.ts`, `src/loop/propose.ts`,
`src/ir/islands.ts`:

- entry снова: `Start state <Label>` (маркер) → brief → `instruction` → `user: what: <island.what>`;
- per-turn tail на `plan`/`working`: **hint → `what:` → `done`-критерий → closure**
  (`planInstruction` = `Call a tool…` + tail; `turnInstruction` = tail); не хранится, на
  следующем ходу пересобирается;
- `terminal`: `This is End. <hint>`;
- hint больше не показывается при входе (он только в хвосте);
- O/L тексты возвращены к `c97a34d` (у L убран `criterion:`-суффикс и «Work from the
  file…»);
- **B1–B4 не трогали**: это по-прежнему текущий base (`# Role`, general instructions,
  States, Transitions).

### 2.2 Reasoning на ленте

`src/config/settings.ts`: `reasoningTape` по умолчанию **on** (как в `c97a34d` и в HEAD;
`SKEIN_REASONING_TAPE=false` — A/B). Комментарий обновлён; поведение от HEAD не изменилось,
но теперь это явно зафиксировано.

### 2.3 Один пошаговый драйвер

- `bench/live-step.ts` — канонический пошаговый драйвер (реальный движок на хосте,
  долгоживущий контейнер, `seed`/`startTurn`, reasoning/переходы/revert движка).
- Удалены `bench/step.ts` (replay `seq`, обходил `executeNode`, reasoning в журнал не
  попадал) и `tests/sandbox/step.ts` (старый дубль).
- `bench/turn.ts` оставлен как дешёвый оффлайн A/B одного записанного хода.
- `tests/sandbox/harness.ts`: выделен `openTaskWorkspace` (общий setup для `runTask` и
  `live-step`).

### 2.4 Документация

- новый гайд `docs/task_testing.md` + `_ru`: песочница (Docker/bwrap), Harbor, `live-step`,
  `turn.ts`, трассы, правила, шпаргалка;
- обновлены `docs/live_step*`, `docs/state_testing*`, `docs/ir_semantics*`,
  `docs/projection*`, `docs/system_prompt*`, `docs/README.md`;
- `docs/benches/best_bench.md` + `_ru`: батч 2026-10-23 (`fix-ocaml-gc` K=3 и breadth
  `fix-code`/`fix-git`/`custom-memory`), топ-10 обновлён (новые ★/#1/#2, старые строки
  сдвинуты, три выпали).

## 3. Результаты

### 3.1 `fix-ocaml-gc`, net off, K=3 (полный sandbox, verifier)

3/3 `reward=1`, `request_addressed`; правка везде `p += Whsize_hd(hd)` → `p += wh` в
`pool_sweep`.

| run | turns | cost | in (fresh + cache, hit) | out (vis + rea) | L stop |
|---|--:|--:|--:|--:|--:|
| 04-29-17 | 26 | 1.342₽ | 163 568 (47 600 + 115 968, 71%) | 6 796 (2 984 + 3 812) | t10 |
| 04-29-19 | 25 | 1.412₽ | 151 935 (51 327 + 100 608, 66%) | 6 944 (2 995 + 3 949) | t8 |
| 04-29-21 | 29 | 1.437₽ | 208 780 (51 084 + 157 696, 76%) | 7 092 (3 322 + 3 770) | t11 |
| **median** | **26** | **1.412₽** | **163 568** | **6 944** | — |

Маршрут: O t0–2 → L t3–(8/10/11) → P → V → End. Трассы:
`bench/runs/sandbox-tasks/2026-10-23T04-29-17-477Z-fix-ocaml-gc`,
`…04-29-19-623Z…`, `…04-29-21-776Z…`.

Против opencode в той же песочнице (net-off K=2, all K=5): total input median **163 568**
против **981 082** / **748 329**; output **6 944** против **18 911** / **11 993**;
reasoning **3 812** против **15 852** / **8 748**. Но fresh input у нас больше
(51 084 против 39 642 / 33 449), cache hit хуже (71% против 96%).

### 3.2 Breadth: остальные три задачи, net off, K=1

| задача | turns | cost | L stop | маршрут | итог |
|---|--:|--:|--:|---|---|
| `fix-code-vulnerability` | 25 | 0.942₽ | t9 | L→P→V→End | guards `_hkey/_hval` + `report.jsonl`, pytest PASS |
| `fix-git` | 19 | 0.847₽ | t6 | L→P→**End** (V пропущена) | dangling `650dba4` → cherry-pick/merge; verifier PASS |
| `custom-memory-heap-crash` | 60 | 3.822₽ | t9 | L→P→V (fail) → L→P→V (pass) → End | `std::_Facet_Register_impl()` в `user_init`; valgrind clean |

`fix-code`/`fix-git` — в диапазоне прошлых K=3; **`custom-memory` — регрессия** (4 цикла,
60 ходов, бюджет исчерпан на последнем ходу; ранее cmh3 — 32 хода / 2.15₽).

### 3.3 A/B reasoning на ленте (важно)

На одном и том же `c97a34d`:

- **reasoning on**: L закрылась на t9, 1.32₽ (верный диагноз);
- **reasoning off**: `VERSION`/upstream-recall, reasoning 2771/2222/…, L не закрыта к t12,
  2.87₽.

То есть reasoning на ленте — решающий фактор в этом A/B. Отсюда и возврат дефолта on.

### 3.4 Почему старые пошаговые прогоны расходились с sandbox

`bench/step.ts` переигрывал `seq` через `executeAction` **без** аргумента `reasoning` и
обходил `executeNode`: его лента не могла содержать reasoning **при любом**
`SKEIN_REASONING_TAPE`, а переходы/отказы были харнесса. Поэтому сравнивать его с полным
движком по поведению нельзя; драйвер удалён, канонический — `bench/live-step.ts`.

### 3.5 Что всё ещё отличается от `c97a34d`

Проверенный гибрид: state-слой `c97a34d` + **текущий B1–B4** + reasoning on. В `c97a34d`
base был **одним блоком** (`B4`: role + States + Transitions), а B1–B4 и их тексты появились
позже (`4fd38ab`/`b1ea154`); также отличаются `next[].when`, `End` vs `Finish` и тексты
Research/Patch/Recovery/Construction/Verification. L закрывается (t8–t11) и в гибриде, но
не так рано, как в `c97a34d` (t9 в step-прогоне).

## 4. Проверка

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'
# 30 files passed, 6 skipped; 363 passed, 40 skipped
```

Живые прогоны — только с разрешения владельца. Контейнеры/временные деревья после прогонов
убраны.

## 5. Открытые вопросы / следующие шаги

1. **Breadth K≥3.** Сейчас breadth K=1; `custom-memory` особенно шумит.
2. **`custom-memory` регрессия.** 60 ходов / 4 цикла; сравнить с cmh3 (32 хода): state-слой,
   reasoning, Patch/Localization targeting.
3. **Изолировать base.** Прогнать state-слой `c97a34d` + **base `c97a34d`** (один блок) +
   reasoning on, K≥3, и сравнить с текущим гибридом. Это ответит, нужен ли откат B1–B4.
4. **Reasoning on/off K≥3 на полном sandbox** (не step): подтвердить вывод 3.3 в полной
   гарнитуре.
5. **Сквозной тест `SKEIN_REASONING_TAPE`.** Сейчас тесты проверяют `Proposals.reasoning` и
   проекцию вручную; нет теста `env → invokeTools → executeAction → project → buildMessages`.
6. **`fix-git` без Verification.** Модель ушла `Patch → End`, verifier прошёл. Решить,
   допустимо ли это, или нужен engine-owned acceptance (см. старый план).
7. **Старые handoff-файлы** `session2–session5` (и `2026-10-20_localization`) остаются
   untracked: в них стоит «не коммитить». Решение за владельцем.

## 6. Файлы этой сессии

- Код/промт: `src/config/settings.ts`, `src/ir/islands.ts`, `src/ir/project.ts`,
  `src/loop/prompt/blocks.ts`, `src/loop/prompt/index.ts`, `src/loop/propose.ts`.
- Тесты: `tests/{environment,ir,islands,loop,messages,prompt,structured,tape,tape_contract,tape_render,workingset}.test.ts`.
- Харнесс: `tests/sandbox/harness.ts` (`openTaskWorkspace`); удалены `bench/step.ts`,
  `tests/sandbox/step.ts`; новый `bench/live-step.ts`.
- Доки: `docs/task_testing*.md`, `docs/live_step*.md`, `docs/state_testing*.md`,
  `docs/ir_semantics*.md`, `docs/projection*.md`, `docs/system_prompt*.md`,
  `docs/benches/best_bench*.md`, `docs/README.md`, этот handoff.

## 7. Быстрые команды

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'

# полный прогон задачи
npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --net off --turns 60

# пошагово
npx tsx bench/live-step.ts fix-ocaml-gc --net off --dir /tmp/opencode/loc
touch /tmp/opencode/loc/continue

# один записанный ход, K=3
npx tsx bench/turn.ts <run> --turn 8 --repeat 3
```
