# Skein

**A coding agent whose context is a projection of its IR, not a message tape.**

In an ordinary agent, memory is a growing transcript. In Skein, every action is recorded in a
monotone typed journal, and what the model sees each turn is a deterministic projection of that
journal. The model proposes; a deterministic executor records and derives. The journal and the
projection function are the protocol.

> **Status: v0.1, source release.** The comparative evaluation is complete. The npm package and
> Docker image are not published yet — install from a checkout as shown below. A technical report
> and an OpenReview submission are planned.

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Usage](#usage)
- [Research artifact](#research-artifact)
- [Limitations](#limitations)
- [Design invariants](#design-invariants)
- [Project layout](#project-layout)
- [Documentation](#documentation)
- [Citation](#citation)
- [License](#license)

## Why

A long-running agent accumulates a transcript: every tool result stays in the prompt, the prompt
grows without bound, and the task's original goal drifts behind the history. Truncation removes
facts the agent may need; compaction rewrites them.

Skein keeps the history as data. It records events in a typed IR and rebuilds the prompt from
that IR on every turn. The view is **non-monotone** — content can leave the screen as the focus
moves — while the journal stays complete and addressable through `recall` and `search`.

## How it works

```
user utterance
   -> session agent -> operation: respond | general | revision | write_document | task | plan
   -> unit: append-only event journal (typed IR)
                    |
                    v
            project(journal) -> Context -> model -> proposed action
                    ^                                  |
                    +----------- executor records -----+
```

- **Journal** — an append-only record of events and nodes. Nodes are never rewritten.
- **Projection** — `project()` deterministically rebuilds the model's `Context` from the journal.
  Same events give the same context; the view can shrink without deleting anything.
- **State** — a stage of work with an explicit goal (`what`), completion condition (`Done when`)
  and tool surface. A task walks `Research`, `Patch`, `Construction`, `Verification`, `End`.
- **Unit** — one IR with its own root and journal: a task, a plan, a document, a revision or a
  read-only investigation.
- **Session** — an ordered container of units. A session agent interprets each user utterance,
  answers it, or opens a unit with a self-contained work order.

A state closes when the model replies with text; the executor records that reply as `stop`. There
is no separate acceptance gate. What a state may show and which transitions it may take are
rendered per turn from the projection.

The session agent has six operations:

| Operation | What it does |
|---|---|
| `respond` | answer from the dialogue and earlier work |
| `general` | read-only investigation; no workspace changes |
| `revision` | perform a mutable operation the request already describes (edits and commands) |
| `task` | open a coding task with a reformulated request |
| `plan` | develop a read-only, ordered plan of work items |
| `write_document` | write one large Markdown document section by section |

## Quickstart

Requires **Node.js >= 22** and **bash**.

```bash
git clone https://github.com/merfill/skein.git
cd skein
npm install
npm run build
npm pack
npm install -g ./skein-swe-*.tgz

skein auth login       # choose a provider, paste a key, pick a model
skein doctor           # one-token check that the key and model work
skein --dir ~/project  # start the TUI in that workspace
```

After the first npm release, the shorter path will be `npm install -g skein-swe` or
`npx skein-swe`.

### Configure without the wizard

Skein speaks the OpenAI-compatible protocol. You can configure it with environment variables
instead of `auth login`:

```bash
export SKEIN_PROVIDER=openrouter
export SKEIN_MODEL=<model>
export OPENROUTER_API_KEY=<key>
skein doctor
```

Precedence: CLI flags > environment > config > preset default. Keys saved by `auth login` live in
`~/.local/share/skein/auth.json` (mode 0600), separate from the config. The catalog includes
RouterAI, OpenRouter, OpenAI, DeepSeek, Google AI Studio, Groq, Cerebras, Mistral, GitHub Models,
local Ollama, LM Studio and vLLM, and a `custom` endpoint. Keys are yours: there is no hosted
gateway.

### Windows

The agent's shell tool runs `/bin/bash`, so Node must run where bash is available:

- **WSL2 (recommended):** install Ubuntu and follow the Linux steps inside it; keep projects in
  the WSL filesystem (`~/project`, not `/mnt/c`).
- **Git Bash / MSYS2:** works when `/bin/bash` is reachable from the shell that launches `skein`.
- **Docker Desktop:** run the Linux image below.

Native PowerShell or cmd without bash is not supported.

### Docker

```bash
git clone https://github.com/merfill/skein.git
cd skein
docker build -t skein:0.1.0 .
docker run --rm -it \
  -v "$HOME/project:/workspace" \
  -e SKEIN_API_KEY=... \
  -e SKEIN_MODEL=... \
  skein:0.1.0
```

The agent runs inside the container; the image is a minimal Node runtime with `git`, so extend it
with the toolchain your project needs. Pass the provider explicitly when needed, for example
`-e SKEIN_PROVIDER=openrouter -e OPENROUTER_API_KEY=...`. No model is bundled or downloaded.

## Usage

The TUI accepts ordinary requests; the session agent routes each one:

| You ask | Operation |
|---|---|
| a question about the code | `general` |
| fix a defect or write code | `task` |
| run tests, commit, or update a lockfile | `revision` |
| write a long Markdown document | `write_document` |
| plan a multi-step change | `plan` |

Use `skein --plain` for a line REPL instead of the TUI. `skein models` lists the provider's
models, and `skein doctor` checks the current configuration.

## Research artifact

Skein is a reproducible research artifact, not a benchmark claim. The comparative evaluation
against opencode uses ported terminal-bench tasks with the same provider and model, repeated
across runs and with network on and off. The summaries are committed to the repository:

- `bench/results/campaign-k5/` — summary, token/cost comparison and per-state cost.

The raw cells and manifests (`bench/runs/matrix/campaign-k5/`) are not tracked in git; they are
archived with the release. A technical report and an OpenReview submission are planned; links and
a DOI will be added here when they are available.

## Limitations

- The engine does not machine-check a state's `Done when` or a plan item's result. Closure is the
  model's text reply, so a premature stop is possible.
- The evaluation uses one provider and model. Results are not a state-of-the-art claim.
- Session units re-read the workspace. Context isolation reduces drift but trades it for repeated
  work, which costs tokens and time.
- The shell tool requires `/bin/bash`; on Windows this means WSL2, Git Bash/MSYS2 or Docker.

## Design invariants

- The journal is monotone: events are appended, nodes are never rewritten.
- `project` is deterministic: same events give the same context.
- The view is non-monotone: closed units stay in the journal but leave the projection.
- The model proposes; the executor records. Refusals and tool failures are the only facts the
  engine adds.
- A state is closed only by the model's text reply, recorded as `stop`.
- Secrets live only in `auth.json` (0600) or environment variables, never in the prompt or logs.

## Project layout

```
src/
  ir/         types, events, fold (append-only), project (projection)
  providers/  presets, config/auth store, resolution, probes, auth login
  llm/        provider client, structured tools, proposers
  loop/       the deterministic loop
  session/    session container, session agent, driver, REPL, TUI glue
  tools/      fsWorkspace, executeAction, checkpoint
  tui/        Ink UI
bench/        replay, rollout, live-step and metrics tools
tests/        offline tests; tests/live and tests/sandbox are opt-in
docs/         en/ and ru/ documentation trees
site/         static project page
```

## Documentation

Start at `docs/README.md`. The core reading:

- `docs/en/concepts.md` — the non-monotone context, the agents and the states.
- `docs/en/ir.md` — the conceptual IR model.
- `docs/en/ir_operations.md` — the operator registry and detailed tool tables.
- `docs/en/projection.md` — what the model sees each turn.
- `docs/en/sessions.md` — sessions, units and the agents of those units.
- `docs/en/providers.md` — providers, auth and free options.
- `docs/ru/handoff.md` — the working handoff log (RU-only).

## Citation

```bibtex
@software{skein,
  title  = {Skein: a coding agent whose context is a projection of its IR},
  author = {Skein contributors},
  year   = {2026},
  url    = {https://github.com/merfill/skein},
  note   = {OpenReview and DOI links will be added after the release}
}
```

## License

MIT. See `LICENSE`.
