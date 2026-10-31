# General unit — не-кодинговая задача с одним рабочим сегментом

> Английское зеркало — `docs/plans/general_unit_plan.md`.
>
> Статус: реализован первый срез. Typecheck чистый; офлайн-набор — **524 passed,
> 40 skipped**. Live `general-live` пройдена: маршрут `general`, read-only инструменты, без coding task, Markdown-ответ.

## 1. Зачем

Запрос «разобрать задачу на бенчмарке / показать, как это делалось» уходил в кодинговый
`task`. Острова кодинга выталкивали его в `research → construction`: у `research` нет перехода
в `end` (`src/ir/islands.ts`), поэтому чистый анализ принудительно становился продуктивной
работой. Решение — отдельный unit для общих задач, а не новое состояние кодинга.

Промпт сессии тоже сужен: `start` — для работы, меняющей файлы или запускающей команды с
побочными эффектами; анализ идёт через `respond` или `general`.

## 2. Unit

`UnitType = "general"`; это **не** кодинговый остров. Форма IR такая же, как у task:

```text
request → move(general) → plan → items → actions → observations → stop
```

- один рабочий сегмент, без переходов по островам и без состояния `end`;
- `move.payload.state` — метка уровня unit'а `general`; `moveIsland` возвращает `undefined`,
  поэтому кодинговая state machine его не видит;
- план обычный; действия `read`/`grep`/`list` добавляют items и observations;
- `stop` на move закрывает единственный сегмент и unit; `stop.why` — финальный ответ;
- `attentionOf` выводит `completed` из этого `stop`.

У unit'а свой журнал и изоляция: он видит только переформулированный запрос и свои результаты
инструментов, не L0 сессии и не чужие unit'ы.

## 3. Цикл и промпт

`GENERAL_BASE_PROMPT` — промпт unit'а/состояния, а не каталог инструментов:

```text
You are a general analysis agent. You work in one state, General.
State: General — answer the request from the material.
Done: the answer is complete and supported by what you read.
This state only reads: do not change files and do not run mutating commands.
Answer in GitHub-flavored Markdown. Write the final answer as the assistant message. When it is
complete, close the state with `stop`; `why` is a short closure note.
```

Лента:

```text
system: базовый промпт
user:   переформулированный запрос
assistant/tool: вызовы read/grep/list и результаты
system: Finish state General — <answer/why>
```

Имена и описания инструментов передаются через tool surface, не через промпт. Модель видит
`read`, `grep`, `list`, `stop`; изменяющих инструментов нет.

## 4. Маршрутизация сессии

Новая операция `general { text }`. Маршрут выбирается по типу результата, не по ожидаемой
длине:

- `respond` — разговорный ответ или прямой фактический указатель; отдельного следа нет;
- `general` — сам запрос является не-кодинговым анализом/объяснением/сравнением/отчётом по
  материалу; он получает собственный след;
- `start` — запрос меняет файлы или запускает команды с побочными эффектами.

General-агент видит только бриф; session-агент включает в него цель и релевантный контекст.
Post-task report нет: ответ — assistant-сообщение, сохранённое на stop-узле; `stop.why` — короткий итог.

## 5. UI

- Существующая правая панель задачи показывает general-unit как одно состояние `general` с
  ходами, токенами и действиями; отдельного окна для general нет.
- Существующий overlay истории может показывать unit как task-подобную строку.
- L0-след детерминированный: действия из плана (`read NOTES.md`, `grep "RULE"`, `list .`) и
  короткий preview ответа со stop-узла. Полный ответ и тела наблюдений остаются адресуемыми
  через unit (`turns`/`body`/`search`).
- Строки trace помечены `[general]`; финальный ответ — обычный Markdown-assistant turn.
- `Σ` в header включает general model calls; `ctx` остаётся контекстом session-агента.

## 6. Файлы

- `src/session/general.ts` — промпт, цикл, IR-seed, прогресс и телеметрия.
- `src/llm/general.ts` — model proposer (`read/grep/list/stop`).
- `src/session/types.ts`, `operations.ts`, `session.ts`, `driver.ts`, `session_outline.ts` —
  тип unit'а, операция, pending, dispatch/resume/cancel, завершение и L0.
- `src/session/session_agent.ts`, `src/llm/session_agent.ts` — утверждённая маршрутизация и
  описания инструментов.
- `src/tui/*` — префикс general, live journal, включение в панель/историю.
- `tests/general_unit.test.ts`.

## 7. Отложено

- `probe`/`fetch` в general-инструментах;
- live-сценарий, доказывающий, что session-агент выбирает `general` для анализа;
- отдельный general-report/summary (пока ответ хранится на stop-узле);
- отдельный фильтр/бейдж истории, если смешанный список станет шумным;
- включать `general` в кодинговый base prompt сознательно не стали.

## 8. Команды

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'
npm run cli -- --dir <project>
```
