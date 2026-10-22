# Handoff — session 7: почему Localization не закрывается без хвоста (2026-10-22)

> Рабочий документ. Фиксирует итоги сессии: что проверено, что найдено, что изменено в
> рабочем дереве, и как повторять эксперименты на ленте. Не коммитить автоматически —
> владелец сначала читает, затем коммитит.

## 1. База и цель

- HEAD на входе: `4fd38ab` («Prompt: renumber blocks, End state, state tape without tails»).
- Предыдущий handoff: `docs/plans/handoff_2026-10-22_localization_session6_ru.md`.
- Рабочая задача: `fix-ocaml-gc` (OCaml major GC, run-length compressed free-space sweeping,
  bootstrap падает; acceptance `make -C testsuite one DIR=tests/basic`).
- Модель: `routerai/~deepseek/deepseek-v4-flash-latest`, temp 0.1 (шумно; K≥3).
- Цель сессии: понять, почему Localization **не вызывает `stop`** без per-turn хвоста, и
  найти механизм, который это исправит. Хвост запрещён.

Опорные прогоны:

- рабочий 10-21 без per-turn хвоста: `bench/runs/sandbox-tasks/2026-10-21T06-25-32-273Z-fix-ocaml-gc`
  — reward=1, L закрылась на t16; replay t15 через `bench/turn.ts` дал 2/3 stop.
- baseline 10-20: `2026-10-20T18-27-57-021Z-fix-ocaml-gc` — 24 хода, L=6, но с per-turn tail.

## 2. Главная находка: repair-nudge транспорта

`invokeTools` (`src/llm/structured.ts`) после ответа без tool call делает один repair-раунд.
Исходный текст (`:506`):

```text
You did not call a tool. Call one or more of the provided tools.
```

Это сообщение отправляется модели как **user**-реплика. В прогонах модель, уже нашедшая баг,
пыталась ответить текстом, получала этот nudge и вызывала `grep`/`bash` вместо `stop`.
В её reasoning это видно дословно: «The last message is a system nudge? It says “You did not
call a tool.” … I should call a tool now».

Исправление: если `stop` доступен в tool surface, nudge говорит:

```text
You did not call a tool. If the state's goal is met, call `stop` now with the result in
`why`; otherwise call one or more of the provided tools.
```

Это **единственный найденный механизм**, который реально приводил к `stop`:

- `bench/minimal.ts`, B2 `no-first`, старый L-заголовок, новый nudge → **stop на turn 7**,
  cost 0.8831₽;
- без этого nudge в тех же минимальных условиях stop не было.

Важное уточнение: `Proposals.thought` (видимый текст ответа) в большинстве ходов **пустой**;
модель не «прячет» готовый ответ. На t12 одного прогона она пишет «the criterion says a
suspected cause is enough», но всё равно вызывает `bash`. То есть проблема — tool selection,
а не потерянный текст. Логирование `thought` добавлено в `bench/step.ts` и `bench/minimal.ts`.

## 3. Журнал экспериментов

### 3.1 Orientation

- B2 closure-абзацы (`Call a tool …`, `When it holds, stop …`) приводили к дрейфу
  Orientation: t1–t8 вместо одного хода. После удаления этих абзацев Orientation закрывается
  на t1/t2.
- В Orientation-хинт добавлено: «Even if the request points to a file, do not open it here:
  the acceptance is already named; file contents belong to the next state.» Результат: 2/3
  сэмплов закрывают Orientation на t1; 1/3 всё ещё читает `/app/HACKING.adoc` (файла нет).

### 3.2 Localization: варианты stop-критерия

Все варианты проверялись на записанном seq (t0 move orientation, t1 stop, t2 move
localization), старт с t3; live, temp 0.1.

| вариант | результат |
|---|---|
| конкретный ответ в хинте (`pool_sweep` + `p += Whsize_hd` vs `wh`) | stop t6–t7, 0.23₽ |
| минимальный конкретный конфликт (без лишних фраз) | stop t7, 0.23₽ |
| обязательный sibling-шаблон + анти-аудит | stop t13, 1.38₽ |
| optional sibling + suspected cause / correction / reference / self-check / file+coordinates | stop нет |
| трёхкомпонентный критерий `file + coordinates + error`, K=3 | 1/3 stop t13; 2/3 guard (t7/t11) |
| sibling в instruction | стало хуже: 0/3, аудит шире |
| B2 off на t3 | 1/3, без сигнала |

Вывод: текстовые stop-формулировки не управляют моделью. Она находит баг/единицы, но не
коммитится; в части сэмплов сама себя убеждает, что код корректен.

### 3.3 Old static header (10-21) и minimal

- Старый L-заголовок: instruction с `coordinates or extent` / siblings / `marked unverified`,
  `user: what: …`, статичный system-хинт с `A suspected cause is enough to stop — do not look
  for a different bug` и полным критерием.
- `bench/minimal.ts` (4 сообщения: system role → user request → system environment →
  system old instruction → system old hint) с B2 `no-first` и новым nudge: **stop t7**.
- В full-ленте тот же L-заголовок не закрывается: t7/t10 13k, аудит/upstream.

### 3.4 Что проверено и отвергнуто как причина

- **`Finish state Orientation` с Task/Acceptance/HACKING**: вырезали текст и acceptance —
  stop не появился.
- **system-якоря на upstream**: заменили B2 и L-хинт на нейтральные («Work from the
  material…», «Work from the file you are reading…») — модель по-прежнему пишет
  «Comparing to upstream OCaml», «Let me recall upstream», «Let me fetch upstream».
- **`webfetch` в tool surface**: убрали `webfetch` из L surface — upstream-рассуждение
  осталось; stop нет. Гипотеза отвергнута.
- **`thought`/скрытый текст**: добавили логирование; в проверенных ходах `thought` пустой.
  Скрытого `stop`/ответа нет.

### 3.5 Минимальная vs полная лента

Минимальная (`bench/minimal.ts`) с B2 `no-first` + nudge закрывается. Полная (B1–B4,
Start/Goal/Done, Orientation/Finish, brief, hint) — нет, даже после:

- B2 без первого абзаца;
- старого layout (`Start` отдельно, `what:` user, system hint);
- strip `Finish state Orientation`;
- нейтральных system-текстов;
- удаления `webfetch`;
- generic user-сообщения «Find the error…»;
- удаления in-state user-сообщения.

Остающееся различие: **B1/B3/B4 + Start/Goal/Done + Orientation** (и, возможно, материал
`HACKING.adoc`/`VERSION`, который содержит `trunk/upstream/VERSION`). Модель использует
upstream из своих знаний даже без system-якорей.

## 4. Состояние рабочего дерева (не закоммичено)

`git status`: HEAD `4fd38ab`; изменены:

- `src/loop/prompt/blocks.ts` — B1 role/state machine + заголовки; B2 heading; удалён первый
  абзац (`Understand before acting… map the codebase… sibling…`); удалены два closure-абзаца;
  B2 нейтральный (`Work from the material in this workspace…`); B3/B4 заголовки и пометки.
- `src/ir/islands.ts` — L criterion старый полный (`coordinates or extent`, `siblings are
  ruled out`, `marked unverified`); L instruction старый длинный; L hint старый статичный +
  нейтральная замена (`Work from the file you are reading… follow its pattern`); Orientation
  hint с фразой про файл.
- `src/llm/tools.ts` — `stop` description старый:
  `Call stop when this state's criterion holds. why = where and why you stopped…`.
- `src/llm/structured.ts` — stop-aware repair-nudge (главное изменение).
- `bench/step.ts` — экспериментальный harness:
  - `SKEIN_MINIMAL_TAPE=true` — минимальная лента (role/request/env/hint + plan);
  - `SKEIN_OLD_L_LAYOUT=true` — L: Start отдельно, brief, instruction, user, hint;
  - `SKEIN_STRIP_FINISH=true` — `Finish state Orientation` только факты;
  - `SKEIN_L_USER=none` — без user-сообщения внутри L;
  - `SKEIN_NO_WEBFETCH=true` — убрать webfetch из tool surface;
  - `SKEIN_SPLIT_START=true` — Start отдельным system;
  - `DUMP_REPLY=true` — дамп сырого `ModelReply` по попыткам;
  - `EXTRA_SYSTEM=…` — дополнительный system для одного counterfactual;
  - в `turns.ndjson` пишется `thought`, `actions`, `reasoning`, usage.
- `bench/minimal.ts` (новый, untracked) — отдельный no-IR агент: 4 сообщения, инструменты
  read/grep/list/bash/stop, transcript в памяти, лог ходов. Env: `MINIMAL_TURNS`,
  `MINIMAL_B2=no-first|no-external`.
- `tests/prompt.test.ts` — обновлены проверки B1–B4 и старого `stop`-description.

Проверки:

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'
# 361 passed, 40 skipped
```

## 5. Как тестировать на ленте

### 5.1 `bench/step.ts` — один ход движка

```sh
TAPE_DIR=/tmp/opencode/my-run npx tsx bench/step.ts fix-ocaml-gc /tmp/opencode/my-run/seq.json
```

- `seq.json` — `[{ "turn": N, "action": <Action> }]`; действия переигрываются в контейнере
  (`executeAction`), затем `project`/`buildMessages`/`propose` — один вызов модели.
- Пустой `seq` = request-ход; после каждого хода дописывайте `next-actions.json` с
  `turn = max(existing turn) + 1`.
- Выходы: `contexts/tNNN.txt` (ровно лента), `turns.ndjson` (thought/actions/reasoning/usage),
  `next-actions.json`.
- Старт с произвольного места: оставьте в `seq` только ходы до нужного; модель вызовется на
  следующем. Для первого L-хода это seq из t0 move orientation, t1 stop, t2 move localization.
- Каждый запуск переигрывает **весь** seq в свежем контейнере; `configure`/`make` в seq
  делают ход дорогим.

Экспериментальные env-переключатели (только harness):

| env | что делает |
|---|---|
| `SKEIN_MINIMAL_TAPE=true` | лента role/request/env/hint + plan, без Start/Goal/Done |
| `SKEIN_OLD_L_LAYOUT=true` | L: Start отдельно, brief, instruction, user, hint |
| `SKEIN_STRIP_FINISH=true` | Finish Orientation → только root/entries/repo |
| `SKEIN_L_USER=none` | без user-сообщения внутри L |
| `SKEIN_NO_WEBFETCH=true` | убрать webfetch из tool surface |
| `SKEIN_SPLIT_START=true` | `Start state …` отдельным system |
| `DUMP_REPLY=true` | `reply-tNNN-aN.json` с сырым `ModelReply` |
| `EXTRA_SYSTEM=…` | один дополнительный system-месседж |

### 5.2 `bench/minimal.ts` — без IR/seq/state

```sh
MINIMAL_TURNS=10 npx tsx bench/minimal.ts
MINIMAL_B2=no-first MINIMAL_TURNS=10 npx tsx bench/minimal.ts
```

- Начальные сообщения: system role → (optional B2) → user request → system environment →
  system old L instruction → system old L hint.
- Инструменты: read/grep/list/bash/stop; результаты исполняются в контейнере; transcript
  дополняется; ничего не пишется на диск.
- Печатает `turn / thought / reasoning / actions / tool results / cost`.
- Это самый чистый способ проверить влияние промта на tool selection без state-машины.

### 5.3 `bench/turn.ts` — replay записанного хода

```sh
npx tsx bench/turn.ts bench/runs/sandbox-tasks/2026-10-21T06-25-32-273Z-fix-ocaml-gc --turn 15
npx tsx bench/turn.ts <run> --turn 15 --repeat 3
```

Без контейнера: берёт записанную ленту и зовёт текущую модель; можно `--append-system`,
`--patch`, `--dry`, `--repeat`. Хорош для сравнения формулировок на одном входе.

### 5.4 Правила

- Один фактор за раз; K≥3 при temp 0.1; один сэмпл — не вывод.
- Живые/контейнерные прогоны — только с явного разрешения владельца.
- **Никогда** не запускать `npx vitest run` без `--exclude 'tests/sandbox/**'`: sandbox-тесты
  сами включаются при Docker + образах и запускают реальные контейнеры/верификаторы.
- Offline: `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'`.

## 6. Открытые вопросы / следующие шаги

1. **Последний чистый тест:** добавить в `bench/minimal.ts` B1+B3+B4 (при B2 no-first, старом
   instruction/hint и nudge) — это изолирует state-machine base. Если stop исчезнет — виноват
   base; если останется — Start/Orientation/материал.
2. **Перенести ли minimal-архитектуру в движок** (role/request/env/instruction/hint без
   state-машины) или продолжать full.
3. **Nudge** оставить обязательно: он исправляет путь «модель ответила текстом».
4. **Upstream prior**: нейтральные system-тексты и удаление `webfetch` не помогли; модель
   вспоминает upstream из знаний/материала (`HACKING.adoc`, `VERSION`, `Changes`).
   Возможные направления: temp 0/другая модель; ограничение материала; принять поведение.
5. Решить, какие harness-переключатели оставить в `bench/step.ts` после сессии, а какие
   убрать/вынести в `bench/minimal.ts`. `bench/minimal.ts` полезен как постоянный инструмент.
6. Старые handoff-файлы (`session2`–`session5`) остаются untracked; решить, коммитить ли их.

## 7. Быстрые команды

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'

# один ход full-ленты с первого L-состояния
TAPE_DIR=/tmp/opencode/loc npx tsx bench/step.ts fix-ocaml-gc /tmp/opencode/loc/seq.json

# минимальная лента (no IR)
MINIMAL_B2=no-first MINIMAL_TURNS=10 npx tsx bench/minimal.ts

# replay записанного хода
npx tsx bench/turn.ts bench/runs/sandbox-tasks/2026-10-21T06-25-32-273Z-fix-ocaml-gc --turn 15 --repeat 3
```
