# Провайдеры

Skein говорит по OpenAI-совместимому протоколу. Провайдер — это base URL, необязательный ключ
и id модели. Встроенный каталог статический и работает офлайн; никакого хостед-шлюза нет.

Из исходников команды запускаются через `npm run cli --` (например
`npm run cli -- auth login`).

## Быстрый старт

```sh
skein auth login        # выбрать провайдера, вставить ключ, выбрать модель
skein doctor            # проверка ключа и модели одним запросом на 1 токен
skein                   # запустить TUI
```

Без конфига первый запуск `skein` сначала предлагает локальные рантаймы (Ollama, LM Studio,
vLLM), затем провайдеров с бесплатным тарифом. Кто предпочитает файлы — правит конфиг вручную.

## Каталог

| id | Имя | Base URL | Переменная ключа | Заметки |
|---|---|---|---|---|
| `routerai` | RouterAI | `https://routerai.ru/api/v1` | `ROUTERAI_API_KEY`, `SKEIN_API_KEY` | по умолчанию |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | бесплатные модели с `:free` |
| `google` | Google AI Studio | `https://generativelanguage.googleapis.com/v1beta/openai/` | `GEMINI_API_KEY` | бесплатный тариф |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | бесплатный тариф |
| `cerebras` | Cerebras | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` | бесплатный тариф |
| `mistral` | Mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | бесплатный тариф |
| `github` | GitHub Models | `https://models.github.ai/inference` | `GITHUB_TOKEN` | бесплатный тариф |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | |
| `openai` | OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` | |
| `ollama` | Ollama | `http://127.0.0.1:11434/v1` | — | локально, без ключа |
| `lmstudio` | LM Studio | `http://127.0.0.1:1234/v1` | — | локально, без ключа |
| `vllm` | vLLM | `http://127.0.0.1:8000/v1` | — | локально, без ключа |
| `custom` | Custom | — | `SKEIN_API_KEY` | `baseURL` задаёт пользователь |

Все они используют `@ai-sdk/openai-compatible`. Нативные Anthropic/Google, OAuth, каталог
`models.dev` и свой trial-шлюз пока вне области. Claude и Gemini доступны через OpenRouter
или RouterAI.

## Файлы

- Конфиг: `~/.config/skein/config.json` (или `$XDG_CONFIG_HOME/skein/config.json`).
- Ключи: `~/.local/share/skein/auth.json` (или `$XDG_DATA_HOME/skein/auth.json`), права `0600`.
- Тесты и контейнеры переопределяют пути через `SKEIN_CONFIG_DIR` и `SKEIN_DATA_DIR`.

В конфиге секретов нет:

```json
{
  "version": 1,
  "provider": "openrouter",
  "model": "qwen/qwen3-coder:free"
}
```

`baseURL` добавляется только при переопределении пресета (обязателен для `custom`):

```json
{
  "version": 1,
  "provider": "custom",
  "baseURL": "https://llm.example.com/v1",
  "model": "my-model"
}
```

Ключи лежат в `auth.json`:

```json
{
  "version": 1,
  "providers": {
    "openrouter": { "apiKey": "sk-or-..." }
  }
}
```

## Приоритет

CLI > окружение > конфиг > дефолт пресета.

- `--provider`, `--model`, `--base-url` (только на этот запуск).
- `SKEIN_PROVIDER`, `SKEIN_MODEL`, `SKEIN_API_URL`, `SKEIN_API_KEY` и собственная переменная
  провайдера (например `OPENROUTER_API_KEY`).
- `config.json` + `auth.json`.
- Base URL и модель по умолчанию из пресета.

Старый `SKEIN_API_URL` без `SKEIN_PROVIDER` трактуется как провайдер `custom`, поэтому
существующий `.env` продолжает работать.

## Команды

- `skein auth login [provider]` — выбор провайдера, скрытый ввод ключа (на TTY), выбор модели
  из `/v1/models`, сохранение.
- `skein auth list` — настроенные провайдеры и ключи в замаскированном виде.
- `skein auth logout [provider]` — удалить сохранённый ключ.
- `skein models [provider]` — список моделей, `*` отмечает текущую.
- `skein doctor` — `GET /models` плюс чат на 1 токен; понятная ошибка на 401/404/timeout.
- `skein --provider <id> --model <id> --base-url <url>` — переопределение на один запуск.
- `/model` в TUI — список моделей или `/model <id>` для переключения на лету (со следующего
  хода, с записью в конфиг).

## Бесплатные варианты

Своего trial-шлюза нет. Бесплатный путь один из двух:

1. **Локально**: запустить Ollama, LM Studio или vLLM и выбрать найденный провайдер. Без ключа
   и без денег.
2. **Бесплатный тариф**: OpenRouter (`:free`), Google AI Studio, Groq, Cerebras, Mistral или
   GitHub Models. Нужен бесплатный аккаунт со своими лимитами и политикой данных.

Бесплатные тарифы меняются, могут быть ограничены по региону, а некоторые обучаются на
отправленных данных. Перед использованием бесплатной модели на приватном коде проверьте
условия провайдера.

## Диагностика

| Симптом | Что проверить |
|---|---|
| `authentication failed (401)` | ключ неверный или от другого провайдера |
| `endpoint or model not found (404)` | base URL и id модели |
| `rate limited (429)` | квота бесплатного тарифа; позже или другая модель |
| `timed out` | сеть, прокси или медленный локальный рантайм |
| локальный провайдер не предложен | запустить Ollama/LM Studio/vLLM и `skein doctor` |
| модели нет в `/model` | `/v1/models` провайдера неполон; передайте id вручную |
| агент не вызывает инструменты | модель должна поддерживать OpenAI tool calling; выберите coding-модель |

Ключи не попадают в конфиг, session log или trace; `auth list` печатает их замаскированными.
