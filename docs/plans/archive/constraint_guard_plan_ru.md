# Skein — план эффект-гарда для constraint (обход через run)

> Английское зеркало — `docs/plans/archive/constraint_guard_plan.md`.

Общий план — `docs/plans/implementation_plan_ru.md` (§3 «Ближайшие шаги», §6 «Открытые
вопросы»). Спецификация Tier 0 — `docs/plans/archive/tier0_plan_ru.md` (§13, «Висячий вопрос»).

## 1. Проблема

Запрет `must` задан как `payload.forbid` — список regex-ов по путям. Сейчас
`classify` применяет их только к действию `edit` (`action.path`). Действие `run`
выполняет shell-команду без проверки, поэтому может обойти запрет, например
`printf ... > test/sum.test.mjs` или `sed -i ... test/sum.test.mjs`. Арбитр
(тест + неизменность тестовых файлов) ловит это после прогона, но движок
(«логос») — нет.

## 2. Решение

Проверять запрет **по эффекту**, а не разбором shell-строки. Constraint
запрещает *изменение* совпадающих путей, а не *упоминание* их. Статическое
сравнение с командой — эвристика с реальными ложными срабатываниями
(`cat test/x.test.mjs`, `node --test test/x.test.mjs`) и пропусками
(`$(...)`, переменные, `base64`).

Отклонённая альтернатива: расширить `classify` на сравнение regex-ов с
`action.command`. Минимальный диф, но эвристика.

## 3. Устройство

- Перед `run`: для каждого forbid-паттерна найти совпавшие файлы в workspace и
  снять снапшот содержимого.
- Выполнить команду.
- После: если запрещённый файл изменился — восстановить его, записать
  наблюдение `constraint violation (<pattern>): <path>` и **не** писать
  `record_check`/`verifies` (claim не верифицируется). Вернуть ход с пометкой об
  откате.
- Если ничего не изменилось — прежнее поведение.
- `classify` сохраняет дешёвый pre-check для `edit` без изменений.

## 4. Изменения

1. **`src/ir/constraints.ts` (новый, чистый).**
   - `forbiddenPatterns(state): string[]` — переезжает из `classify.ts`.
   - `matchesPath(pattern, path): boolean` — `RegExp` с try/catch (как сейчас).
   - Нужны и `classify`, и `tools`; `ir/` исключает цикл `loop ↔ tools`.
2. **`src/tools/index.ts`, ветка `run`.**
   - Снапшот совпавших файлов через `forbiddenPatterns` + `workspace.list()`.
   - При изменении: `workspace.write` возвращает старое содержимое, пишется
     observation о нарушении, `record_check`/`verifies` пропускаются.
3. **`src/loop/classify.ts`** — импортирует общий хелпер; логика `edit` без
   изменений.
4. **`src/loop/propose.ts:27`** — расширить: не менять запрещённые пути ни через
   `edit`, ни через `run`.
5. **`tests/loop.test.ts`**
   - scripted-интеграция: constraint `\.test\.mjs$`, `run` пишет в
     `test/sum.test.mjs` → файл не изменён, нет `mutate`, есть observation о
     нарушении;
   - существующий e2e (`node --test` проходит, тестовый файл не тронут) остаётся
     регрессией.
6. **Доки** — висячий вопрос → решён в `tier0_plan_ru.md` §13 (298-300) и
   `tier0_plan.md` (~300); убрать/пометить открытый вопрос в
   `implementation_plan_ru.md` §3.1 + §6 и в `_ru`-зеркале (46-47, 68).

## 5. Проверка

- `npm run typecheck`;
- `npm test` — offline. Live-гейт только при `SKEIN_LIVE=true`.

## 6. Границы

- `run`, мутирующий незапрещённые файлы, по-прежнему не пишет `mutate`
  (существующее поведение; вне объёма).
- Shell-песочницы нет; для `run` гард пост-фактум, с откатом для сохранения
  инварианта.

## 7. Статус

Реализовано. `src/ir/constraints.ts`; гард в ветке `run` `src/tools/index.ts`;
общий хелпер в `src/loop/classify.ts`; регрессионный тест в `tests/loop.test.ts`.
`npm run typecheck` чист, `npm test` проходит (21 тест). Висячий вопрос Tier 0
помечен решённым в `docs/plans/archive/tier0_plan_ru.md` §13, открытый вопрос закрыт в
`docs/plans/implementation_plan_ru.md` §3/§6.
