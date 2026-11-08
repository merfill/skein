# Handoff — текущее состояние

> Рабочий документ передачи. Английского зеркала нет. История изменений по датам удалена:
> она остаётся в git. Здесь — только текущее состояние и последняя выполненная работа.

## 2026-11-08 — ревизия документации и чистка legacy

### Документация

- Концепции переписаны вокруг двух главных идей: **немонотонный контекст** и **состояния и
  переходы**. Убраны докса/логос, `acceptance`-идеология и старые термины.
- `ir.md` разделён на два документа:
  - `ir.md` — концептуальная модель: журнал, состояния, переходы, записи, контекст, инварианты;
  - `ir_operations.md` — справочник: поверхность модели, операторы, таблицы инструментов, отказы,
    реализация и матрица покрытия. Coverage-гейт читает `docs/en/ir_operations.md`.
- `projection.md` переписан под текущую ленту: запрос, краткая справка, `Start`, ходы, рабочий
  промпт, `Finish` + `Artifacts:`, `recall`/`search` как обычные ходы.
- `sessions.md` заменил `session_concepts.md`: сессия как контейнер единиц работы, следы, операции
  `respond`/`general`/`task`, изоляция, переформулировка, пауза/возврат/отмена, наблюдатель.
- `states.md` приведён к `src/ir/islands.ts`: текущие `what`, `Done when`, инструкции, переходы,
  поверхность инструментов.
- `system_prompt.md` очищен от фаз и старых блоков; описаны текущие `B1`/`B2` и ситуации
  `request`/`working`/`transition`/`terminal`.
- `testing.md` объединил `state_testing.md`; убраны Harbor и дублирующий раздел, исправлен дефолт
  `--turns` (80, у `fix-ocaml-gc` — 60).
- `tools.md` переписан как контракт модельных имён и параметров; `stop` больше не инструмент.
- `walkthrough.md` переписан под текущую проекцию; сквозной пример Patch → Verification (провал) →
  revert → Patch → Verification (успех) → End.
- `README.md`, `docs/README.md`, `docs/en|ru/README.md` и `AGENTS.md` осовременены; ссылки на
  удалённые документы убраны.

### Код

- Операция сессии `start` переименована в `task` (код, промпт, TUI, тесты, доки).
- `doxa`/`logos` заменены на `model`/`executor` в комментариях и provenance-значениях.
- Удалён legacy reading-юнит: `src/session/reading.ts`, тип `"reading"`, `readFile`-проброс через
  `session_agent`/`session_memory`, обработка в `session.ts`/`session_outline.ts` и тесты.
- `session_workspace.ts` урезан до production-части: `generalFactsText` и
  `projectInstructionsText`.
- Удалены неиспользуемые экспорты: `stackOf`, `isFinished`, `probeBrief`, `workspaceBrief`,
  `noopTelemetry`, `contextTimeline`, `noopProgress`.
- Удалён shim `tests/sandbox/checkpoint.ts`; импорты переведены на `src/tools/checkpoint`.
- Удалены мёртвые bench-инструменты: `bench/minimal.ts`, `bench/reasoning-breakdown.ts`,
  `bench/opencode-prompts/`.
- Удалены Harbor и LangGraph: `bench/harbor/`, `langgraph/`, `langgraph.json`,
  `bench/agents_compare.ts`, скрипт `bench:compare`. Текущий runner — `tests/sandbox/**`.
- Удалён `fixtures/synthetic/` (ссылок не было).
- В тестах и комментариях `tests/sandbox/**` заменены упоминания Harbor на benchmark/task cache.

### Проверено

- `npm run typecheck` — чистый.
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **624 passed / 40 skipped**.
- Виртуальная песочница — **10 passed**.
- `tests/coverage.test.ts` — 2/2, все 95 ID сохранены.

### Открыто

- Тяжёлые Docker/live прогоны не запускались: нужен явный go-ahead владельца.
- В `src/ir/islands.ts` и цитатах критериев остаётся слово `acceptance` — это фактический текст
  текущих критериев; отдельно решить, переименовывать ли его.
- `bench/step_compare.ts` оставлен как офлайн-анализ метрик, но не документирован.
- Рабочее дерево не закоммичено; коммит не делался.
- Исторические записи handoff удалены из файла и остаются в git.
