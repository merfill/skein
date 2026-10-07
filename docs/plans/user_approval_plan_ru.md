# Skein — план пользовательской приёмки (арбитр: приёмка пользователя)

> Английское зеркало — `docs/plans/user_approval_plan.md`.

Связанные: `docs/design_review_ru.md` (C1), `docs/concepts_ru.md` (арбитр),
`docs/ir_ru.md` §2. Общий план — `docs/plans/implementation_plan_ru.md`.

Статус: реализован (см. §8).

## 1. Проблема

`verified` достижим только через `record_check`, который инструмент `run`
выдаёт на прошедшую команду. У не-кодовой работы (документ, дизайн) нет тест-
раннера, поэтому она не может достичь settled-состояния. Концепция уже называет
**арбитра** (пользователя, через критерии приёмки) рядом с
объективным тулчейном, но механизма не было.

LLM-критик, выдающий проверки, отвергается: он поставил бы доксу в роль логоса.

## 2. Решение

Переиспользовать `record_check` с полем авторитета: `actor: "arbiter" | "user"`
(по умолчанию `arbiter`). Вердикт пользователя входит **out-of-band** (как seed
цели), никогда не через действие LLM, поэтому у `verified` остаётся ровно один
путь, а инвариант `verifiedWithoutCheck` не трогается.

## 3. Дизайн

- `src/ir/events.ts` — `record_check` получает `actor?: "arbiter" | "user"`.
- `src/ir/graph.ts` — `CheckRecord` несёт `actor`; `fold` дефолтит в `"arbiter"`.
- `src/ir/approval.ts` — `userAcceptance(claimIds, verdict?, note?)` строит
  `record_check` с `actor: "user"`.
- `src/tools/index.ts`, `run` — явно ставит `actor: "arbiter"`.
- `src/tools/index.ts`, `query` — `verdictOf` отдаёт checks с `actor`.
- `src/loop/propose.ts` — промпт говорит, что claim закрывается объективной
  проверкой или приёмкой пользователя.
- Доки — `docs/concepts.md` / `_ru`, `docs/ir.md` / `ir_ru.md`,
  `docs/design_review.md` / `_ru`.

## 4. Проверка

- `npm run typecheck`; `npm test`.
- Тесты: user-проверка проходит схему события; `userAcceptance` подтверждает
  claim и пишет `actor: "user"`; обычная проверка дефолтит в `"arbiter"`;
  `verdictOf` показывает авторитет; `verifiedWithoutCheck` держится.

## 5. Инварианты

- У `verified` по-прежнему ровно один путь: `record_check` с `verdict = "pass"`.
- LLM не может выдать проверку вовсе.
- Журнал остаётся append-only; `fold`/`project` чисты и детерминированы.

## 6. Границы

- UI или интерактивный промпт не делаются; харнесс вызывает `userAcceptance`.
- Проекция не различает авторитет в `frontier.verified`; `actor` доступен через
  `query { verdictOf }`.

## 7. Порядок работ

1. Поле `actor` (события, состояние).
2. `userAcceptance`.
3. `run` и `query`.
4. Промпт, тесты, доки.

## 8. Статус

Реализовано. `record_check` несёт `actor` (`src/ir/events.ts`); `CheckRecord` и
`fold` дефолтят в `"arbiter"` (`src/ir/graph.ts`); `userAcceptance` фиксирует
вердикт арбитра (`src/ir/approval.ts`); `run` помечает `"arbiter"`, а
`query { verdictOf }` отдаёт авторитет (`src/tools/index.ts`).
`npm run typecheck` чист, `npm test` проходит. Доки обновлены: `concepts`, `ir`,
`design_review`.
