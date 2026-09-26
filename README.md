# Skein

Агент кодирования, у которого контекст — **проекция IR**, а не лента сообщений.
LLM (докса) только предлагает; детерминированный движок и свидетель (логос)
решают; журнал событий и функция проекции — протокол. Концептуальное основание —
разделение доксы и логоса (`ankyra/docs/doxa_and_logos.tex`).

## Идея

В обычном агенте память — это растущая лента сообщений. В Skein память — это
типизированный IR (граф), а то, что видит модель, — детерминированная функция
проекции этого графа. Модель не «помнит» — она видит срез состояния.

- **Докса (LLM)** входит в IR только как предложение: `provenance.kind = "llm"`,
  `status = "open"`. Никогда сразу `verified`.
- **Логос** — вердикты свидетелей (`check`) и замыкание artifact-графа.
- **Протокол** — append-only журнал событий, `fold`, `project`, переходы статусов.

## Как это работает

IR — гибридный граф из двух пространств имён в одном:

- `work` — цель, гипотезы/claims, решения, действия, наблюдения, ограничения;
- `artifact` — файлы, символы, тесты.

Журнал событий append-only; состояние — `fold(events)`; проекция — чистая функция
`project(state)`. Немонотонность кода решена **staleness по версии**: artifact-факт
хранит хэш файла на момент чтения; мутация переводит факты старой версии в `stale`
детерминированно, без ручного отката.

Цикл (LangGraph.js):

```
START → project → propose → classify → execute → route
route ──continue──▶ project
route ──done | budget──▶ END
```

- `project` — чистая функция из состояния; без LLM;
- `propose` — один структурированный ответ `{ thought, action }` (zod);
- `classify` — детерминированная проверка (например, constraint запрещает правку);
- `execute` — детерминированно выполняет действие и пишет события.

Действия: `read`, `grep`, `edit` (→ `mutate`), `run` (→ `check`/`record_check`),
`track` (предложить claim/decision/constraint), `query`, `finish`.

## Структура кода

```
src/
  ir/         типы, zod-события, fold (append-only), project (проекция)
  config/     настройки SKEIN_* (dotenv)
  llm/        клиент провайдера + zod-схемы предложений
  tools/      fsWorkspace и executeAction
  loop/       LangGraph: state, propose, classify, graph, runAgent
fixtures/bugfix/<id>/   мини-задачи с падающим тестом (node --test)
tests/        golden-тесты IR, offline-прогон, live-гейт
docs/         концепция, общий план, спек Tier 0
```

## Установка

Требуется Node.js >= 22.

```bash
npm install
cp .env.example .env   # заполнить SKEIN_API_KEY
```

## Команды

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest: offline + live-гейт (при SKEIN_LIVE=true)
npm run test:watch
```

Live-прогон агента на фикстурах включается `SKEIN_LIVE=true` (нужен
`SKEIN_API_KEY`).

## Настройки (`SKEIN_*`, `.env`)

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `SKEIN_API_URL` | `https://routerai.ru/api/v1` | OpenAI-совместимый endpoint |
| `SKEIN_API_KEY` | — | ключ (только в `.env`) |
| `SKEIN_MODEL` | `~deepseek/deepseek-v4-flash-latest` | модель |
| `SKEIN_TEMPERATURE` | `0.1` | температура |
| `SKEIN_MAX_TOKENS` | `4096` | лимит ответа |
| `SKEIN_REASONING_EFFORT` | `none` | размышления выключены |
| `SKEIN_MAX_TURNS` | `24` | бюджет ходов |
| `SKEIN_LIVE` | `false` | live-гейт |

Размышления выключены обязательно (как в Ankyra): `thinking.type=disabled` и
`reasoning.effort=none`.

## Гейт и инварианты

Фикстуры `fixtures/bugfix/*` — мини-пакеты с падающим тестом; цель — сделать тест
зелёным, не редактируя тесты. Свидетель объективен: test runner.

Инварианты:

- claim не становится `verified` без `check`-provenance;
- `stale`-факт не показывается как активное содержимое;
- `project` детерминирован: одни события → один `Context`;
- constraint не нарушается; цель закрывается только при прохождении свидетеля.

## Статус и документы

Реализован Tier 0 (багфикс по падающему тесту).

- `docs/implementation_plan_ru.md` — общий план, решения, роадмап, статус.
- `docs/tier0_plan_ru.md` — детальный спек Tier 0.
- `docs/concepts_ru.md` — концептуальный набросок.

## Лицензия

См. `LICENSE`.
