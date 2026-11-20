# Handoff — текущее состояние

> Рабочий документ передачи. Английского зеркала нет. История изменений по датам удалена:
> она остаётся в git. Здесь — только текущее состояние и последняя выполненная работа.

## 2026-11-20 — 0.2.1: живой журнал гипотез, телеметрия в лог, завершение inquiry

### Что сделано

- **Наблюдаемость гипотез.** `runInquiryUnit` эмитит `turn_started`/`turn_finished`,
  `events_added` и `hypothesis` (claim/done/verdict/observed/summary); TUI получает
  `onProgress` для `inquiry` и обновляет `unit.turn`, поэтому ряды гипотез и per-turn
  детали растут вживую, а не появляются в конце.
- **Лог.** Телеметрия inquiry (`model_call` с usage, `tool_call`) пишется в
  `.skein/session.log` как `record: "telemetry"`; progress-события логируются как
  раньше. Добавлен `logTelemetry`.
- **Завершение inquiry.** `unitCompleted` для `task` с `mode: hypotheses` читает
  `goal_verdict`: закрытая цель — `completed`, а не `abandoned`.
- **CLI.** `--mode` добавлен в `skein --help`.
- Тесты: прогресс open/close (tool и text), запись в session log, CLI help, attention
  inquiry. Оффлайн **700 passed / 40 skipped**.

### Проверки

- `npm run typecheck` — чисто; `npm run build` — чисто.
- Пет-проект `~/dev/skein-pet` (вне репозитория): прогон hypotheses 11 ходов,
  `achieved`, H1 открыта/закрыта; в логе видны `hypothesis`, `events_added`, `telemetry`.

### Публикация

- Коммит `af86ccd` («Release: 0.2.1; live hypothesis log, inquiry completion»),
  тег `v0.2.1`, push в `origin/main`.
- `npm publish` → `skein-swe@0.2.1` (latest).
- Docker: `mefrill/skein-swe:0.2.1` и `:latest` (digest `sha256:8b79a1a8…`); образ
  проверен `--version` → `skein 0.2.1`.

### Открытые наблюдения (не правили)

- H1 может быть мета-claim («test runner discoverable» вместо claim о дефекте).
- Правка `@README.md` ушла в `general`, затем в `document`; `document` вписал отчёт
  об изменениях в сам README. Решение — за владельцем.

## 2026-11-20 — сайт v0.2 и подготовка релиза 0.2.0

### Что сделано

- **Сайт (§3 плана):** в `site/index.html` и `site/ru/index.html` добавлен блок
  `#modes` «Two modes / Два режима» (после «Механики», пункт в TOC): `states` по
  умолчанию, `hypotheses` opt-in (`--mode` / `SKEIN_TASK_MODE` / `/mode`), устройство
  гипотезы, закрытие текстом, уход ходов закрытой гипотезы с ленты, ограничение
  «вердикт — суждение модели». В `#evaluation` — подраздел v0.2: таблица v26, v27
  (кап 60 — артефакт, 80 — 10/10), v28 (9/10, пример «вердикт ≠ приёмка»); отделено
  от campaign-k5 v0.1. `docs/ru/site-draft.md` синхронизирован (§3.6, подраздел).
- **Подготовка релиза 0.2.0:** `package.json` и lock — `0.2.0`; `CHANGELOG.md`
  (0.2.0/0.1.0, Keep a Changelog); версии в README, сайте, `docs/{ru,en}/testing.md`,
  `site-draft.md` обновлены на 0.2.0; в README статус v0.2 и упоминание режимов.

### Проверки

- `npm run typecheck` — чисто; оффлайн **693 passed / 40 skipped** (71 файл прошёл,
  6 пропущено).
- `npm run build` — чисто, `node dist/cli.js --version` → `skein 0.2.0`.
- `npm pack` → `skein-swe-0.2.0.tgz` (4 файла: `dist/cli.js`, README, LICENSE,
  package.json).
- First-run приёмка в изолированном HOME: install из tgz, `skein 0.2.0`, `auth list`
  без ключей, `doctor` — `not ready: API key is not set`, exit 1.
- Сайт: EN/RU паритет секций/h2/TOC, HTML-парсер без незакрытых тегов; числа сверены
  с `handoff.md` и `paper/ru/skein.tex`.

### Публикация

- Коммит `88b4352` («Release: 0.2.0; hypothesis mode, site, changelog»), тег `v0.2.0`,
  push в `origin/main`.
- `npm publish` → `skein-swe@0.2.0` (latest); tarball 4 файла, shasum `d495c921…`.
- Docker: `mefrill/skein-swe:0.2.0` и `:latest` (digest `sha256:dabb3729…`); образ
  проверен `--version` → `skein 0.2.0`.
- Сайт задеплоен (`skein-swe.dev`): v0.2, «Two modes», таблица v0.2, Docker `0.2.0`.

### С чего начать

1. `procedure.tex` — вычитан (RU/EN), публикует владелец; со стороны Skein — числа и
   выверка.
2. Препринт v2 на Zenodo: `10.5281/zenodo.24400661` (файл совпадает с `paper/en/skein.pdf`);
   ссылки в README/сайте обновлены.

## 2026-11-20 — препринт Skein v2: динамические гипотезы, статья, ревью

### Что сделано

- **Препринт v2** (`paper/{ru,en}/skein.tex`): динамические гипотезы как следующий шаг от
  состояний; результаты v26/v27/v28. Аннотация переписана концептуально — процедура-дисциплина,
  журнал, два способа работы; без «версии 2» и без таблицы результатов (результаты — одной
  фразой).
- **Введение:** «первая фаза» заменена на структуру работы и тезис о гипотезах как
  метаорганизаторе рассуждения (модели учат на прямых цепочках; надежда на обучение через
  гипотезы). «Второе решение» теперь про состояния **и** гипотезы.
- **3.5:** `open_hypothesis` (`label`, `claim`, `done`), номер гипотезы присваивает движок,
  закрытие текстом (`verdict`/`observed`/`summary`), аналогия с `move`.
- **Результаты:** «Гипотезы против состояний» + подраздел «Что показывают журналы гипотез»:
  99 гипотез в 70 прогонах, 95 закрыты (93 confirmed, 2 refuted), 4 открыты (все в cap-прогонах
  fix-ocaml), 66 целей закрыты, ходы 20 при 1 гипотезе и 28 при ≥2, fix-ocaml 16→21 гипотез при
  80 ходах, modernize 9/10 при 10 закрытых целях.
- **По ревью (3 минимальные вставки):** Future Work — конкретный машинный чекер (`done` как
  предикат/регулярка/AST, `follows_from`); Limitations — prompt injection для чужих документов;
  Заключение — уместность для аудиторского следа (юридические/формальные тексты).
- **EN-зеркало** приведено к RU; оба PDF собраны.

### Проверки и артефакты

- `paper/ru/skein.pdf` — 20 стр., `paper/en/skein.pdf` — 18 стр.; `latexmk -xelatex` чисто.
- План v0.2 — `docs/ru/roadmap-0.2.md`: препринт v2, сайт, статья у владельца, релиз 0.2.0.
  Следующая сессия — доделать план v0.2.
- Код режима/меток/капа и прогоны v26/v27/v28 — в записях ниже; этот коммит их фиксирует.

### С чего начать

1. Сайт: блок «Два способа работы» + обновление оценки/ограничений.
2. `procedure.tex` — ведёт владелец; со стороны Skein — числа и выверка утверждений.
3. Релиз 0.2.0 (после локальной приёмки).

## 2026-11-20 — `task`: режим states/hypotheses, метки гипотез; K=5 (v26)

### Что сделано

- **Режим — свойство `task`, по умолчанию `states`.** `SKEIN_TASK_MODE` / `--mode` /
  `/mode` в TUI; `Unit.mode` снимается при открытии, возобновление идёт по нему.
  Диспетчер в `driver.ts` (`runTaskInMode`): `states → runAgent`,
  `hypotheses → runInquiryUnit`; `InquiryResult` адаптируется в `AgentResult`.
  Гипотезы — только для простого `task` (observer/plan остаются states).
- **Метка гипотезы (`label`)** вернулась в `open_hypothesis`: `label, claim, done,
  follows_from`; обязательна и непуста (`bad_hypothesis`). Схема, wire-маппинг, payload
  и проекция синхронизированы; на ленту модели не выводится — только в панели задачи.
- **TUI:** панель показывает `mode`, строки гипотез (`H1` + метка + ходы/токены/время),
  заголовок `Hypotheses`; `/mode` переключает режим, текущий виден в шапке. Телеметрия
  `agent: "inquiry"` через обёртку пропозера в драйвере.
- **Стенд:** `sandbox-run.ts --mode`; `skein-hypotheses` как измерение `campaign`/`matrix`;
  `runLiveTask` умеет оба цикла, метрики те же.

### K=5, net on/off (v26)

`bench/runs/matrix/inquiry-v26-modes`, 7 задач, 140 клеток, **137 solved**, ~369.60₽.

| agent/net | solved | turns | cost | fresh |
|---|---:|---:|---:|---:|
| skein/on | 35/35 | 17 | 2.421₽ | 34.5k |
| skein/off | 34/35 | 15 | 1.606₽ | 28.7k |
| hypotheses/on | 34/35 | 20 | 1.883₽ | 19.6k |
| hypotheses/off | 34/35 | 22 | 1.983₽ | 20.1k |

- Все три провала — `max_turns` на `fix-ocaml-gc` (states/off r5; hypotheses/on r2, off r3).
- **Гипотезы режут fresh input почти вдвое** (19.6–20.1k против 28.7–34.5k) и дешевле на
  коротких/средних: fix-git 0.79/0.98 против 1.43/1.30; custom-memory 3.2/3.5 против
  3.9/5.0; fix-code 1.6/0.83 против 2.9/1.6. Платят **ходами** (20–22 против 15–17).
- **`fix-ocaml-gc` — длинная задача:** hypotheses 4/5 на обеих сетях, 52–53 хода,
  ~5.5/4.3₽, input 0.9–1.4M; states 5/5 on / 4/5 off, 35–37 ходов. Цена протокола
  open/close на длинной ленте: упирается в кап.
- `fresh` падает везде; `cost` — не везде (тариф дня высокий; ₽ между датами не сравнивать).

### v27: `fix-ocaml-gc`, hypotheses, кап 80

`bench/runs/matrix/inquiry-v27-ocaml-80`, только `skein-hypotheses`, K=5, net on/off,
`--turns 80`, concurrency 5. 10 клеток, **10/10 solved**, ~24.30₽.

| net | solved | turns (median/range) | cost (median) |
|---|---:|---|---:|
| on | 5/5 | 44 / 34–64 | 1.977₽ |
| off | 5/5 | 68 / 37–81 | 3.418₽ |

- При капе 60 в v26 было 4/5 на обеих сетях; все провалы — `max_turns`. **Кап 60 был
  артефактом:** с 80 ходами обе сети дают 5/5.
- Длинная задача — это длинный хвост: отдельные прогоны доходят до 68–81 хода и стоят
  3.4–4.3₽ (r5 off: 81 ход, 2319s, 3.764₽). Wall 61 мин на 10 клеток (5 потоков,
  verifier-сборка OCaml + клон).
- Сравнение со states (v26, кап 60): states on 5/5 / off 4/5, медиана 35–37 ходов. На
  длинной задаче hypotheses выигрывает по solved при достаточном бюджете, но платит
  ходами; цена/медиана при 80 ходах ниже, но хвост дороже.

### v28: tool_call, кап/резюм, modernize

- **`tool_call`-телеметрия для inquiry:** `InquiryDeps.telemetry`; в цикле действий
  эмитится `tool_call` (`agent: "inquiry"`, refusal → `error`). Панель теперь считает
  действия и для гипотез.
- **Кап/резюм как в states:** `InquiryInput.budgetPause`/`finalize`. На капе
  `budgetPause` → `{paused, done, stopReason: "budget"}`; TUI показывает обычное меню
  `continue`/`finish`. `continue` поднимает кап на `budgetExtend`. `finish` — один
  ход-отчёт (Markdown), затем открытые гипотезы закрываются как `dropped`, цель —
  `not_achieved` с отчётом; `stopReason: max_turns`.
- **Финальный ответ:** `answerOf` (TUI) и `taskAnswer`/`stopText` (`session/view`)
  читают `goal_verdict.summary`, а не только `stop` — результат inquiry виден в TUI и
  истории.
- **Конструктивный контроль `modernize-scientific-stack`:** hypotheses, K=5, on/off,
  80 ходов, 5 потоков: `bench/runs/matrix/inquiry-v28-modernize`, **9/10**, ~5.53₽,
  медиана 18 ходов (~0.58₽). States (campaign-k5): 5/5 на обеих сетях, 9–10 ходов.
  Единственный провал — `net=on` r5: модель закрыла цель `achieved`, но скрипт выдал
  `Station 101 mean = -4.3` вместо `-15.5`; вердикт модели не арбитр (ожидаемо). Граница
  домена подтверждена мягко: конструктив решается, но протокол дороже по ходам, и
  «achieved» без внешней проверки может быть ложным.

### Проверки

- `npm run typecheck` — чисто; оффлайн **693 passed / 40 skipped**.
- Новые тесты: метка/`bad_hypothesis`, режим в `session_driver`, строки гипотез в
  `tui_view_model`, `tool_call`-телеметрия и кап/finalize в `inquiry_unit`.

## 2026-11-20 — `inquiry`: текстовый финал вместо `close_goal`; остановка; K=3/K=5 (v25)

### Что сделано

- **Финал — текст, не инструмент.** `close_goal` убран из `INQUIRY_TOOL_NAMES` (в
  `INQUIRY_TOOLS`/исполнителе остаётся для прямых вызовов и старых журналов). Без
  открытой гипотезы поверхность — только `open_hypothesis`; результат — текст JSON
  `{outcome: achieved|not_achieved, summary}`. Литерала формы в базовом промте нет —
  только «the outcome (achieved or not_achieved) and the summary».
- **Восстановлены две строки** (distinct claim / no restatement; без открытой — следующая
  claim или текст-финал) и добавлены три фразы остановки:
  - goal: «When the closed hypotheses together establish the request's result, the task is
    over: reply with the final JSON and stop. Open another hypothesis only for a claim the
    request still needs.»
  - hypothesis: «A hypothesis ends at the observation that decides its claim… a settled
    claim needs no further check.»
  - observed: «Before you close a hypothesis, review all the work you did under it… the
    observation is the result of the whole hypothesis.»
- **`close_goal.follows_from`** (id-ы гипотез, на которых держится итог) — схема/payload/
  рёбра/рендер; на поверхность не подаётся (прямые вызовы).
- **`runInquiryUnit`:** текст без открытой гипотезы парсится как goal-close
  (`parseGoalCloseJson`), один repair, затем `bad_goal`; до первой гипотезы текст —
  `no_goal`. `GOAL_CLOSE_JSON_FORMAT`/`parseGoalCloseJson` в `src/llm/inquiry.ts`.
- **Харнесс:** `tests/sandbox/inquiry-task.ts` получил `SKEIN_INQUIRY_NET` (было жёстко
  `off`).
- Тесты/доки: `tests/inquiry_unit.test.ts`, `tests/structured.test.ts`,
  `docs/ru/inquiry.md` (§5.2 список абзацев, §5/§5.1/§6.3/§7.4, пример).

### Прогоны

`custom-memory-heap-crash`, K=3 (v25, net off):

| run | reward | stop | turns | cost |
|---|---:|---|---:|---:|
| r1 | 1 | `achieved` | 30 | 3.22₽ |
| r2 | 1 | `achieved` | 39 | 3.71₽ |
| r3 | 1 | `achieved` | 35 | 3.29₽ |
| **итог** | **3/3** | **3/3 achieved** | **104** | **10.22₽** |

Против v24: 3/3 verifier, но **1/3 achieved** (+2 `max_turns`), **145 ходов**, 33 хода
verification-хвоста. В v25: 3/3 `achieved`, **0 open**, хвоста нет.

`fix-git`, K=5 (v25):

| net | solved | turns | runs | cost | open |
|---|---:|---:|---|---:|---:|
| off | **5/5** | 80 | 10/13/14/14/29 | 5.43₽ | 0 |
| on | **5/5** | 77 | 14/15/15/16/17 | 4.89₽ | 0 |

Сравнение с campaign-k5 (13 ноя): старый skein fix-git on 4/5, 10 turns, 0.584₽; off
5/5, 13, 0.632₽; opencode 5/5, 8, ≈0.20₽ (est.). custom-memory: старый skein 28.68₽/10
(patch 21.3 + verification 6.5 + end 0.9), opencode 13.78₽/10 (est.).

- v25 fix-git 10/10 против 9/10 у старого skein; ходы 14–15 против 10/13; fresh
  11.7k/run против 18–21k. На короткой задаче протокол open/close дороже по ходам.
- ₽ через даты не сравнивать: за ход v25 ~0.064–0.098₽ против ~0.048–0.074₽ 13 ноя.

### Наблюдения

- **Input доминируется перечитыванием ленты открытой гипотезы** (cache): fresh — 5–9%.
  custom r2: одна H1 на 37 ходов = 99.3% input; r3: H1 22 хода 78%, H2 10 ходов 20.3%
  (лента сбрасывается при закрытии: 66.9k → 5.7k символов). fix-git: H1 69–95% input;
  goal open/close 0.7–7.5% input, но 8–32% output (финальный отчёт).
- Текстовый финал без литерала формы сначала ломал парс (`"outcome":"fixed"`); возврат
  значений `achieved/not_achieved` вернул парс (8/10 на решении против 7/10 с шаблоном).
- В custom r1 один transient `AI_APICallError: other side closed`; прогон всё равно
  reward=1.
- Осталось: на fix-git 2/10 прогонов добавляют verification-H2 (1 ход в on r1, 9 в
  off r5); merge по-прежнему делается под H1 (scope). Текстовый финал делает
  преждевременный stop возможным — старого `no_goal` после первой гипотезы нет.

### Проверки

- `npm run typecheck` — чисто; оффлайн **688 passed / 40 skipped**.
- Артефакты: `bench/runs/inquiry-v25-custom-memory-k3`,
  `bench/runs/inquiry-v25-fix-git-{on,off}-k5`.

### С чего начать завтра

1. fix-git: почему 2/10 добавляют verification-H2 и merge делается под H1; удержать
   scope без движка.
2. Проверить текстовый финал на других задачах (`fix-code-vulnerability`, `modernize`)
   K=3.
3. Точные per-turn токены — через `tests/sandbox/inquiry-step.ts` (`turns.ndjson`); сейчас
   доли — реконструкция по `inquiryMessages`.
4. Решить судьбу `close_goal.follows_from` (сейчас не на поверхности).

## 2026-11-19 — `inquiry`: H-id без label, обязательный `done`; K=3 custom-memory (v24)

### Что сделано

- **Идентификатор гипотезы — только движок:** `H1`, `H1.1`, `H2`; `nextHypothesisId`
  генерирует иерархию с префиксом `H`. Модель id не передаёт.
- **`label` удалён** из `open_hypothesis`, `Action` и `HypothesisPayload`: это был только
  display-текст, модель писала в него `C1`, что путалось с id. Payload гипотезы:
  `{ hypothesisId, claim, done, followsFrom, turn }`; `Opening hypothesis H1.` без имени.
- **`done` обязателен** в `open_hypothesis` и записывается в payload при создании узла;
  `Done when` рендерится из него. Схема, wire-схема, `toProposal`/`modelCall` и executor
  синхронизированы.
- **`follows_from` ограничен id-ами:** схема принимает только `H1`, `H1.1`, `H2`;
  prose отклоняется как `bad_hypothesis`, в payload/рёбра не попадает.
- **Поверхность первого хода:** пока не открыта ни одна гипотеза, доступен только
  `open_hypothesis`; `close_goal` появляется после первой гипотезы. Это убрало
  `close_goal("placeholder")` в батче с открытием.
- Текущее описание `open_hypothesis` (для продолжения):
  `claim` — короткое high-level декларативное утверждение, не весь request;
  `done` — проверка, подтверждающая/опровергающая claim; `follows_from` — id-ы,
  `[]` если нет; split — подгипотезами, по одному `open` в ответе.
- Обновлены `docs/ru/inquiry.md`, `docs/{en,ru}/{ir_operations,tools}.md`,
  `docs/ru/testing.md` (§5.1.1), тесты; добавлен контейнерный пошаговый драйвер
  `tests/sandbox/inquiry-step.ts`.
- `maxTurns` задачи `custom-memory-heap-crash` — 50.

### K=3, 50 ходов, containers

Команда:

```sh
SKEIN_INQUIRY_TASK=custom-memory-heap-crash SKEIN_INQUIRY_REPEAT=3 \
SKEIN_INQUIRY_MAX_TURNS=50 \
SKEIN_INQUIRY_SAVE=bench/runs/inquiry-v24-custom-memory-k3 \
npm run inquiry:docker
```

| run | reward | stop | turns | гипотез | open | cost |
|---|---:|---|---:|---:|---:|---:|
| r1 | 1 | `achieved` | 45 | 1 | 0 | 2.61₽ |
| r2 | 1 | `max_turns` | 50 | 7 | 1 | 2.10₽ |
| r3 | 1 | `max_turns` | 50 | 3 | 1 | 2.21₽ |

**Итог: verifier 3/3, чистое завершение 1/3, turns 145, cost 6.91₽.**
Артефакты: `bench/runs/inquiry-v24-custom-memory-k3/r{1,2,3}`.

### Проблемы

- **Главная:** после уже проверенного fix модель не вызывает `close_goal`, а открывает
  verification-гипотезы. r2 после H2 (`t30`) потратил ещё 20 ходов на H3–H7; r3 после H1
  (`t37`) — ещё 13 ходов на H2–H3. Это 33 из 145 ходов.
- r2: H1 заявлена как reproduction, но на `t11`/`t14` уже сделаны write/edit fix. H1
  закрыта с `observed` «No files were modified», что **противоречит журналу действий**.
- r2: H3–H6 — четыре почти одинаковые проверки «fix есть / всё ещё есть / всё ещё работает»;
  H7 — «состояние можно установить чтением файлов», осталась open.
- r3: H1 покрыла diagnosis+fix+verify; после неё H2 и H3 — повторные проверки final state.
- Формулировки verification-claim мета-уровневые (`final state contains the fix`,
  `can be established by reading`); `done` у них — чтение/пересборка, поэтому цикл не
  упирается в критерий. `follows_from` работает механически (r2 H2–H6, r3 H2–H3), но
  цикл не останавливает.
- В консоли был один transient `APICallError: other side closed`; все три результата
  записались, прогон не помечен error.
- Описания `claim`/`done` всё ещё не гарантируют нужную форму: в первом ходе v24 claim
  получался `high-level`, но `done` иногда оставался про чтение/пересборку.

### Проверки

- `npm run typecheck` — чисто.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **685 passed / 40 skipped**.
- K=3 Docker выше: reward 3/3, artifacts на месте.

### С чего начать завтра

1. **Лишние ходы после fix:** не открывать verification-гипотезу, если fix уже проверен;
   закрывать goal. Смотреть `runInquiryUnit`/поверхность и промт, не только `done`.
2. **Scope H1:** r2 сделал fix под claim «reproduce», затем открыл retrospective H2
   «root cause». Проверить, почему claim не удерживает границу и можно ли это выразить
   в промте/состоянии без костыля.
3. **`observed` vs журнал:** r2 H1 закрыт с «No files were modified» после write/edit.
   Решить, должен ли движок выводить/проверять мутации в `observed`.
4. **`follows_from`:** ограничение id работает; r2 H7 всё равно открыт с `[]` после
   закрытых H1–H6 — разобрать, почему цепочка обрывается.
5. Повторить K=3 после изменения, сравнить turns/cost с v24.

## 2026-11-18 — `inquiry`: `observed` вместо предсказания (doc-задача, K=3)

### Что сделано

- **`close_hypothesis` получил `observed`** — реальное окончание (что фактически увидели),
  обязательное и непустое; пустое → отказ `bad_observation`. Лента:
  `Closing hypothesis C1: verdict.` / `Observed: …` / `Summary: …`.
- **`if_true`/`if_false` удалены полностью** — артефакт подхода с предикатами. Основания:
  заполнялись как план, а не как различающее наблюдение; модель их не соблюдала (закрывала
  `confirmed` без обещанного наблюдения, а в одном прогоне написала файл не под той claim);
  `refuted` по `if_false` на коротких задачах не встречался; движок их не проверяет; с
  `observed` они стали лишним слоем.
- Промт: гипотеза — claim, который может быть истинным или ложным; «Close with what you
  actually observed, not with what you expected». Гейт `bad_expectation` убран; описания
  инструментов, схемы, IR, доки и тесты обновлены.
- Файлы: `src/ir/types.ts`, `src/llm/{inquiry,schemas,tools}.ts`, `src/tools/index.ts`,
  `src/inquiry.ts`, `tests/inquiry_unit.test.ts`, `docs/ru/inquiry.md`.

### Баг двух схем (исправлен)

- `observed` добавили в `actionSchema` (`src/llm/schemas.ts`), но забыли в нативную
  `hypothesisCloseParams` (`src/llm/inquiry.ts`) — модель видит именно её и не могла прислать
  поле. Прогон v12b: **22 отказа `bad_observation` подряд** и `max_turns`.
- Исправлено; добавлен регрессионный тест «requires the observed field in the close tool
  schema». Урок: wire-схема и внутренняя `actionSchema` могут молча разойтись.

### Doc-задача (не sandbox: `--dir`, оценки по журналу)

Задача: «задокументируй публичный API `src/ir/graph.ts` в `docs/ru/api-graph.md`» (31 экспорт).
Гонялась `npm run inquiry -- @<task.txt> --dir <snapshot> --max-turns 40 --save …` на снимке
репозитория; verifier нет — качество сверялось вручную.

| прогон | конфиг | ходы | гипотезы | итог | ₽ |
|---|---|---:|---|---|---:|
| v12 | `if_true/if_false`, без `observed` | 26 | 3 | achieved | 1.47 |
| v12b | `observed`, wire-схема не обновлена | 40 | — | max_turns | 1.85 |
| v12c | `observed` + предсказание | 40 | 4 | max_turns | 1.73 |
| **v13, K=3** | **без предсказания + `observed`** | **30/26/29** | **2/2/2** | **3/3 achieved** | 1.27/1.07/1.34 |

- v13: во всех трёх C1 = осмотр+запись (r2/r3 ещё правят `docs/ru/README.md`), C2 = verify.
  `observed` в C1 называет созданный файл — в v12c этого не было: предсказание, похоже,
  привязывало `observed` к ожиданию и вытесняло из записи артефакт.
- Качество: 31/31 заголовков во всех трёх, сигнатуры дословные (r3 — `HypothesisMode` без
  `export`/`;`), пример на TypeScript есть.
- Осталось: verify-хвост (C2 в каждом прогоне, ~9–12 действий); r3 открыл C2 с тем же
  label/suppose, что C1 (дубль claim; промт запрещает, движок не проверяет); r2/r3 правили
  README — выход за задачу.
- Артефакты: `bench/runs/inquiry-v12-docs-skein-k1`, `inquiry-v12b-docs-skein-observed-k1`,
  `inquiry-v12c-docs-skein-observed-k1`, `inquiry-v13-docs-skein-nopredict-k3/r{1,2,3}`.

### Graded-задачи после удаления предсказания (v14)

`npm run inquiry:docker`, тариф дня 2× — ₽ сравнивать только между сегодняшними прогонами.

| задача | K | solved | ходы | ₽ |
|---|---:|---|---:|---:|
| `log-summary-date-ranges` | 3 | **3/3** | 17/13/12 (42) | 1.75 |
| `custom-memory-heap-crash` | 1 | **1/1** | 36 | 2.22 |
| `modernize-scientific-stack` | 3 | **3/3** | 11/17/15 (43) | 1.65 |

- Против баз: `log-summary` (v11f 3/3, 11/11/15 = 37 ходов, 1.57₽) — 42 хода, 1.75₽, не
  регресс, но чуть длиннее; `custom-memory` (v11f 42, 2.29₽) — 36, 2.22₽, лучше;
  `modernize` (v9 21/18/14 = 53) — 43, лучше.
- **`refuted` за 14 прогонов не встретился** — все claim подтверждались. Риск «без `if_false`
  негативное знание пропадёт» не проверен: кейса, где модель обязана ошибиться, не было.
- **Вложенности (`C1.1`) по-прежнему нет** — везде плоские C1/C2/C3.
- **Verify-хвост жив, но цепочки нет:** ровно одна проверочная гипотеза в 3 из 7 прогонов
  (doc r1–r3, `log-summary` r1/r3, `modernize` r3); чаще всего C1 = осмотр(+запись), C2 =
  verify. В `modernize` r2 — C1 осмотр → C2 повторный осмотр → C3 запись («осмотр не
  переиспользуется», как раньше).
- Артефакты: `bench/runs/inquiry-v14-log-summary-nopredict-k3`,
  `inquiry-v14-custom-memory-nopredict-k1`, `inquiry-v14-modernize-nopredict-k3`.

### Найдено round-trip тестом и проверка `refuted`

- **`modelCall` не был обратным `toProposal`:** у `close_hypothesis` отсутствовал `observed`,
  у `open_hypothesis` пропадал `follows_from` при пустом списке (схема требует `[]`). Оба
  исправлены. Добавлен тест `inquiry tools: modelCall is the wire-inverse of toProposal`
  (4 образца: open с `[]`/с id, close, close_goal), пинящий wire-схему и `actionSchema`.
- Добавлен тест на старый журнал: вердикт без `observed` рендерится как
  `(no observation recorded)`. Старые записи (v11/v12) фолдятся и рендерятся (проверено).
- `docs/ru/inquiry.md` §9: убран шаг «(без вызовов)» — остаток удалённого текстового stop;
  `close_goal` теперь шаг 8.
- **`fix-code-vulnerability` K=1:** 1/1, 12 ходов, 0.38₽; одна claim, `confirmed`.
- **`custom-memory-heap-crash` K=3:** **2/3**, ходы 47/20/45, 6.19₽. r1 (47) и r3 (45) —
  achieved (r1 с verify-хвостом). **r2 — `no_goal`:** две claim `confirmed` (анализ
  `main.cpp`/libstdc++), **ни одной записи** в `/app/user.cpp`, затем текстовый ответ без
  вызова → `no_goal`, пустой финал, reward 0.
- **`refuted` за 14 прогонов после удаления предсказания так и не встретился.** Риск
  «негативное знание пропадёт» остаётся непроверенным: нужен кейс, где модель обязана
  ошибиться. Наблюдаемый провал другой — аналитический цикл + текстовый stop (`no_goal`,
  без repair).
- Артефакты: `bench/runs/inquiry-v14-fix-code-vulnerability-nopredict-k1`,
  `inquiry-v14-custom-memory-nopredict-k3/r{1,2,3}`.

### Итог и с чего начать завтра

- **После смены (без предсказания + `observed`): 13/14 solved** (doc K=3, `log-summary` K=3,
  `custom-memory` K=1 и K=3, `modernize` K=3, `fix-code` K=1). Единственный провал —
  `custom-memory` r2: `no_goal` (текст без вызова). Ранние v12b/v12c падали на `max_turns`
  (баг wire-схемы и одиночная проба с предсказанием) — это до смены, в счёт не входят.
- **Открытые вопросы:**
  1. **`refuted` не наблюдался ни разу (14 прогонов).** Движок его поддерживает (офлайн-тест
     есть), открыт вопрос склонности модели: нужен кейс с заведомо неверной claim или
     сравнение с до-`if_false`-поведением (v9: `fix-code`/`password` давали `refuted`/дубли).
  2. **Verify-хвост:** ровно одна проверочная гипотеза в 7 из 14 прогонов; изредка дубль
     осмотра (`modernize` r2: C1 осмотр → C2 повторный осмотр) и дубль claim (`doc` r3:
     C2 с тем же label/suppose, что C1). Промт запрещает restatement, движок не проверяет.
  3. **`no_goal` без repair:** текстовый ответ без tool-call при отсутствии открытой
     гипотезы завершает работу с reward 0 (`custom-memory` r2). Решить: repair/allowText
     или оставить как ошибку.
  4. **Вложенность (`C1.1`) не появляется** — везде плоские C1/C2/C3.
  5. **Две схемы:** для inquiry теперь пинятся round-trip тестом; проверить, нет ли той же
     рассинхронизации у остальных (`session`-инструменты, `start_document` и т.п.).
- **Не трогали:** `fix-ocaml-gc` (60 ходов), LHTB-задачи.
- **Закоммичено** 2026-11-19 (см. запись выше): `src/{inquiry.ts,ir/types.ts,llm/{inquiry,schemas,tools}.ts,tools/index.ts}`,
  `tests/{inquiry_unit,structured}.test.ts`, `docs/ru/{inquiry,handoff}.md`. Предсуществующие
  правки `tests/sandbox/*` и `lhtb-*` не трогались.

### Проверки

- `npm run typecheck` — чисто; офлайн — **678 passed / 40 skipped**.

## 2026-11-18 — `inquiry`: короткие задачи K=3, причины дублей/перепроверок

### Поправка (важно)

- **Причинное объяснение «модель переформулирует/перепроверяет из-за стирания ленты» —
  неверно.** Не использовать. Ранее это уже подтверждалось (неоднократно). Модель работает
  по промту; всё, что она видит, — промт (включая то, какие ходы проекция в него кладёт).
  Дубли и перепроверки — **проблемы промта**, а не следствие «магии стирания».
- Откуда я это взял (факт о промте, не причина): `src/inquiry.ts:176,224` — проекция не
  рендерит ходы закрытой гипотезы; `docs/ru/inquiry.md:138,325,367`. Это описание того,
  что попадает в промт; выводить из этого поведение модели нельзя.

### Прогоны (2026-11-18, H-контейнер v9, `SKEIN_INQUIRY_REPEAT=3`)

| задача | solved | ходы r1/r2/r3 | in | fresh | out | ₽ |
|---|---:|---|---:|---:|---:|---:|
| modernize-scientific-stack | 3/3 | 21/18/14 | 80.6k | 12.5k | 4.3k | 3.30 |
| git-leak-recovery | 3/3 | 21/15/18 | 80.3k | 9.2k | 4.8k | 3.15 |
| log-summary-date-ranges | 3/3 | 11/17/13 | 60.2k | 10.0k | 3.8k | 2.77 |

- Артефакты: `bench/runs/inquiry-v9-<task>-k3/`.
- **Тариф:** три сегодняшних прогона считаются ровно по **2×** ставкам кампании и
  вчерашнего `fix-git-v9` (`reported/fitted ≈ 1.987` против `0.994`); прогоны — 18 ноя
  06:5x, вчерашние — 17 ноя 22:2x. По старому тарифу цена: 0.55 / 0.53 / 0.46₽, т.е.
  +20% / +35% / −10% к task-режиму, а не 2×. Сравнивать ₽ между датами нельзя.
- Структура ходов: доля protocol (`open`/`close`/`stop`/`close_goal`) — 45% / 33% / 44%.
  Минимум для одной гипотезы — 4 непродуктивных хода, каждая следующая +2.
- Отказы: 3 хода на 9 прогонов (`bad_expectation` в modernize r2; `hypothesis_tool_alone`
  ×2 в modernize r3, t0). `no_open`/`one_open`/`max_turns` нет.

### Разбор рассуждений на ходах с дублями/перепроверкой

Факты из `payload.reasoning` (events.ndjson):

- **modernize r1, t3→t4.** На close (t3) модель рассуждает: «Close C1… Open hypothesis C2:
  creating modern script». На t4 emit'ит **дословно C1** («inspect legacy») с reasoning
  «Let me inspect the files first.» Позже (t13) сама: «I had opened a duplicate hypothesis
  C2 that was already answered… I opened C2 before doing work — mistake.»
- **modernize r2, t2→t3→t4.** На t3 кладёт `if_true`/`if_false` **внутрь `suppose`**,
  оставляя поля пустыми → `bad_expectation`; t4: «I need to provide non-empty if_true &
  if_false.» — потерянный ход на форму вызова.
- **modernize r3, t0.** Два `open_hypothesis` в одном ответе (второй — `placeholder`
  x/x/x) → `hypothesis_tool_alone` ×2; в reasoning: «It seems the tool call must be alone —
  I did call it alone… Strange.» C1 открывается только в t1.
- **git-leak r3, t3→t4.** C1 реально сделала 2 bash (t1–t2), но на t4: «I didn't actually
  run any tools! … the summary I gave may be fabricated» → открывает C2 и повторяет осмотр.
- **log-summary r1/r3, после close.** «The summary claims it was done. But I need to
  verify? … I should ensure summary.csv is correct» → verify-гипотеза (3–5 ходов).
- **modernize r1/r2, verify-tail.** C3 «verify state» (5 ходов), C4 «verify final
  artifacts» (5 ходов) уже после готового результата.

### Промт-причины (не «стирание»)

1. **В промте нет запрета переоткрывать ту же claim.** Есть только `each distinct claim`
   (`src/inquiry.ts:26`), `do not open … only to check` (`:28`) и в описании close —
   «either open the next one or stop … build on it instead of re-deriving it». Ни одна
   строка не говорит «не повторяй C1» / «следующая claim должна отличаться».
2. **Reasoning хода `open`/`close` не попадает на ленту:** гипотезные вызовы рендерятся
   как `system` Opening/Closing и `continue` (`src/inquiry.ts:202–220`), assistant-reasoning
   отбрасывается. Поэтому намерение из t3 («open creating-files») не видно на t4.
3. **Единственный Opening-пример на ленте — только что закрытая C1**, а
   `OPEN_INSTRUCTION` (`:323`) общий: «open the next hypothesis» — без id закрытой и без
   «new/different». Модель копирует единственный образец.
4. **Форма вызова не удерживается:** схема/описание не мешают положить ожидания в
   `suppose` (r2) и прислать второй `placeholder`-вызов (r3).
5. **`Summary` не объявлен авторитетным:** модель видит только Opening/Closing, не видит
   своих наблюдений и сомневается (git-leak r3) → verify-гипотеза.

### Сделано после разбора (Phases 0–6)

- **Phase 0 (точка решения).** Убраны `OPEN_INSTRUCTION`/`FINISH_INSTRUCTION` и фаза
  `finish`; текстовый stop удалён. Нет открытой гипотезы → поверхность
  `["open_hypothesis","close_goal"]`; текст без tool-call — ошибка (`no_close`/`no_goal`).
  Tape-проба: «результат не достигнут» (modernize r2, log-summary r1) — **10/10
  `open_hypothesis`**, `not_achieved` нет; «достигнут» — 5/10 `close_goal`, 5/10 verify
  (модель не доверяет Summary — отдельный промт-вопрос).
- **Дерево гипотез (v11).** Гипотеза — `work`-лист (дети — действия) или `formula`
  (дети — подгипотезы); режим фиксируется первым ребёнком; смешение —
  `not_leaf`/`not_formula`; пустой лист — `empty_hypothesis`; `formula` закрывается
  после детей; вердикт+summary пишет модель. Иерархические id (`C1`, `C1.1`). Открытые
  гипотезы — один путь; активная — самая глубокая; поверхность по режиму:
  `undecided` — `open` + work без `close`; `work` — work + `close`; `formula` — `open` +
  `close`; нет открытых — `open` + `close_goal`.
- Файлы: `src/ir/graph.ts` (дерево: `hypothesis` в children, `hypothesisParentOf`,
  `hypothesisChildrenOf`, `hypothesisActionsOf`, `hypothesisMode`, `activeHypothesisPath`),
  `src/tools/index.ts` (иерархические id, open под активной, close только активной,
  `not_formula`/`not_leaf`/`empty_hypothesis`), `src/inquiry.ts` (поверхность по режиму,
  промт, проекция активного пути), `src/llm/inquiry.ts` (описания), `tests/inquiry_unit.test.ts`,
  `docs/ru/inquiry.md`.
- Проверки: `npm run typecheck` — чисто; офлайн — **672 passed / 40 skipped**.
- **Live K=3 (v11):** `modernize` 3/3 (39 ходов), `git-leak` 3/3 (49), `log-summary`
  3/3 (38); 0 дублей, 0 отказов. Артефакты `bench/runs/inquiry-v11-<task>-k3/`.
  Вложенность на этих задачах **не использовалась**: модель вела плоские C1/C2/C3
  (корневые). Сравнение ₽ с v9 — только через старый тариф (сегодня 2×).

### Финальный промт (v12): `follows_from` + work tools

- `cites` переименован в **`follows_from`** (payload `followsFrom`, ребро `follows_from`,
  лента `Follows from: C1.2, C3`). Поле required; `[]` — только когда предшественников нет.
- Правило «real data» — **только в базовом промте**: «The summaries of earlier hypotheses
  are real data: trust them and use them in the next claim and its expected observation.»
  Описание инструмента — минимальное (только смысл поля), без дубля и без «do not».
- В базовый промт добавлена граница: «Work tools — the tools that inspect or change the
  workspace — can be used only while a hypothesis is open; opening a hypothesis makes them
  available.» Без имён инструментов (после утренней чистки). Лечит `no shell tool` →
  `not_achieved` после close: модель открывает следующую гипотезу, а не сдаётся.
- Результаты (сегодня 2× тариф; ₽ сравнивать по старому):
  - `log-summary` K=3: **3/3**, ходы 11/11/15, 0.45/0.53/0.59₽. Во всех ровно
    C1 (осмотр) → C2 (счёт+запись) с `follows_from: ["C1"]`; без verify-хвоста и без
    повторного счёта. До этого v11e — 2/3 (один провал на границе).
  - `modernize` K=1: **1/1**, 17 ходов, 0.73₽; C1 → C2 (`["C1"]`) → C3 (`["C1","C2"]`).
  - `custom-memory` K=1: **1/1, achieved, 42 хода, 2.29₽**; C1 → C2 (`["C1"]`), без cap,
    без открытой C3 (было 60/cap/пустой финал). По старому тарифу ≈1.15₽.
- Артефакты: `bench/runs/inquiry-v11f-*`. Не гоняли: K=3 для modernize/custom-memory;
  live-вложенность (`C1.1`) всё ещё не проверена — модель ведёт плоские C1→C2.
- **Сравнение с opencode** (медианы `campaign-k5`, ₽ — оценка по старому тарифу; inquiry
  ₽ пересчитаны со сегодняшнего 2×): `log-summary` 4 хода / ~11k fresh / ~0.85k out /
  ~0.32₽ vs inquiry 11–15 / ~12.7k / ~4.0k / ~0.26₽; `modernize` 5–6 / ~4.7k / ~1.6k /
  ~0.23 vs 17 / ~18.5k / ~5.4k / ~0.37; `custom-memory` ~19–27 / ~27k / ~10k / ~1.38 vs
  42 / ~47.7k / ~17k / ~1.15. Ходов 1.8–3×; на коротких почти весь разрыв — протокол
  (open/close/close_goal). По старому тарифу ₽ сопоставимы, на `custom-memory` inquiry
  дешевле оценки opencode.

## 2026-11-17 — `inquiry`: H-контейнер, `close_goal`, live

> Эта запись новее 2026-11-16. «Root = H-гипотеза» заменён на **H-контейнер**: H создаёт
> движок, модель выдвигает предикаты-гипотезы; финал — `close_goal`. Live-прогоны ниже.

### Итог одной фразой

`T` — запрос и reference. `H` — контейнер формулы (`H = h₁ ∧ h₂ ∧ …`), создаётся движком,
не гипотеза и не пишется моделью. Модель выдвигает предикаты `hᵢ` (утверждение с
`if_true`/`if_false`), по одному открытому; действия идут только под открытым предикатом.
После закрытия предиката — следующий или остановка. Остановка → движок просит `close_goal`,
его `outcome`+`summary` — результат. Журнал монотонен; формула и проекция немонотонны.

### Концепция (реализована)

- `T` — цель/наблюдение пользователя; запрос и reference, не гипотеза.
- `H` — контейнер: `h₁ ∧ h₂ ∧ …`, создаётся движком, своего `suppose` не имеет.
- Предикат `hᵢ` — настоящая гипотеза: `suppose`, `if_true`, `if_false`, вердикт.
- Один открытый предикат; действие без него — `no_open`; второй open — `one_open`.
- `refuted`/`dropped` предикат остаётся в журнале, выпадает из формулы; модель открывает
  замену или останавливается.
- **Остановка.** После close — либо следующий предикат, либо stop (ответ без вызовов).
  Stop при открытом предикате — ошибка `no_close`. При stop движок просит `close_goal`.
- **`close_goal(outcome, summary)`** закрывает H: `outcome` — `achieved`/`not_achieved`,
  `summary` — финальный ответ. Списка оснований нет.
- Работа закрытого предиката уходит с ленты; summary — её единственный след.
- Журнал монотонен; формула/проекция немонотонны; `refuted` — отрицательное знание, а не
  потеря.

### Что уже сделано в коде

- Убран `kind` (`probe`/`change`) из `open_hypothesis`, `HypothesisPayload`, схем,
  проекции, промпта, тестов и доков. Инструменты:
  `open_hypothesis(label, suppose, if_true, if_false)`,
  `close_hypothesis(hypothesis_id, verdict, summary)`; `grounds` убраны и у предикатов.
- Вердикты предиката: `confirmed`/`refuted`/`dropped`. **`done` убран**: это слово про
  завершённость задачи, а не про claim; итог запроса — `outcome` цели (`achieved`/
  `not_achieved`). Смешение `confirmed`/`done` в одном поле путало модель. Убраны `bad_verdict` по kind,
  `not_a_change`, `root_closed`, read-before-write и `stale_base` для `write`/`edit`.
- **H-контейнер реализован.** `T` — запрос/reference; H — узел `formula`, создаётся
  `seedInquiry`, не гипотеза. Предикаты — плоские `hypothesis` под H; итог — `goal_verdict`.
  Рёбра: `formula` (request→H), `hypothesis` (H→предикат), `verdict`, `goal`.
- **Action-binding:** `apply`/`recall`/`search` без открытого предиката — `no_open`;
  второй `open_hypothesis` — `one_open`.
- **`close_goal`** (`outcome`, `summary`) закрывает H и завершает работу. Проверки:
  `open_predicate`, `bad_summary`.
- **Фазы в `runInquiryUnit`:** `open` (только `open_hypothesis`), `work` (рабочие +
  `close_hypothesis`), `finish` (только `close_goal`). Stop при открытом предикате —
  `no_close`; stop в `finish` без `close_goal` — `no_goal`. `FINISH_INSTRUCTION`,
  `OPEN_INSTRUCTION` (критерий остановки) — system-сообщения.
- Гипотезные вызовы — одиночные; смешанный ответ — `hypothesis_tool_alone`.
- Лента: `Opening hypothesis …` / `Closing hypothesis …` + `Summary: …`; финал —
  `Closing formula H: <outcome>. Summary: …` (без grounds, без `(step under …)`).
- **Промпт v8/v9:** задача первой; имена инструментов убраны из общей части и из
  описаний, где инструмент недоступен; `request is the goal`; вердикт предиката — про
  claim, итог запроса — `outcome` цели; `done` убран; stop/`close_goal` — по результату.
- **Строгая поверхность:** `invokeTools` проверяет `toolName` против `allowedTools`;
  вызов вне набора — repair с перечнем доступных, повтор — `model_error` (без крэша и без
  исполнения). Тест в `tests/structured.test.ts`.
- **Кривые вызовы:** `open_hypothesis` без `label`/`suppose` → `bad_hypothesis`, пустые
  ожидания → `bad_expectation`; `model_error` — safety net `runInquiryUnit`.
- Проверки: `npm run typecheck` — чисто; офлайн-тесты — **666 passed / 40 skipped**
  (`no_open`, `one_open`, `close_goal`, `no_close`, `no_goal`, `hypothesis_tool_alone`,
  `open_predicate`, `bad_summary`, `bad_hypothesis`, allowed-surface).
- **Документация:** `docs/ru/inquiry.md` обновлён под H-контейнер/без grounds/`done`;
  включён отдельным коммитом. `docs/ru/tools.md`, `docs/en/tools.md`,
  `docs/ru/ir_operations.md`, `docs/en/ir_operations.md` — предсуществующие правки,
  не трогались.
- Файлы этой итерации: `src/inquiry.ts`, `src/tools/index.ts`, `src/llm/inquiry.ts`,
  `src/llm/structured.ts`, `src/llm/schemas.ts`, `src/llm/tools.ts`, `src/ir/types.ts`,
  `src/ir/graph.ts`, `src/loop/graph.ts`; `tests/inquiry_unit.test.ts`,
  `tests/structured.test.ts`, `tests/sandbox/inquiry-task.ts`, `bench/inquiry.ts`;
  обновления тестов под no-kind/no-gates: `tests/loop.test.ts`, `tests/ops/apply.test.ts`,
  `tests/prompt.test.ts`, `tests/tape_contract.test.ts`; доки: `docs/ru/handoff.md`.

### Эксперименты

Все артефакты — в `bench/runs/…` (durable). Старый `/tmp/skein-inquiry-docker-k3d`
потерян при очистке `/tmp`.

| прогон | код/промпт | solved | ходов | цена | гипотезы |
|---|---|---:|---:|---:|---|
| `inquiry-k3d` | старый код, root-цель | 3/3 | 64 | 3.03₽ | — |
| `inquiry-k3d-v2` | JSON/summary, до lifecycle/root | 2/3 | 40 | 2.13₽ | — (r1 fail, r2 open=1) |
| `inquiry-k3d-v3` | lifecycle/root gate | 3/3 | 36 | 0.99₽ | — (edge collision, closing missing) |
| `inquiry-k3d-v4` | + edge fix | 3/3 | 32 | 0.85₽ | — |
| `inquiry-custom-memory-heap-crash-k1` | старый код, report call | 1/1 | 40 | 1.61₽ | 1 (C1); final DSML |
| `…-k1-v2` | no-kind/no-gates/auto-end + permissive prompt | 1/1 | 22 | 1.11₽ | 1 (C1) |
| `…-k1-v3` | + next-action-explanation prompt | 1/1 | 30 | 1.40₽ | 1 (C1) |
| `…-k1-v4` | + plan-step prompt | 1/1 | 32 | 1.73₽ | 1 (C1) |
| `inquiry-db-wal-recovery-k1` | старый код | 1/1 | 7 | 0.54₽ | 1 (C1) |
| `inquiry-abduction-fix-git-k3` | **абдуктивный v5 + `no_open`** | 3/3 | 38 | 1.22₽ | 1/1/1 (C1, детей нет) |
| `inquiry-abduction-custom-memory-k1` | **абдуктивный v5 + `no_open`** | 1/1 | 20 | 1.05₽ | 1 (C1, детей нет) |
| `inquiry-v7-fix-git-k3` | абдуктивный v7, root=H-гипотеза | **2/3** | 33 | 0.94₽ | 1–2 C1; r3 закрыл без merge |
| `inquiry-v7-custom-memory-k1` | абдуктивный v7 | 1/1 | 37 | 2.02₽ | C1→C2, без `refuted` |
| `inquiry-container-fix-git-k3` | **H-контейнер, без stop-cue** | 3/3 | 63 | 2.02₽ | 2–4 предиката |
| `inquiry-container-custom-memory-k1` | **H-контейнер, без stop-cue** | 1/1* | **60 (cap)** | 2.18₽ | C1–C9, цикл проверок, `final=""` |
| `inquiry-container2-fix-git-k3` | **H-контейнер + stop-cue** | 3/3 | 50 | 1.37₽ | 1–2 предиката |
| `inquiry-container2-custom-memory-k1` | **H-контейнер + stop-cue** | 1/1 | 38 | 1.91₽ | C1 refuted → C2 done → `close_goal` |
| `inquiry-container3-fix-git-k3` | + prompt v7 (1 фраза на место) | 3/3 | 46 | 1.32₽ | 1–3 предиката; 0 отказов |
| `inquiry-container3-custom-memory-k1` | то же | — | — | — | крэш: `open_hypothesis` без `label` |
| `inquiry-container4-custom-memory-k1` | + `bad_hypothesis`/`model_error` | 1/1 | 53 | 2.49₽ | C1→C2→C3 verify; 3 `no_open` |
| `inquiry-container5-fix-git-k3` | **промпт без имён инструментов** | 3/3 | 45 | 1.27₽ | 1–2 предиката; 0 отказов |
| `inquiry-container5-custom-memory-k1` | **промпт без имён инструментов** | 1/1 | 39 | 1.90₽ | C1 refuted → C2; 0 отказов |
| `inquiry-v9-fix-code-vulnerability-k1` | **`done` убран: verdict=claim, outcome=goal** | 1/1 | 15 | 0.49₽ | 1 C1 confirmed → `close_goal`; verify исчез |
| `inquiry-v9-fix-git-k1` | то же | 1/1 | 22 | 0.58₽ | C1 locate → C2 refuted → C3 merge |
| `inquiry-v9-fix-git-k3` | **`done` убран, K=3** | 3/3 | 41 (11/13/17) | 1.24₽ | 1/1/2 предиката; 0 отказов |
| `inquiry-v9-password-recovery-k1` | то же | 1/1 | 23 | 1.34₽ | 1 C1 confirmed; дубль C2 исчез |

- `fix-git` v4: r1 9, r2 12, r3 11 ходов; avg 10.7 vs opencode 8.3; input 65.0k vs
  78.2k; fresh 5.9k vs 4.1k; output 2.2k vs 1.35k; цена 0.283₽ vs 0.20₽; cache 90.9%
  vs 94.8%.
- **`fix-git` v5 (абдукция):** r1 11/0.28₽, r2 11/0.37₽, r3 16/0.57₽; avg 12.7 хода,
  0.407₽. Чуть хуже v4 (10.7 / 0.283₽): +19% ходов, +44% цены. Root — настоящая `H`
  (где лежат правки и как их вернуть), а не пересказ T.
- **`custom-memory` v5:** 20 ходов, 1.05₽, решено; лучше v2 (22/1.11₽), v3 (30/1.40₽),
  v4 (32/1.73₽). Root — причинная `H` про libstdc++/custom heap, не пересказ T. Финал —
  нормальный `summary` из закрытия C1.
- **v7 (root=H-гипотеза):** `fix-git` 2/3 — r3 закрыл корень `confirmed`, не сделав
  merge (слабый `if_true` «можно слить»); `custom-memory` 37/2.02₽, C1→C2, без `refuted`.
- **H-контейнер без stop-cue:** `fix-git` 3/3 (63 хода), `custom-memory` упёрся в 60
  ходов с открытым C9: после фикса (C3 done) модель открыла C4–C9 — повторные проверки;
  `final=""`, `max_turns`. Причина: после close доступен только `open_hypothesis`, а
  «stop» — ответ без вызовов; стёртая работа закрытого предиката вызывала недоверие.
- **H-контейнер + stop-cue:** цикл исчез. `custom-memory` 38/1.91₽: C1 `refuted`
  (неверная причина), C2 `done` (фикс), `close_goal`; финал есть. `fix-git` 3/3,
  50/1.37₽, все реально мержат и проверяют. Цена всё ещё выше v5 (`custom-memory`
  1.91 vs 1.05; `fix-git` 50 vs 38 ходов).
- **Промпт v8 (container5):** имена `open_hypothesis`/`close_hypothesis`/`close_goal` убраны из общей части (остались в описаниях инструментов и phase-сообщении), убран абзац про стирание, задача поставлена первой, `request is the goal` вместо `reference`. Эффект: `custom-memory` 53→39 ходов, 2.49→1.90₽, 3→0 отказов, 3→2 гипотезы, C3-верификация исчезла; `fix-git` 3/3, 45/1.27₽.
- **`grounds` убраны полностью:** и у `close_hypothesis`, и у `close_goal`. Это был
  механический список, который движок не проверял по смыслу; `summary` — единственный
  след. `bad_grounds` и `validGroundsText` удалены.
- `custom-memory` v2/v3/v4 решены, но **всегда одна гипотеза C1**, без детей и
  `refuted`. v4 выбрала `ostringstream`-фикс вместо прямого `_Facet_Register_impl`;
  лишние ~10 ходов (T12–T27) — gdb/заголовки/препроцессор, а не сдвиг цели и не влияние
  plan-step. В v2 финал уже был нормальным `summary`; v1 — DSML.
- `db-wal-recovery`: 7 ходов, 0.54₽, одна гипотеза, XOR-ключ `0x42`; финал нормальный.
- T0 в `custom-memory`: reasoning `open_hypothesis` — «Let me start by exploring the
  workspace». Это **гипотеза/шаг**, а не формальность: модель открыла root-контейнер
  (пересказ T), потому что промпт требует root в начале, а её настоящий claim (осмотр,
  затем причина) остался в reasoning. Это ключевое доказательство ошибки root=цель.

### Проблемы и наблюдения

- **Закрыто этой итерацией:** root-as-goal/H-гипотеза (теперь H-контейнер), авто-завершение
  (теперь `close_goal`), цикл повторных проверок (stop-cue + запрет re-verify).
- **H-контейнер работает:** `custom-memory` 38/1.91₽, C1 `refuted` → C2 `done` →
  `close_goal`, финал есть; `fix-git` 3/3, 50/1.37₽, все реально мержат и проверяют
  (в отличие от v7 r3, где корень был закрыт без merge).
- **`refuted` теперь используется:** в `custom-memory` C1 (неверная причина) закрыт
  `refuted`, C2 — фикс. Отрицательное знание работает.
- **Цена выше v5:** `custom-memory` 1.91 vs 1.05; `fix-git` 50 vs 38 ходов. Причина —
  больше предикатов (C1 refuted + C2 fix) и отдельный ход на `close_goal`.
- **Повторные проверки побеждены stop-cue:** без него `custom-memory` ушёл в 60-ходовой
  цикл; с cue — остановился после C2. Но cue — костыль-подсказка; следить, не исчезнет ли
  эффект на других задачах.
- `grounds` удалены: `summary` несёт всё, что нужно; движок его не разбирает.
- **`done` убран (v9):** вердикт предиката — только `confirmed`/`refuted`/`dropped`; итог запроса — `outcome` цели. Эффект: `fix-code` 27→15 ходов, 0.90→0.49₽, verify-гипотеза исчезла; `password` 29→23, дубль C2 исчез; `fix-git` K=3 — 3/3, 41/1.24₽ (11/13/17), r1/r2 одна гипотеза, r3 — 2 (locate + verify merge), 0 отказов. Против v8 K=3 45/1.27 — небольшое улучшение, стабильно.
- **Якорь протокола:** reasoning на `custom-memory` был перегружен open/close/one-open/
  stop; opencode думает только о задаче. Минимальный промпт v8 убрал этот слой:
  `custom-memory` 53→39 ходов, 3→0 отказов, C3-верификация исчезла. Остаточная цена —
  39 vs 19 шагов opencode, 30 bash vs 16: это gdb/исследование libstdc++, а не протокол.
- `no_open` стоит 1–2 хода (T0 «Let me inspect…» → отказ → open).
- `fix-git` K=5 и `fix-ocaml-gc`/`fix-code-vulnerability` не пробовались; `db-wal` слишком
  прост.
- Рабочее дерево: в коммите — inquiry-код/тесты/handoff; `docs/ru/inquiry.md` и
  предсуществующие правки `tests/sandbox/{campaign,matrix,opencode-run,sandbox-run,tasks/registry}.ts`,
  LHTB-задачи и dotfiles оставлены вне коммита.

### План следующей сессии

1. ~~**H-контейнер + `close_goal`**~~ — сделано: `formula`/`goal_verdict`, фазы,
   `one_open`/`no_open`/`no_close`/`no_goal`, `hypothesis_tool_alone`.
2. ~~**Промпт v8: без имён инструментов в общей части**~~ — сделано; якорь протокола
   снят. `custom-memory` 53→39 ходов, 2.49→1.90₽, 0 отказов; `fix-git` 3/3, 45/1.27₽.
3. **Цена:** `custom-memory` 39 vs opencode 19 шагов, 30 vs 16 bash; `fix-git` 45 vs 8.
   Остаток — gdb/исследование libstdc++ и ходы протокола (open/close/stop/`close_goal`),
   не якорь. Решить, что оптимизировать дальше.
4. **Другие задачи:** `fix-code-vulnerability` K=1, `fix-ocaml-gc` K=1 (60 ходов) — там
   декомпозиция естественна; `fix-git` K=5 после стабилизации.
5. **Коммит** текущего состояния после вычитки.

### Команды и артефакты

- Офлайн: `npm run typecheck`;
  `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — 664/40.
- Inquiry Docker:
  `SKEIN_INQUIRY_TASK=<id> SKEIN_INQUIRY_REPEAT=1 SKEIN_INQUIRY_SAVE=bench/runs/<dir>
  npm run inquiry:docker`. Тяжёлый live — только с разрешения владельца; не запускать
  голый `vitest`; батчи — параллельно, без wall-clock timeout.
- Артефакты: `bench/runs/inquiry-k3d`, `-v2`, `-v3`, `-v4`;
  `bench/runs/inquiry-custom-memory-heap-crash-k1`, `-v2`, `-v3`, `-v4`;
  `bench/runs/inquiry-db-wal-recovery-k1`; `inquiry-abduction-*` (v5);
  `inquiry-v7-*` (root=H); `inquiry-container-*` (без stop-cue);
  `inquiry-container2-*` (с stop-cue).
- Образы/кэш есть для: `fix-git`, `custom-memory-heap-crash`, `db-wal-recovery`,
  `fix-code-vulnerability`, `fix-ocaml-gc`, `cobol-modernization`, `regex-log`,
  `log-summary-date-ranges` и др.
- Текущий промпт — H-контейнер v6 в `src/inquiry.ts`; live container2 — см. таблицу.
  Текущая лента/`close_goal`/тесты/доки — в рабочем дереве, не закоммичены.

## 2026-11-16 — `inquiry`: корень-цель, структурированные инструменты, Docker K=3 (k3d)

### Что сделано

- **Идея.** Единица работает гипотезами. Корень — цель запроса: результат, который должен
  быть верен, когда работа сделана; модель открывает его первой, работает внутри и
  закрывает последней, когда закрыты открытые под ним гипотезы. Гипотеза — утверждение
  (`suppose`) с двумя ожиданиями (`if_true`/`if_false`); вердикт опирается на наблюдения,
  записанные после открытия. Движок не разбирает смысл; он проверяет структуру и пишет
  отказы.
- **Спецификация.** `docs/ru/inquiry.md` (RU-only, контракт): идея, журнал, инструменты,
  правила, проекция, пример `fix-git`, ручной запуск, ограничения, Ankyra-приложение.
- **Промт (B1).** Первый абзац: «You work by hypotheses: you put a hypothesis forward and
  close it when its outcome is observed. This uses the `open_hypothesis` and
  `close_hypothesis` tools. A hypothesis is a claim together with what you expect to see if
  you are right and if you are wrong.» Отдельный абзац: «At the start of the work, call
  `open_hypothesis` to formulate the user's request as the root hypothesis: the result that
  must hold when the work is done, with the observation that shows it. Work inside the root,
  and close it last, once the hypotheses you opened under it are closed.» Вычитанный абзац
  «Develop the active hypothesis: …» сохранён дословно (без перечисления инструментов).
  Отрицательные формулировки убраны.
- **Инструменты.** Описания — структурированные списки. `open_hypothesis`: `kind` —
  `change` (запрос просит результат в рабочем дереве) или `probe` (запрос просит ответ);
  `label`, `suppose`, `if_true`, `if_false`. `close_hypothesis`: закрывает активную и
  только её; `id` — C-номер; `verdict` — для пробы/правки; `grounds` — номера из `[obs:N]`.
- **Grounds числами.** `close_hypothesis.grounds` — `number[]`; `toProposal` превращает
  `N` (и на всякий случай `"N"`/`"obs:N"`) в `obs:N`; `modelCall` показывает модели `N`.
  IR и проверки остаются строковыми `obs:N`.
- **Терминология.** IR переименован под `hypothesis`: узлы `hypothesis`/`hypothesis_verdict`,
  ребро `hypothesis`, операторы `open_hypothesis`/`close_hypothesis`, типы
  `HypothesisPayload`/`HypothesisVerdictPayload`, поле `hypothesisId`, помощники
  `hypothesis*`/`activeHypothesis*`. Старых `claim*` в коде нет; `docs/ru/inquiry.md`
  синхронизирован.
- **Проекция.** Успешные `open_hypothesis`/`close_hypothesis` всегда рендерятся в ленте
  (`[C1] opened change: …`, `C1 done (obs:42, obs:46)`); добавлены result-рёбра
  open→узел гипотезы, close→узел вердикта. При `OPEN: none` лента не схлопывается до
  одних отказов. Закрытая ветка по-прежнему сворачивается в `CLOSED`; детали — `recall`.
- **Реализация.**
  - IR: `src/ir/types.ts`, `src/ir/graph.ts` — узлы, рёбра, дерево, путь активных.
  - `src/llm/inquiry.ts` — поверхность `inquiry`, структурированные описания.
  - `src/llm/{schemas,tools}.ts` — операторы `open_hypothesis`/`close_hypothesis`, маппинг
    числа↔`obs:N`.
  - `src/tools/index.ts` — исполнение, гейты, grounds только наблюдения, `children_open`,
    `bad_grounds` с валидными номерами и `recall`, `bad_verdict`, `not_open`,
    `bad_expectation`.
  - `src/inquiry.ts` — промт, цикл, проекция, остановка с `unresolved`.
  - `bench/inquiry.ts` — ручной запуск (`npm run inquiry`), `--dry`, `--tree`, `--save`.
  - `tests/sandbox/harness.ts` + `tests/sandbox/inquiry-task.ts` — Docker-раннер
    (`npm run inquiry:docker`), K параллельно, network off, maxTurns 60, `--save`.
  - `tests/inquiry_unit.test.ts` — 9 офлайн-тестов (добавлен тест на видимый open/close).
- **Проверки.** Docker `fix-git` K=3 на базах:

  | база | solved | turns | open | cost |
  |---|---:|---:|---:|---:|
  | k3: мутации + B1 («OPEN», отрицательная) | 3/3 | 140 | 17 | 5.71₽ |
  | k3b: без мутаций + B1 отрицательная | 2/3 | 154 | 18 | 5.16₽ |
  | k3c: без мутаций + B1 положительная + `open_hypothesis` | 3/3 | 104 | 2 | 3.61₽ |
  | **k3d: корень-цель + структурированные инструменты + grounds числами + видимый close** | **3/3** | **63** | **0** | **1.58₽** |

  k3d по прогонам: r1 18/0/0.38₽, r2 18/0/0.39₽, r3 27/0/0.81₽. Все три: первый вызов —
  `open_hypothesis kind=change`; корень закрыт `done`; `OPEN: none`; финалы честные
  (master содержит правки, дерево чистое). Артефакты: `/tmp/skein-inquiry-docker-k3d`
  (`events.ndjson`, `result.json`, `tree.txt`, `task.txt`, `check.out.txt`).
- **Сравнение.** Opencode `fix-git` (K=5): 10/10, 8.3 хода, 78.2k in / 4.1k fresh /
  1.35k out, ~0.20₽. Skein `task`: 9/10, 12.6 хода, 65.0k / 19.9k / 3.3k, 0.60₽.
  Inquiry k3d: 21 ход, 116.4k / 14.8k fresh / 3.3k out, 0.53₽ — 3/3; ~2.5× opencode по
  цене, ниже Skein task по fresh и цене, 0.6× ходов и 0.44× цены k3c.

### Проверено

- `npm run typecheck` — чисто.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **661 passed / 40 skipped**;
  `tests/inquiry_unit.test.ts` — 9/9.
- `npm run inquiry -- "..." --dir /tmp --dry` — B1/B2 собираются; `OPEN: none`.
- Docker k3d — **3/3**, verifier 2/2 passed в каждом прогоне, unresolved 0.

### Открыто

- **id гипотезы при close.** r1: `id=6` → `not_open`, потом `C1`; r3: `id=6`,
  `id=w:hypothesis:6` → `not_open`, потом `C1`. Модель читает число из брекета вместо
  `C1` из `OPEN`; 1–2 хода на прогон. Следующий шаг — брекет claim-инструментов `[C1]`
  (и/или принимать `C1`/число).
- **`recall` с голым числом.** r2: `recall 66`; r3: `recall 11`, `40`, `88`, `92` →
  «nothing to recall». r3 из-за этого 27 ходов. Следующий шаг — числовой `recall` (как
  grounds) или нормализация `N` → `obs:N`.
- **bash сразу после закрытия корня** → `no_open`, затем открывается проверочная проба:
  1–2 хода в каждом прогоне.
- **Проверочные пробы новыми корнями.** После закрытия C1 модель открывает C2/C3/C4
  как новые корни, а не детей; «корень закрывается последним» буквально не выполнено,
  но цель закрыта и unresolved=0.
- **Настоящий бенчмарк.** K=3 на `fix-git`; полной кампании K=5 (13 задач) нет.
  k3d ~2.5× opencode по цене; для статьи нужен честный A/B.
- **EN-зеркало** `docs/ru/inquiry.md` не сделано.
- **Workdir.** r2 ходил через `cd /app/personal-site`; r1/r3 — относительные пути.
  Лишних read/ходов в k3d нет.
- **Рабочее дерево:** посторонние незакоммиченные `tests/sandbox/{campaign,matrix,
  opencode-run,sandbox-run,tasks/registry}.ts`, LHTB-задачи и dotfiles не трогались.
- Старый черновик `docs/ru/claims-spec.md` остаётся отдельным слоем; в inquiry не входит.

### Где смотреть / команды

- Спецификация: `docs/ru/inquiry.md`; handoff — здесь.
- Локальный прогон: `npm run inquiry -- "<текст>" --dir <repo> --max-turns 40
  [--tree] [--save <dir>] [--dry]`.
- Docker `fix-git` K=3: `SKEIN_INQUIRY_SAVE=<dir> npm run inquiry:docker`
  (Docker, образ `alexgshaw/fix-git:20251031`, кэш задачи, ключ провайдера;
  тяжёлый live-прогон — только с разрешения владельца).

## 2026-11-15 — препринт на Zenodo (EN), RU-версия синхронизирована

### Что сделано

- **EN-препринт опубликован на Zenodo** 2026-11-15: DOI `10.5281/zenodo.24253692`,
  <https://zenodo.org/records/24253692>. Тип — Preprint, лицензия CC BY 4.0, файл — `skein.pdf`.
  Автор — Vladimir Lapshin (Independent researcher, `mefrill@yandex.ru`).
- **EN-версия** `paper/en/skein.tex` / `.pdf` (16 стр.), **RU** `paper/ru/skein.tex` / `.pdf`
  (17 стр.). Сборка — `paper/build.sh` / `paper/build-en.sh`; обе чистые (0 overfull / missing /
  undefined). RU синхронизирована с EN: `Terminal-Bench`, API-вызовы (2447/1923), 66.2/87.1,
  23/121, «один граф состояний», «как её проверить».
- **Вошло после ревью:** OpenHands/CrewAI; replay 125/125 на реальных журналах (`result.json`,
  поле `events`); `read` 9/170; первый ход состояния 66.2% vs 87.1% (эффект входа ≈0.4 п.п. из
  9.2 п.п. разрыва доли кэша); чувствительность к тарифу (break-even 5.5×, паритет при доле
  кэша 95.2%); Construction = `cobol` + `regex` (72% стоимости состояния); USD по условному
  курсу 80 руб./долл.; CC BY 4.0; email и аффилиация; статус Preprint.
- **Харнесс:** `readReward` теперь принимает не только 0/1, но и дробный reward (LHTB);
  `typecheck` и офлайн-тесты чистые.
- **LHTB-пилот** (2048, great-expectations-audit) остался smoke-test'ом: один `task`/состояние,
  архитектуру не проверяет; в статью не вошёл. Файлы `tests/sandbox/tasks/lhtb-*` и правки
  `campaign/matrix/registry/sandbox-run/opencode-run` оставлены некоммиченными по решению
  владельца.

### Проверено

- EN 16 стр., RU 17 стр.; 0 overfull / missing / undefined.
- `npm run typecheck`; `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` —
  652 passed / 40 skipped.
- Zenodo: title, автор, CC BY 4.0, Preprint, 2026-11-15.

### Открыто

- ORCID у автора нет; affiliation в метаданных Zenodo не заполнена (`None`).
- На Zenodo один файл (EN PDF); RU PDF — в репозитории, не на Zenodo.
- Related identifiers (GitHub, сайт, npm, Docker) в Zenodo не заполнены.
- DOI добавлен в README; в PDF и на сайте — при следующей версии.
- LHTB-пилот не включён; следующая фаза — журнал/Ankyra/checkpoints/observer (раздел 9).

## 2026-11-15 — сайт опубликован на `skein-swe.dev` (Cloudflare DNS + GitHub Pages)

### Что сделано

- **Сайт переписан и закоммичен.** EN/RU-страницы `site/` пересобраны в длинную прозу по
  `docs/ru/site-draft.md` (быстрый старт с RouterAI, введение, обычный агент, отличие, сквозной
  `fix-ocaml-gc`, механика, оценка, установка/Windows/Docker, ссылки); `style.css` — раскладка с
  липким сайдбаром-оглавлением, `app.js` — подсветка активного пункта TOC. README переведён на
  npm/Docker Hub и получил ссылку на сайт. Коммиты: `36c9937` (сайт+draft), `1b558fa` (README),
  `38575f4` (CLI TTY-guard).
- **Домен и DNS.** Домен куплен на reg.ru, NS переведены на Cloudflare
  (`ainsley/sage.ns.cloudflare.com`). В зоне: apex `A`/`AAAA` на GitHub Pages
  (`185.199.108–111.153`, `2606:50c0:8000::/8001::/8002::/8003::153`), `www` CNAME →
  `merfill.github.io`. Записи — DNS only (серая туча), чтобы GitHub выпустил сертификат.
- **Хостинг.** GitHub Pages включён (Source = GitHub Actions), custom domain =
  `skein-swe.dev`. Workflow **Deploy site** (`pages.yml`) прошёл с 4-го запуска; Let's Encrypt
  выпустил сертификат на apex и `www`.
- **Заминка с корнем.** После привязки домена `/index.html` и `/ru/` отдавались, а `/` висел на
  закэшированном в CDN 404 «Site not found» (деплой был до привязки домена). Помог повторный
  запуск workflow уже с доменом: новый деплой переопубликовал сайт и сбросил кэш.
- **Вёрстка и текст утверждены владельцем** (2026-11-15): стиль принят, EN/RU вычитаны.
- **Сайт добавлен в профиль репозитория** (About → Website) владельцем 2026-11-15.

### Проверено

- `https://skein-swe.dev/` → 200, «Skein — a terminal coding agent»; `/ru/` → 200,
  «Skein — терминальный агент разработки»; `style.css`/`app.js` → 200.
- `www.skein-swe.dev` → 301 на apex; сертификат Let's Encrypt валиден для apex и `www`.

### Открыто

- Локальный DNS-кэш у части резолверов ещё отдаёт старую парковку reg.ru; после сброса кэша
  предупреждения HSTS уходят.
- Пункты «домен не куплен / Pages не включён» этой записью закрыты.
- TXT `_github-pages-challenge-merfill` не понадобился — домен не был занят другим сайтом.

