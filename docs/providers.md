# Providers

Skein speaks the OpenAI-compatible protocol. A provider is a base URL plus an optional API key
and a model id. The built-in catalog is static and works offline; no hosted gateway is involved.

From a source checkout, prefix commands with `npm run cli --` (e.g.
`npm run cli -- auth login`).

## Quick start

```sh
skein auth login        # choose a provider, paste a key, pick a model
skein doctor            # one-token check that the key and model work
skein                   # start the TUI
```

Without a config, the first `skein` run offers local runtimes first (Ollama, LM Studio, vLLM) and
then the free-tier providers. Users who prefer files can edit the config directly.

## Catalog

| id | Name | Base URL | Key env | Notes |
|---|---|---|---|---|
| `routerai` | RouterAI | `https://routerai.ru/api/v1` | `ROUTERAI_API_KEY`, `SKEIN_API_KEY` | default |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | free models with `:free` |
| `google` | Google AI Studio | `https://generativelanguage.googleapis.com/v1beta/openai/` | `GEMINI_API_KEY` | free tier |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | free tier |
| `cerebras` | Cerebras | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` | free tier |
| `mistral` | Mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | free tier |
| `github` | GitHub Models | `https://models.github.ai/inference` | `GITHUB_TOKEN` | free tier |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | |
| `openai` | OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` | |
| `ollama` | Ollama | `http://127.0.0.1:11434/v1` | — | local, no key |
| `lmstudio` | LM Studio | `http://127.0.0.1:1234/v1` | — | local, no key |
| `vllm` | vLLM | `http://127.0.0.1:8000/v1` | — | local, no key |
| `custom` | Custom | — | `SKEIN_API_KEY` | set `baseURL` yourself |

All of these use `@ai-sdk/openai-compatible`. Native Anthropic/Google APIs, OAuth, the
`models.dev` catalog and a hosted trial gateway are out of scope for now. Claude and Gemini are
reachable through OpenRouter or RouterAI.

## Files

- Config: `~/.config/skein/config.json` (or `$XDG_CONFIG_HOME/skein/config.json`).
- Keys: `~/.local/share/skein/auth.json` (or `$XDG_DATA_HOME/skein/auth.json`), mode `0600`.
- Tests and containers can override the locations with `SKEIN_CONFIG_DIR` and `SKEIN_DATA_DIR`.

Config holds no secrets:

```json
{
  "version": 1,
  "provider": "openrouter",
  "model": "qwen/qwen3-coder:free"
}
```

Add `baseURL` only when overriding the preset (required for `custom`):

```json
{
  "version": 1,
  "provider": "custom",
  "baseURL": "https://llm.example.com/v1",
  "model": "my-model"
}
```

Keys live in `auth.json`:

```json
{
  "version": 1,
  "providers": {
    "openrouter": { "apiKey": "sk-or-..." }
  }
}
```

## Precedence

CLI > environment > config > preset default.

- `--provider`, `--model`, `--base-url` (this run only).
- `SKEIN_PROVIDER`, `SKEIN_MODEL`, `SKEIN_API_URL`, `SKEIN_API_KEY`, and the provider's own
  key variable (e.g. `OPENROUTER_API_KEY`).
- `config.json` + `auth.json`.
- The preset's base URL and default model.

A legacy `SKEIN_API_URL` without `SKEIN_PROVIDER` is treated as a `custom` provider, so an
existing `.env` keeps working.

## Commands

- `skein auth login [provider]` — provider picker, masked key (on a TTY), model selection from
  `/v1/models`, save.
- `skein auth list` — configured providers and redacted keys.
- `skein auth logout [provider]` — remove a saved key.
- `skein models [provider]` — list the provider's models, `*` marks the current one.
- `skein doctor` — `GET /models` plus a one-token chat; prints a clear error on 401/404/timeout.
- `skein --provider <id> --model <id> --base-url <url>` — override for one run.
- `/model` in the TUI — list models, or `/model <id>` to switch live (applies from the next
  turn and is written to the config).

## Free options

There is no hosted trial. The free path is one of:

1. **Local**: run Ollama, LM Studio or vLLM and pick the detected provider. No key, no cost.
2. **Free tier**: OpenRouter (`:free` models), Google AI Studio, Groq, Cerebras, Mistral or
   GitHub Models. Each needs a free account with its own limits and data policy.

Free tiers change without notice, may be region-restricted, and some train on the submitted
data. Check the provider's terms before using a free model on private code.

## Troubleshooting

| Symptom | Check |
|---|---|
| `authentication failed (401)` | key is wrong or belongs to another provider |
| `endpoint or model not found (404)` | base URL and model id |
| `rate limited (429)` | free-tier quota; retry later or switch model |
| `timed out` | network, proxy or a slow local runtime |
| local provider not offered | start Ollama/LM Studio/vLLM and `skein doctor` |
| model missing in `/model` | the provider's `/v1/models` is incomplete; pass the id manually |
| the agent returns no tool call | the model must support OpenAI tool calling; pick a coding model |

Keys are never written to the config, the session log or the trace; `auth list` prints them
redacted.
