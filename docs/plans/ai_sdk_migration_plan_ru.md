# Переход model layer на Vercel AI SDK (вариант A)

> Английское зеркало — `docs/plans/ai_sdk_migration_plan.md`.
>
> Статус: реализовано; финальный live-батч `fix-ocaml-gc --net on` — 5/5
> (`docs/benches/best_bench_ru.md`). Отдельный A/B streaming on/off остаётся по желанию.
> Объём: **только model layer**. IR, лента, цикл, инструменты и LangGraph остаются.

## 1. Зачем

opencode использует **Vercel AI SDK** (`ai` v6, `@ai-sdk/openai-compatible`, `@ai-sdk/google`,
`@ai-sdk/mistral`; даже его openai-compatible пакет патчится). У нас —
`@langchain/core` + `@langchain/langgraph` + `@langchain/openai`, поверх которых написаны
свой провайдерский адаптер (`src/llm/provider.ts`) и SSE/fetch-транспорт (`src/llm/client.ts`)
под RouterAI: `reasoning`/`reasoning_content`, пустые reasoning-поля, маршрутизация
`tool_choice`, стриминг, ретраи.

Именно этот слой — источник большей части провайдерской боли. AI SDK закрывает те же
вопросы (сообщения, tool calls, стриминг, reasoning-части, provider options) и это тот путь,
который opencode уже гоняет против того же шлюза.

## 2. Объём

**Входит:**

- создание модели и конфигурация провайдера (`src/llm/client.ts`);
- сборка сообщений для провайдера (`src/loop/propose.ts`, `buildMessages`);
- биндинг инструментов и native tool-call round trip (`src/llm/tools.ts`,
  `src/llm/structured.ts`);
- стриминг и извлечение usage/reasoning (`src/llm/client.ts`, `src/llm/structured.ts`);
- маппинг настроек (`SKEIN_STREAMING`, `SKEIN_REASONING_TAPE`, reasoning effort);
- тесты и живой A/B.

**Не входит:**

- удаление LangGraph, IR, `project`, `executeAction`, реализаций инструментов;
- изменение семантики состояний, формата ленты или критериев;
- UI-стриминг/прерывание (отложено);
- другие провайдеры.

## 3. Шов, который уже есть

`Proposer` в `src/loop/propose.ts` — граница:

```ts
type Proposer = (context: Context) => Promise<Proposals>;
```

LangGraph вызывает `propose(context)` и не знает, какой SDK произвёл предложения. Поэтому
переход локализуется, если сохранить контракт `Proposer` и менять только то, что за ним.
`buildMessages` — вторая граница: она превращает нейтральный `TapeMessage[]` в массив
сообщений SDK. Её используют `bench/turn.ts`, `bench/rollout.ts` и тесты.

## 4. Целевая раскладка

### 4.1 Провайдер (`src/llm/client.ts`)

- Вместо `ChatOpenAI` — `createOpenAICompatible` (или `createOpenAI`) из
  `@ai-sdk/openai-compatible`; модель — AI SDK `LanguageModelV2`.
- Сохранить стабильный surface настроек: `SKEIN_API_URL`, `SKEIN_API_KEY`, `SKEIN_MODEL`,
  `SKEIN_MAX_TOKENS`, `SKEIN_TEMPERATURE`, `SKEIN_REASONING_EFFORT`.
- Свой `fetch` оставить только если он нужен шлюзу (заголовки, политика прокси, телеметрия).
  Старый SSE-парсер не тащить: стримом владеет SDK.
- `SKEIN_STREAMING`: `streamText` против `generateText`.

### 4.2 Сообщения (`src/loop/propose.ts`)

- `buildMessages` возвращает AI SDK `ModelMessage[]` (`system` / `user` / `assistant` / `tool`).
- `toMessage` маппит ленту:
  - assistant-текст → assistant-сообщение;
  - assistant tool calls → content parts с `tool-call`;
  - результат инструмента → `tool-result` с тем же `toolCallId`;
  - transition остаётся `user`-ходом (обход prefill не зависит от провайдера).
- `promptText` рендерит те же сообщения для бенчей.

### 4.3 Инструменты и предложения (`src/llm/tools.ts`, `src/llm/structured.ts`)

- zod-схемы остаются единственным источником. Строить AI SDK tools через
  `tool({ description, inputSchema: schema })` из существующих `DEFINITIONS`.
- `toolNamesFor` / per-island surface не меняются.
- `invokeTools` становится `generateText`/`streamText` с `tools`, `stopWhen`/`stepCountIs`
  и выбранной политикой `toolChoice` (`required` по-прежнему **не** форсим).
- Маппить `tool-call` / `tool-result` / `reasoning` / usage обратно в `Proposals`:
  `actions`, `thought`, `reasoning`.
- Сохранить текущий ремонт: текстовый или битый вызов получает один repair; обрыв по
  completion cap маппится из SDK `finishReason`.

### 4.4 Провайдерские особенности (`src/llm/provider.ts`)

- LangChain-адаптер удалить.
- Если RouterAI всё ещё требует переименования `reasoning_content` / эха пустого поля,
  выразить это через AI SDK `providerOptions` или маленький `fetch`-middleware. Сначала
  измерить; не воссоздавать адаптер по умолчанию.
- Известные эффекты маршрутизации (`tool_choice` → thinking-апстримы, кросс-подрядчиковый
  reasoning mismatch) остаются задокументированными и получают один fallback, а не
  промт-костыль.

## 5. Порядок работ

1. **Spike (полдня).** Один скрипт против RouterAI: `generateText` и `streamText` с одним
   инструментом, чтение `reasoning`, `tool-call`, `usage`. Убедиться, что шлюз работает без
   LangChain-адаптера.
2. **Сообщения (полдня).** `buildMessages` → AI SDK messages; сохранить тесты ленты,
   обновить ожидания `tests/wire.ts` / `tests/prompt.test.ts`.
3. **Инструменты (полдня).** `invokeTools` на AI SDK tools; маппинг предложений; сохранить
   schema/tool surface; unit-тесты.
4. **Провайдер (полдня).** `client.ts` на `@ai-sdk/openai-compatible`; настройки; тумблер
   стриминга; удалить мёртвый код адаптера.
5. **Тесты + живой A/B (полдня).** Офлайн-набор; затем те же записанные сиды, K≥3, streaming
   on/off, сравнение действий, reasoning, стоимости, `llm_error`.
6. **Уборка.** Убрать `@langchain/openai` из model path; `@langchain/core` оставить только
   если он ещё нужен LangGraph; обновить доки и статус плана.

Итого: **1–2 дня**, причём основное время — живой A/B, а не код.

## 6. Критерии приёмки

- Typecheck и офлайн-набор проходят; wire/message/tool тесты проверяют формы AI SDK.
- `fix-ocaml-gc` живой, K≥3, те же сиды: нет транспортных `llm_error`; tool calls и reasoning
  на ленте; стоимость не хуже текущего streaming-off плеча.
- `SKEIN_STREAMING=false` и `SKEIN_STREAMING=true` работают.
- `SKEIN_REASONING_TAPE=false` по-прежнему убирает reasoning с ленты.
- Граница `Proposer`/`Proposals` не изменилась; LangGraph, `project`, `executeAction` и
  семантика состояний не тронуты.
- Для компенсации SDK не требуется менять промт.

## 7. Риски

- **Особенности RouterAI остаются.** Патч `@ai-sdk/openai-compatible` в opencode — признак
  того, что шлюз не чистый OpenAI. Fallback для `reasoning_content` сохранить; не считать,
  что SDK сам решит маршрутизацию.
- **API AI SDK v6.** Роли сообщений, tool-call parts, `finishReason`, usage и `stopWhen`
  могут отличаться от LangChain-модели. Зафиксировать версию; маппинг держать в одном файле.
- **Ремонт tool calls.** Наш one-repair/truncation нужно явно перенести; SDK не чинит
  текстовый ответ за нас.
- **Стриминг.** Сборка `streamText` full-stream должна сохранить reasoning, tool calls и
  usage; не сломать поведение против idle-timeout.
- **Тесты.** LangChain-типы сообщений протекают в `tests/wire.ts`, `tests/prompt.test.ts` и
  бенчи; обновить их в том же изменении.

## 8. Откат

Работать в ветке; во время миграции держать старую реализацию `Proposer` за временным
тумблером `SKEIN_PROVIDER=langchain|ai-sdk` (или отдельным модулем, выбираемым в
`client.ts`). Убрать тумблер только после живого A/B. IR и контейнерный харнесс не
затронуты, поэтому откат — revert коммита model layer.

## 9. Вне объёма / позже

- Удаление LangGraph и зависимости `@langchain/core` (вариант B; 3–5 дней).
- UI-стриминг/прерывание.
- Второе семейство провайдеров.
