# Skein — документация (русский)

English: [../en/README.md](../en/README.md).

## Что такое Skein

- [concepts.md](concepts.md) — концептуальный обзор: докса/логос, IR, проекция.
- [walkthrough.md](walkthrough.md) — сквозной пример: состояния и динамическая лента в разных
  контекстах исполнения.

## IR (источник истины движка)

- [ir.md](ir.md) — источник истины об IR: модель, семантика, операторы, производные факты,
  реестр покрытия (`OP-MV`, `OP-CG`, `OP-AP`, `TR`, `DER`, `REF`, ...) и карта as-built.
  Гейт покрытия читает этот файл; держите id синхронными с тестами.
- [projection.md](projection.md) — проекция контекста: что модель видит каждый ход и почему.
- [tools.md](tools.md) — контракт инструментов.

## Поверхность модели

- [system_prompt.md](system_prompt.md) — блоки поведения, из которых собирается системный промпт.
- [states.md](states.md) — цели состояний, критерии приёмки и маршруты.

## Сессии и управляемость

- [session_concepts.md](session_concepts.md) — сессии, контейнер unit'ов, агент сессии, его
  инструменты памяти, outline, изоляция задач, RequestObserver и триггеры.

## Провайдеры

- [providers.md](providers.md) — каталог OpenAI-compatible, `auth login`/`models`/`doctor`,
  файлы config/auth, приоритет, бесплатные и локальные варианты.

## Тестирование

- [testing.md](testing.md) — как гонять тесты, бенчи и реальные задачи (песочница, Harbor,
  live-step, `bench/turn.ts`) и куда попадает вывод.
- [state_testing.md](state_testing.md) — тестирование промптов состояний по шагам на живой
  задаче, включая драйвер `bench/live-step.ts`.

## Передача работы

- [handoff.md](handoff.md) — рабочий handoff-лог.
