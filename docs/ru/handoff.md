# Handoff — текущее состояние

> Рабочий документ передачи. Английского зеркала нет. История изменений по датам удалена:
> она остаётся в git. Здесь — только текущее состояние и последняя выполненная работа.

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

