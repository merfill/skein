# Skein — прогон тестов и бенчей

> Английское зеркало — `docs/testing.md`.

Единая точка, чтобы не искать команды и места вывода по репозиторию. Относится к
`package.json` (скрипты), `bench/` (синтетический бенч и гейт),
`bench/harbor/` (реальные задачи) и `langgraph/graph.ts` (инструментовка).

## 1. Слои проверки

| Слой | Команда | Что проверяет | Стоимость |
| --- | --- | --- | --- |
| Типы | `npm run typecheck` | `tsc --noEmit` | секунды |
| Офлайн-тесты | `SKEIN_LIVE=false npx vitest run` | инварианты IR, проекция, цикл, проверка допустимости | секунды |
| Live-гейт | `SKEIN_LIVE=true npx vitest run tests/gate.test.ts` | починка багфиксов живой моделью | минуты, деньги |
| Синтетический бенч | `npm run bench -- <case>` | один кейс из `skein-plugin` | минуты, деньги |
| Гейт бенча | `npm run bench:gate -- <runDir>` | прогон против `bench/baseline.json` | секунды |
| Harbor | `bash bench/harbor/run.sh` | реальные задачи terminal-bench | долго, деньги |

**По умолчанию — офлайн.** Live-гейт и бенчи запускаются осознанно.

## 2. Офлайн-тесты

`.env` (gitignored) содержит `SKEIN_LIVE=true`, а `loadSettings` читает его через
`dotenv/config`. Поэтому `npm test` без override включит дорогой live-гейт. Для
обычной проверки:

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run
```

`SKEIN_LIVE=false` задаётся в окружении процесса, и `dotenv` не перезаписывает
уже выставленную переменную. Live-тесты помечены `describe.skipIf(!settings.live)`
(`tests/gate.test.ts`), инварианты — в `tests/invariants.ts`.

## 3. Live-гейт

```sh
SKEIN_LIVE=true npx vitest run tests/gate.test.ts
```

Прогоняет живую модель по фикстурам `fixtures/bugfix/*`: агент должен починить
падающий тест, не редактируя тесты. Таймаут — 300 c на фикстуру. Нужен ключ
(см. §9).

## 4. Синтетический бенч

```sh
npm run bench -- <case> [--model provider/model] [--max-turns N] [--compare]
```

Кейсы и метрика поведения берутся из соседнего репозитория
(`../skein-plugin/pilot/synthetic`, переопределяется `SKEIN_PLUGIN_ROOT`). Прогон
копирует `repo` кейса в свежий workdir, крутит агента, затем `check.sh`.

Результат — `bench/runs/<ts>-<case>-skein>/`:

| Файл | Содержимое |
| --- | --- |
| `trajectory.json` | предложенные действия по ходам |
| `turns.ndjson` | на ход: токены/кэш/`contextChars`/время |
| `contexts.ndjson` | **полная проекция** на ход (`turn`, `chars`, `context`) |
| `events.ndjson` | журнал IR: узлы, рёбра, `record_check`, `record_rejection` |
| `metrics.json` | сводка: reward, context `first/last/peak/growth`, граф, циклы |
| `reward.txt`, `check.out.txt`, `summary.txt` | вердикт и вывод `check.sh` |

## 5. Гейт против базовой линии

```sh
npm run bench:gate -- bench/runs/<ts>-<case>-skein
```

Сравнивает `metrics.json` с `bench/baseline.json` и печатает `PASS`/`FAIL` с
дельтами по метрикам (токены, контекст, циклы). Ненулевой код возврата — провал.

## 6. Harbor (реальные задачи)

```sh
bash bench/harbor/run.sh
```

`run.sh` рендерит `bench/harbor/skein.yaml` из `skein.template.yaml` (абсолютный
путь проекта), подставляет ключ и запускает `harbor run`. Ключ берётся из
`ROUTERAI_API_KEY` → `OPENAI_API_KEY` → `SKEIN_API_KEY` → `~/.config/opencode/opencode.json`.

Результаты — вне репозитория: `~/.skein-bench/harbor/<ts>/`. На триал:
`<task>__<id>/agent/langgraph-run.log` (строки `SKEIN_*`, §7),
`<task>__<id>/verifier/reward.txt`.

**Точечный прогон** (одна задача, одна попытка) — чтобы не платить за весь набор:
скопировать `bench/harbor/skein.yaml`, оставить в `datasets[0].task_names` одну
задачу, выставить `n_attempts: 1`, затем

```sh
OPENAI_API_KEY=... harbor run --config <focused>.yaml -y
```

## 7. Инструментовка: где смотреть

В `langgraph-run.log` по ходу пишутся строки (каждая — один JSON):

| Строка | Содержимое |
| --- | --- |
| `SKEIN_CONTEXT` | **полная проекция** на ход: `{turn, chars, context}` |
| `SKEIN_PROPOSAL` | предложенное действие (в т.ч. текст команд) |
| `SKEIN_TURN` | на ход: токены/кэш/`contextChars`/время |
| `SKEIN_LLM_ERROR` | ошибка вызова модели (с номером попытки) |
| `SKEIN_EVENTS` | диагностика IR: цели, планы, альтернативы, `checks`, `observations`, `mutates`, отказы |
| `SKEIN_METRICS` | сводка: токены, `context` `first/last/peak/growth`, граф |

`contextChars` считается из того же `renderContext(context)`, что уходит в
`buildMessages`, поэтому размер в логе совпадает с отправленным контекстом.
Исполненные команды видны в `SKEIN_PROPOSAL` (предложенные) и в
`SKEIN_EVENTS.checks`/`.observations`/`.actions` (фактические, включая команду из
`done_when`). Локальный бенч кладёт то же в `bench/runs/<...>/` (§4).

## 8. Лимиты инструментов и проекции

Общего бюджета контекста нет: инструмент честно возвращает результат в объявленных
лимитах, а проекция его не режет (`docs/tools_ru.md`).

| Предел | Значение | Смысл |
| --- | --- | --- |
| `MAX_READ_LINES` | 400 | окно `read` за вызов; инструмент говорит «строки X–Y из Z» |
| `MAX_GREP_MATCHES` | 200 | совпадений `grep` за вызов |
| `MAX_RUN_OUTPUT` | 8000 | вывод `run`; дальше head+tail и `outputRef` |
| `SKEIN_CTX_ITEMS` | 20 | элементов в `plan`/`alternatives` проекции |

## 9. Ключи и секреты

Ключ живёт только в `.env` (gitignored) или в `~/.config/opencode/opencode.json`.
В репозиторий и в логи ключ не пишется. `run.sh` пробрасывает его в контейнер как
`OPENAI_API_KEY`.

## 10. Принципы

- **Офлайн по умолчанию.** `SKEIN_LIVE=false` для обычной проверки; live и
  Harbor — только намеренно.
- **Перед дорогим прогоном — сохранить, что измеряем.** Полная проекция и
  исполненные команды должны попасть в лог/файлы (§4, §7), иначе разбор
  невозможен.
- **Один кейс, одна попытка** для итераций по движку; полный набор — для приёмки.
- **Сравнивать с сохранённым прогоном**, а не с памятью: `context first/last/peak`
  и `reward` из `metrics.json` / `SKEIN_METRICS`.
- **Минимальный диф.** Правка харнесса не меняет семантику движка; инварианты —
  в `tests/invariants.ts`.