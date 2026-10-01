# Skein — план фиксации отказов (запись отклонённых предложений)

> Английское зеркало — `docs/plans/rejection_plan.md`.

Связанные: `docs/design_review_ru.md` (P3), `docs/concepts_ru.md` (первый
принцип), `docs/ir_ru.md` §2–4. Общий план — `docs/plans/implementation_plan_ru.md`.

Статус: реализован (см. §8).

## 1. Проблема

Отказ `classify` — решение логоса: движок рассмотрел предложение и отказал с
причиной (`src/loop/classify.ts`). Принятое действие становится знанием в IR;
**отказ — нет**. Он попадает только в `recent`, а это:

- **не журнал**: живёт в `LoopState` (`src/loop/state.ts:18`), не выводится из
  событий и не воспроизводится реплеем;
- **ограничен хвостом**: проекция берёт последние `tail=6` (`src/ir/project.ts`),
  дальше отказ вытесняется.

Отсюда две дыры:

- **нет источника в журнале** — у решения движка нет следа в IR, против первого
  принципа;
- **нет памяти у модели** — контекст пересобирается из состояния каждый ход, а
  отказ в состояние не входит, поэтому после вытеснения модель «забывает» его и
  может повторить запрещённое действие.

Не путать с гардом `run`: там движок исполняет команду, откатывает запрещённое
изменение и **пишет observation** (`src/tools/index.ts`). Этот путь уже записан.

## 2. Решение

Добавить **событие `record_rejection`**, симметричное `record_check`. И вердикт
арбитра, и отказ врат — это *записи логоса*, а не узлы-веры. Отказ не
материализуется узлом: у него нет мирового содержания, только сигнатура
предложения и причина. Так `index` не трогаем (R1), не плодим статусы и не
расширяем словарь узлов.

## 3. Дизайн

- `src/ir/events.ts` — новое событие `record_rejection`:
  `{ tool, target, reason, constraintId?, turn }`.
- `src/ir/graph.ts` — `RejectionRecord` и `state.rejections`, заполняемые
  `fold` (рядом с `state.checks`). Append-only; реплей даёт то же состояние.
- `src/ir/constraints.ts` — `forbiddenConstraints(state)`, возвращающий
  `{ id, pattern }`, чтобы назвать нарушенный constraint.
- `src/loop/classify.ts` — `Classification` несёт нарушенный `constraintId`.
- `src/loop/graph.ts` — при отказе предложения пишет `record_rejection` из
  сигнатуры действия и `classification.reason`.
- `src/ir/project.ts` — новая секция `frontier.refusals` (одна строка), ограничена
  `tail`, группируется по сигнатуре со счётчиком повторов.
- `src/loop/propose.ts` — описать `frontier.refusals` в системном промпте.
- Доки — `docs/ir.md` / `ir_ru.md` (операции, проекция),
  `docs/design_review.md` / `_ru` (P3).

Сигнатура: `tool` плюс `target` (path / command / `kind:label`), одна строка,
обрезана. Полное предложение не хранится; мысль остаётся в хвосте.

## 4. Проверка

- `npm run typecheck`; `npm test`.
- Тесты: `record_rejection` проходит схему события; `fold` кладёт его в
  `state.rejections`; запрещённый `edit` даёт `record_rejection` с верными
  `tool`/`target`/`reason`/`constraintId`; `project` показывает его в
  `frontier.refusals`; повторы схлопываются в одну строку со счётчиком; секция
  ограничена `tail`.

## 5. Инварианты

- Журнал остаётся append-only; считается только производное состояние.
- `fold` и `project` остаются чистыми и детерминированными.
- Докса только предлагает; отказ фиксирует движок (логос).
- Предложение не хранится как вера; записывается лишь его сигнатура.

## 6. Границы

- Гард `run` не трогаем — он уже пишет observation.
- Провалы инструментов (`read failed`, `edit failed`) — ответ мира, а не отказ
  врат; отдельный вопрос, вне объёма.
- Спекулятивное деление `provenance.llm` на
  `llm_proposal`/`llm_hallucination` не делаем (в коде вид не производится, у
  узлов нет провенанса).

## 7. Порядок работ

1. Схема события и состояние.
2. Врата: id constraint и эмиссия события.
3. Проекция `frontier.refusals`.
4. Промпт.
5. Тесты и доки.

## 8. Статус

Реализовано. Событие `record_rejection` (`src/ir/events.ts`); `RejectionRecord`
и `state.rejections` в `fold` (`src/ir/graph.ts`); `forbiddenConstraints` и
`constraintId` в `classify` (`src/ir/constraints.ts`, `src/loop/classify.ts`);
эмиссия в цикле (`src/loop/graph.ts`); `frontier.refusals` со схлопыванием по
сигнатуре в проекции (`src/ir/project.ts`); заметка в промпте
(`src/loop/propose.ts`). `npm run typecheck` чист, `npm test` проходит (40
тестов). Доки обновлены: `docs/ir.md` §2, §4, §6; `docs/design_review.md` (P3).
