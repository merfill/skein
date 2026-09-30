# Skein — план Tier 0

> Русское зеркало `docs/plans/tier0_plan.md`.

Концептуальный обзор — `docs/concepts_ru.md`. Концептуальное основание —
`ankyra/docs/doxa_and_logos.tex` (докса/логос), `ankyra/docs/concepts_ru.md`
(устройство движка). Этот документ фиксирует **решения и объём первого этапа**.
Код пишется только после этого документа.

## 1. Зафиксированные решения

Полный список решений и роадмап — `docs/plans/implementation_plan_ru.md`. Ключевое для
Tier 0: TypeScript (Node 22, ESM), пакетный менеджер npm; гибридный граф
`work` + `artifact`; append-only журнал + детерминированная проекция; первый
срез — багфикс по падающему тесту; оркестрация LangGraph.js; LLM — провайдер
Ankyra с выключенными размышлениями.

## 2. Соответствие каркасу докса/логос

- **Докса** — LLM: только *предлагает*. Каждое предложение входит со
  `provenance.kind = "llm"` и `status = "open"`, никогда сразу `verified`.
- **Логос** — внутренние операторы: вердикты арбитров (`check`) и замыкание
  artifact-графа (транзитивные зависимости, затронутые тесты).
- **Протокол** — журнал событий, `fold`, `project`, переходы статусов.
- IR — это **протокол + внутренняя часть**, докса в IR не хранится.

## 3. Границы Tier 0

Входит: замкнутый цикл `goal → locate → claim → action → check → done`,
детерминированная проекция, staleness по версии, объективный арбитр.

Не входит (сознательно): AST/символьная таблица, эмбеддинги/retrieval по
похожести, `analogy`, `intuition`, `specificity`, `Revision` как отдельный тип,
CSP/арифметика, UI, мультиязычность, несколько LLM-провайдеров. Строго
минимальный диф.

## 4. Структура проекта

```
skein/
  package.json
  tsconfig.json
  vitest.config.ts
  .env                 # секреты, не коммитится
  .env.example
  .gitignore
  src/
    ir/
      types.ts         # Node, Edge, Provenance, Status
      events.ts        # zod-схемы событий
      graph.ts         # fold(events) -> State (append-only)
      project.ts       # project(State, view) -> Context
    config/
      settings.ts      # env SKEIN_*
    llm/
      client.ts        # ChatOpenAI + reasoning off
      schemas.ts       # zod-схемы предложений
    tools/
      workspace.ts     # fsWorkspace: read/write/version/grep/run
      index.ts         # executeAction + запись событий
    loop/
      state.ts         # аннотации LangGraph State
      propose.ts       # один структурированный вызов LLM
      classify.ts      # детерминированная классификация
      graph.ts         # StateGraph: project -> propose -> classify -> execute -> route
  fixtures/
    bugfix/<id>/       # мини-пакет с падающим тестом (node --test)
  tests/
    ir.test.ts         # golden: fold / project / staleness
    loop.test.ts       # offline-прогон по скрипту
    gate.test.ts       # инварианты (live, opt-in)
    invariants.ts      # общие проверки инвариантов
```

## 5. Модель IR (`src/ir/`)

Два пространства, один граф. Канонические id артефактов:
`file:src/foo.ts`, `sym:src/foo.ts#bar`, `test:...`.

```ts
export type NodeKind =
  | "goal" | "subgoal" | "claim" | "decision"
  | "action" | "observation" | "constraint"      // space: "work"
  | "file" | "symbol" | "test";                  // space: "artifact"

export interface Node {
  id: string;
  space: "work" | "artifact";
  kind: NodeKind;
  label: string;                 // одна строка для индекса
  payload?: unknown;             // содержимое, специфичное для kind
  seq: number;                   // номер события создания
}

export type Provenance =
  | { kind: "llm" }                                   // докса вошла
  | { kind: "user"; turnId: string }
  | { kind: "read"; ref: string; version: string }    // хэш файла
  | { kind: "grep"; pattern: string }
  | { kind: "check"; command: string; verdict: "pass" | "fail"; outputRef?: string };

export type Status =
  | "open" | "verified" | "refuted" | "superseded"    // claim / observation
  | "active" | "applied" | "reverted"                 // decision / action
  | "achieved" | "abandoned"                           // goal / subgoal
  | "must"                                             // constraint
  | "believed" | "stale" | "confirmed";                // artifact

export type EdgeKind =
  | "decomposes" | "supports" | "refutes" | "depends_on"
  | "chosen_over" | "justifies"                        // work -> work
  | "touches" | "locates" | "verifies" | "violates"    // work -> artifact
  | "calls" | "defines" | "imports" | "tests";         // artifact -> artifact

export interface Edge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  provenance: Provenance;
  status: Status;
  version?: string;              // версия мира на момент утверждения
}
```

## 6. События, fold, staleness (`graph.ts`, `project.ts`)

Журнал — **append-only**. Состояние — `fold(events)`. Статусы производные.

```ts
export type Event =
  | { type: "add_node"; node: Node }
  | { type: "add_edge"; edge: Edge }
  | { type: "set_status"; id: string; status: Status; reason?: string }
  | { type: "mutate"; ref: string; version: string; actionId: string }
  | { type: "record_check"; command: string; verdict: "pass" | "fail";
      output: string; claimIds: string[] };
```

**Staleness по версии (главный механизм).** Каждый artifact-факт (`read`/`grep`)
хранит `version` — хэш файла на момент чтения. Событие `mutate` переводит в
`stale` все факты, чей `ref` совпал, а `version` отличается. Это делает
немонотонность кода детерминированной и не требует ручного отката: знание в
журнале монотонно, а мутабельный код — производная от реплея действий.

Проекция:

```ts
export interface Context {
  header:   { goal: Node; constraints: Node[] };      // стабильный префикс
  frontier: {
    claims:       Node[];   // status = "open", с краткой provenance
    decisions:    Node[];   // status = "active"
    lastAction?:  Node;
    observations: Node[];   // последнее на каждый активный claim
    rejected:     string[]; // refuted/superseded — одна строка
  };
  artifacts: { id: string; label: string; stale: boolean }[];  // только индекс
  index:     { id: string; kind: NodeKind; label: string }[];  // что вообще есть
  recent:    Turn[];                                            // последние N ходов
}
```

«Активно» = путь от `open`-цели через `active` decisions/actions к `open` claims
(релевантность по происхождению, а не по похожести). Содержимое артефактов в
проекцию не попадает — только id + одна строка; `stale` сворачивается в строку.

## 7. Цикл на LangGraph.js (`src/loop/`)

```
START → project → propose → classify → execute → route
route ──continue──▶ project
route ──done | budget | error──▶ END
```

- **project** — чистая функция из `State`; никакого LLM.
- **propose** — ровно один структурированный ответ (zod) вида
  `{ thought, action }`, где `action` — один из `track | read | grep | edit |
  run | query | finish`. `thought` — нарратив хода, в IR **не** пишется.
- **classify** — детерминированно: `derivable | cited | hypothesis | rejected`
  (cited = подкреплено выводом инструмента/цитатой; rejected = противоречит
  `verified`-факту или constraint).
- **execute** — детерминированно выполняет инструмент и пишет события.

Состояние — `Annotation.Root`: `events` (reducer `concat` — append-only),
`context`, `proposal`, `classification`, `turn`, `done`, `stopReason`. Различие
проекции и состояния повторяет `WaveContext` / `build_hint` из Ankyra.

## 8. Инструменты (`src/tools/`)

| Инструмент | Пишет в IR | Роль |
|---|---|---|
| `read(path, range?)` | artifact-факты с `version` | локализация; содержимое — эфемерное наблюдение |
| `grep(pattern)` | индекс попаданий | локализация |
| `edit(path, find, replace)` | `action` + `mutate` | мутация мира (немонотонность) |
| `run(command, claims?)` | `record_check` | **арбитр**: verdict pass/fail |
| `track(...)` | claim/decision/constraint (`status=open`) | докса предлагает |
| `query(selector)` | ничего (одноразовый ответ) | запрос к IR |
| `finish(summary)` | `action` | запрос остановки |

## 9. LLM-слой и настройки (`src/llm/`, `src/config/`)

Тот же провайдер, что в Ankyra: OpenAI-совместимый endpoint, `ChatOpenAI` из
`@langchain/openai`. Структурированный вывод — `withStructuredOutput(zodSchema)`.

Размышления выключены **обязательно** (как в Ankyra):

```ts
new ChatOpenAI({
  configuration: { baseURL: env.SKEIN_API_URL },
  apiKey: env.SKEIN_API_KEY,
  model: env.SKEIN_MODEL,
  temperature: Number(env.SKEIN_TEMPERATURE ?? 0.1),
  maxTokens: Number(env.SKEIN_MAX_TOKENS ?? 4096),
  modelKwargs: {
    thinking: { type: "disabled" },     // DeepSeek: не «думать»
    reasoning: { effort: "none" },      // RouterAI: reasoning budget = 0
  },
});
```

Переменные окружения, префикс `SKEIN_` (секреты — только в `.env`):

| Переменная | Значение по умолчанию |
|---|---|
| `SKEIN_API_URL` | `https://routerai.ru/api/v1` |
| `SKEIN_API_KEY` | — (из `.env`, не коммитится) |
| `SKEIN_MODEL` | `~deepseek/deepseek-v4-flash-latest` |
| `SKEIN_TEMPERATURE` | `0.1` |
| `SKEIN_MAX_TOKENS` | `4096` |
| `SKEIN_REASONING_EFFORT` | `none` |
| `SKEIN_MAX_TURNS` | `24` |
| `SKEIN_LIVE` | `false` |

## 10. Гейт: фикстуры, инварианты, проверка

**Фикстуры.** `fixtures/bugfix/<id>/` — мини-пакет с одним падающим тестом
(`node --test`). Цель прогона: «сделать тест зелёным, не сломав остальные».
Constraint: «не редактировать тестовые файлы». Срез — 3–5 своих задач, каждая
понятна вручную.

**Инварианты (жёсткие, проверяются на каждом прогоне):**
- claim не становится `verified` без `check`-provenance;
- `stale`-факт никогда не показывается как активное содержимое;
- `project` детерминирован: одни события → один `Context`;
- цель закрывается только при прохождении арбитра (`run` вернул `pass`);
- constraint `must` не нарушается (тестовые файлы не меняются);
- границы по числу ходов/действий.

**Проверка:**
- `npm run typecheck` — `tsc --noEmit`;
- `npm test` — vitest: golden-тесты `fold`/`project`/staleness + инварианты;
- live-прогон агента — только при `SKEIN_LIVE=true`.

## 11. Порядок работ

1. Скелет TS-проекта: `package.json`, `tsconfig`, `vitest.config`, `.env.example`,
   `.gitignore`.
2. `src/ir/`: типы → события → `fold` → `project` + golden-тесты.
3. `src/config/` + `src/llm/`: клиент, zod-схемы, проверка «размышления выключены».
4. `src/tools/` и `src/loop/`: классификация, выполнение, LangGraph.
5. `fixtures/bugfix/*` + гейт; прогон 3–5 задач.

## 12. Открытые развилки

- Валидация предложений: жёсткий zod-контракт vs мягкий fallback JSON (как в
  `llm/structured.py` Ankyra). Для Tier 0 — жёсткий zod, fallback позже.
- Формат `payload` подписи `finish`/`run`: свободный текст vs типизированный
  предикат. Для Tier 0 — свободный, с проверкой арбитром.

## 13. Статус реализации (Tier 0)

Реализованы шаги 1–5:

- `src/ir/` — типы, zod-события, `fold` (со staleness по версии), `project`.
- `src/config/`, `src/llm/` — настройки `SKEIN_*`, клиент провайдера Ankyra с
  выключенными размышлениями (`reasoningOffBody`), zod-схемы предложений.
- `src/tools/` — `fsWorkspace` (read/write/version/grep/run) и `executeAction`.
- `src/loop/` — детерминированная классификация, `propose`, LangGraph-граф
  (`project → propose → classify → execute → route`), `runAgent`.
- `fixtures/bugfix/{off-by-one,missing-bang,max-first}` — 3 задачи с `node --test`.
- Гейт: `tests/loop.test.ts` (offline, 17 тестов), `tests/gate.test.ts`
  (live, под `SKEIN_LIVE=true`).

Упрощения Tier 0 (осознанные, не баги):

- `run` верифицирует **все открытые claims** по умолчанию; можно сузить через
  `claims` в действии. Семантика «какой именно claim подтверждает тест» груба.
- Содержимое файлов в IR **не** хранится: только индекс артефактов + эфемерные
  ходы `recent`.
- Цель не становится `achieved` автоматически; её закрывает харнесс (Арбитр).
- `finish` не проверяет цель — это делает гейт после прогона.

Live-путь (`withStructuredOutput` + zod v4, `modelKwargs`) проверен: при
`SKEIN_LIVE=true` гейт проходит на всех трёх фикстурах (20 тестов). Секреты — в
`skein/.env`, файл в `.gitignore`.

Решено: constraint проверяется по эффекту. `edit` проверяется в `classify`; перед
командой `run` снимается снапшот файлов, подпадающих под `payload.forbid`, и любое
их изменение откатывается, записывается наблюдением `constraint violation` и
никогда не становится проходящим check. См. `docs/plans/constraint_guard_plan_ru.md`.
