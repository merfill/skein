# Skein — план бюджета индекса (адресное пространство и бюджет ходов)

> Английское зеркало — `docs/plans/index_budget_plan.md`.

Связанные: `docs/design_review_ru.md` (R1, P4), `docs/concepts_ru.md` (решённый
вопрос 4), `docs/ir_ru.md` §4. Общий план — `docs/plans/implementation_plan_ru.md`.

Статус: реализован (см. §8).

## 1. Проблема

Две дыры в бюджете контекста:

- **R1. Неограниченный `index`.** `project` отдаёт каждый узел как
  `{ id, kind, label }`; это единственная секция без границы, и она растёт
  линейно прогону (50 ходов → список в 50 записей). Он дублирует
  header/frontier/artifacts и не даёт ни статусов, ни рёбер. Его роль для LLM
  никогда не была определена.
- **P4. Нет бюджета ходов.** `maxTurns` живёт в цикле, поэтому модель не видит,
  сколько ходов осталось.

## 2. Решение

**R1 — `index` есть адресное пространство (контракт A).** Проекция гарантирует:

```
∀ узла n ∈ State :  id(n) либо показан в Context, либо достижим
                    детерминированным запросом к State (`query { id | kind | status }`).
```

Поскольку `query` уже достаёт любой узел, перечисление для гарантии не нужно —
это лишь один из двух механизмов. Значит `index` становится ограниченной сводкой:
счётчики по видам (форма пространства) плюс окно новейших `K` узлов (удобство).
Полные списки — через `query`.

**P4 — бюджет ходов — часть `header`.** Цикл передаёт `{ turn, maxTurns }` как
опцию проекции; header отдаёт `{ turn, maxTurns, remaining }`. Ходы
детерминированы; бухгалтерия токенов — нет, и остаётся вне.

## 3. Дизайн

- `src/ir/project.ts`
  - `Context.index` становится `{ counts: Partial<Record<NodeKind, number>>;
    recent: IndexEntry[] }`, где `IndexEntry = { id, kind, label }`.
  - `counts` строится в порядке `NODE_KINDS` (стабильно, независимо от порядка
    вставки); `recent` — новейшие `K = tail` узлов по убыванию `seq`.
  - `ProjectOptions` получает `budget?: { turn: number; maxTurns: number }`;
    header несёт `{ turn, maxTurns, remaining }`, когда задано.
- `src/loop/graph.ts` — передавать
  `budget: { turn: state.turn, maxTurns: deps.maxTurns }` в оба вызова `project`.
- `src/loop/propose.ts` — описать `header.budget` и контракт `index` (сводка плюс
  запросный путь).
- Доки — `docs/concepts.md` / `_ru` (Q4), `docs/ir.md` / `ir_ru.md` §4, §6,
  `docs/design_review.md` / `_ru` (R1, P4),
  `docs/plans/implementation_plan.md` / `_ru`, `README.md`.

## 4. Проверка

- `npm run typecheck`; `npm test`.
- Тесты: `index.counts` суммируется в общее число узлов и упорядочен по
  `NODE_KINDS`; `index.recent` ограничен `tail` и идёт от новых к старым; узел вне
  окна всё ещё возвращается `query { id }` (адресуемость); `header.budget` несёт
  верный `remaining`.
- Пример в `docs/ir.md` §6 обновлён под новую форму.

## 5. Инварианты

- Адресуемость: ни один узел не становится неназываемым от ограничения `index`.
- `project` остаётся чистым и детерминированным для одного состояния и опций.
- Журнал остаётся append-only; в IR ничего не меняется.
- Бюджет видимости: `index.recent`, `recent`, `verified`, `refusals` делят один
  параметр `tail` — «сколько показываем»; гарантия остаётся «что доставаемо».

## 6. Границы

- Бухгалтерии токенов нет (недетерминирована).
- `query` не меняется; сводки достаточно, чтобы показать форму пространства.
- Истинная provenance-релевантность (рабочее множество) вне объёма; это C2.

## 7. Порядок работ

1. Форма `index` и `budget` в проекции.
2. Передать бюджет из цикла.
3. Промпт.
4. Тесты и доки.

## 8. Статус

Реализовано. `Context.index` — `{ counts, recent }`, `header.budget` опционален и
считается в `project` (`src/ir/project.ts`); цикл передаёт бюджет
(`src/loop/graph.ts`); промпт описывает и то, и другое (`src/loop/propose.ts`).
`npm run typecheck` чист, `npm test` проходит (42 теста). Доки обновлены:
`concepts`, `ir`, `design_review`, `implementation_plan`, `README`.
