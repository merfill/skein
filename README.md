# Skein

A coding agent whose context is a **projection of an IR**, not a message tape.
The model proposes; a deterministic executor records and derives; the event journal
and the projection function are the protocol.

## Idea

In an ordinary agent memory is a growing message tape. In Skein memory is a typed IR
(a graph), and what the model sees each turn is a deterministic projection of that graph.
The model does not "remember" — it sees a slice of state.

A **request** opens a task. The task walks a small set of states (`research`, `patch`,
`construction`, `verification`, `end`); each state has its own goal, completion condition
and working prompt, and closes only by the model's text reply, recorded as `stop`. The
projection is non-monotone: closed states fall out of view but stay addressable.

A **session agent** sits above tasks. It interprets the user's utterance, answers
(`respond`), opens a read-only analysis unit (`general`), or opens a coding task
(`task`) with a reformulated request. Task unit journals stay isolated; continuity is
carried by the reformulation and the session trace.

## Install

Requires Node.js >= 22.

```bash
npx skein-swe auth login    # choose a provider, paste a key
npx skein-swe doctor        # one-token check that the key and model work
npx skein-swe               # start the TUI in the current directory
```

Or install globally (`skein` is the binary):

```bash
npm install -g skein-swe
skein auth login
skein doctor
skein --dir ~/project
```

The first run offers local runtimes (Ollama, LM Studio, vLLM) and the providers with a free
tier; `skein auth login` configures a provider explicitly. See `docs/en/providers.md` for the
catalog, config precedence and free options. Keys are yours: there is no hosted gateway.

### Docker

```bash
docker build -t skein .
docker run --rm -it -v "$PWD:/workspace" -e SKEIN_API_KEY=... skein
```

The agent runs inside the container; the image is a minimal Node runtime with `git`, so extend
it with the toolchain your project needs. Pass the provider explicitly when needed:

```bash
docker run --rm -it -v "$PWD:/workspace" \
  -e SKEIN_PROVIDER=openrouter -e SKEIN_MODEL=<model> -e OPENROUTER_API_KEY=<key> \
  skein --dir /workspace
```

Local runtimes (Ollama, LM Studio, vLLM) work the same way with `--base-url`; no model is
bundled or downloaded for you. See `docs/en/providers.md`.

### From a source checkout

```bash
npm install
npm run build
npm run cli -- --dir ~/project
```

## Commands

```bash
npm run typecheck                                  # tsc --noEmit
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'   # offline tests
npm run build                                      # dist/cli.js (npm bin `skein`)
npm run cli -- --dir <project>                     # TUI (source)
skein --dir <project>                              # TUI (built/installed)
skein --dir <project> --plain                      # line REPL
skein auth login                                   # provider setup
skein models                                       # list models
skein doctor                                       # test the connection
```

Live model scenarios and the Docker sandbox are opt-in and cost money/time:
`SKEIN_LIVE=true` for live tests, `tests/sandbox/**` for containers. Do not run the bare
`npx vitest run` if Docker images are present.

## Providers

Skein speaks the OpenAI-compatible protocol. The catalog includes RouterAI, OpenRouter,
OpenAI, DeepSeek, Google AI Studio, Groq, Cerebras, Mistral, GitHub Models, local Ollama,
LM Studio and vLLM, and a `custom` endpoint. Keys are stored separately from the config
(`~/.local/share/skein/auth.json`, mode 0600) or supplied through environment variables.
Precedence: CLI > env > config > preset.

## Settings (`SKEIN_*`, `.env`)

The config file is preferred; environment variables remain for compatibility and CI.

| Variable | Default | Meaning |
|---|---|---|
| `SKEIN_PROVIDER` | — | provider id |
| `SKEIN_API_URL` | `https://routerai.ru/api/v1` | OpenAI-compatible endpoint |
| `SKEIN_API_KEY` | — | key (legacy; `auth.json` is preferred) |
| `SKEIN_MODEL` | `~deepseek/deepseek-v4-flash-latest` | model |
| `SKEIN_TEMPERATURE` | `0.1` | temperature |
| `SKEIN_MAX_TOKENS` | `8192` | reply cap (shares the reasoning budget) |
| `SKEIN_REASONING_EFFORT` | `low` | reasoning effort |
| `SKEIN_MAX_TURNS` | `80` | task turn budget |
| `SKEIN_OBSERVER` | `false` | request observer |
| `SKEIN_LOG` | on | JSONL session log (`.skein/session.log`) |
| `SKEIN_LIVE` | `false` | live gate |

## Code layout

```
src/
  ir/         types, events, fold (append-only), project (projection)
  providers/  presets, config/auth store, resolution, probes, auth login
  llm/        provider client, structured tools, proposers
  loop/       the deterministic loop (plain while)
  session/    session container, session agent, driver, REPL, TUI glue
  tools/      fsWorkspace, executeAction, checkpoint
  tui/        Ink UI
bench/        replay, rollout, live-step and metrics tools
tests/        offline tests; tests/live and tests/sandbox are opt-in
docs/         en/ and ru/ documentation trees (concepts, IR, providers, sessions, testing)
```

## Documents

Start at `docs/README.md`. The core reading:

- `docs/en/concepts.md` — the non-monotone context, the agents and the states.
- `docs/en/ir.md` — the conceptual IR model.
- `docs/en/ir_operations.md` — the operator registry and detailed tool tables.
- `docs/en/projection.md` — what the model sees each turn.
- `docs/en/sessions.md` — sessions, units and the agents of those units.
- `docs/en/providers.md` — providers, auth and free options.
- `docs/ru/handoff.md` — the working handoff log (RU-only).

## License

See `LICENSE`.
