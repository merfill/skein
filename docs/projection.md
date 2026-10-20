# Skein — the context projection: the message tape

> Russian mirror — `docs/projection_ru.md`.

> **Folded from the revision.** The projection is a message tape rebuilt from the tree every
> turn; the old `path`/`lastResult`/`shown`/`calls`/`budget` blocks are gone (the tape is the
> whole context; `Context.applicable` is kept only to bind the offered tool surface, §2).
> Source of truth — `docs/ir_semantics.md` §7; as-built — `docs/ir.md`; the operator
> registry — `docs/ir_operations.md`.

## 1. Purpose

The context is what the model sees on the next step: **all its memory**. It looks like an
ordinary tape of messages (as in a ReAct agent) but is **rebuilt from the tree every turn** —
a projection, not an accumulating transcript. The same events always give the same tape.

## 2. Roles and the moves

- `system` — the base prompt, the constraints, each state's `instruction` (shown once at entry),
  the **current** state's fact block (`Workspace` in Orientation/Patch, `Orientation result` in
  Localization/Research, `Probe` elsewhere), and the current situation's instruction (appended
  last, temporary); closed states carry no block;
- `user` — the request (leads the tape, every turn) and each state's goal;
- `assistant` — the state markers and the doxa's calls;
- `tool` — command results.

| Turn | Messages |
|---|---|
| `move` | a **state is a decision, not a tool call**: an `assistant` marker `Start state <label>`, the state's `instruction` as a `system` turn, the current state's fact block as a `system` turn (`Workspace`/`Orientation result`/`Probe`), then the state's goal as a `user` turn (`what: <the island's goal>`). The request leads the tape as the second message (right after the base prompt), on **every** turn — never dropped |
| `apply` | `assistant` (the call) + `tool` (the observation); the first `apply` after a `move` seeds the state's plan and its first item |
| `stop` | the state's closure, rendered as an `assistant` marker `Finish state <label> — <why>`; it adds no tool call. At the terminal state the request ends |
| `decline` | `assistant` (the reason `why`): the request is declined |

Every plan item is a pair `assistant` + `tool`; the first `apply` after a `move` seeds the
state's plan. A command that ran and mutated a file (an edit) has no observation, so its `tool`
message reads `mutated <path>`. A state is the triple `Start state <label>` / goal / `Finish
state <label>` and, while open, its plan. The `Finish state` marker carries **only** the label
and the `stop` reason — never the list of changed files: a state that runs a build mutates
thousands of artifacts.

## 3. The tape is built by walking the tree

- the request is the first `user` turn (right after the base prompt), on every turn;
- the **probe** is one session `fact` (`add_node kind:"fact"`, `id: fact:session`) carrying
  `{ environment, material }`, recorded at request start. It is not a separate message after the
  request; the projection emits the block as a `system` turn before the **current** state's goal
  `user` turn. Orientation gets `Workspace` — the workspace map (`root`, repo, entries/paths);
  Localization and Research get the same map as `Orientation result` (Research also gets `Probe`
  with interpreters/tools); Patch gets it as `Workspace`; Recovery/Construction/Verification get
  `Probe` (environment) under its own heading. Closed states carry no block; the request turn has none;
- the workspace map is deterministic: `root`, repo status, top-level entries (full paths for
  small materials), file count. Environment, extensions, configs, build commands and build state
  are **not** shown in Orientation; a declared command is never presented as the acceptance;
- its states (`move` children) render in order: an **open** state (and the current closed one
  awaiting the transition) renders its `Start state` marker, its `instruction` (`system`) and its
  goal (`user`) after the block, then its plan items; a state **left behind** collapses to
  `Start state <label>` / `instruction` / goal / `Finish state <label> — <why>` without the
  block. No plan turns and no separate `stop` message remain;
- the doxa's `move.what`/`move.notes` are **not** shown: a state's goal comes from its island
  definition (`Island.what`), and the request's presumptions are not carried as `notes`;
- **the tape is not monotone.** When a state is left behind, its `apply` turns leave the tape;
  only its triple remains. Only the view goes, not the data: the tree stays complete;
- **the doxa's reasoning is not stored**: raw `thought` is not in the tree and does not enter
  the tape; its meaning lives in the `why` fields.

## 4. Markers and addresses

- an alternative command carries `alternative to step "…" (previous attempt: "…" — reason)`,
  so the model sees what already failed;
- each `assistant`/`tool` message is prefixed with the node id (`[id] …`), so any result can
  be addressed by id with `recall`/`search`.

## 5. Working with data

A result body is bounded by the tool itself, with a **per-tool** budget (`read` window 8K;
`grep`/`list`/`run` 8K; `recall` 64K); the `tool` message shows the tool's window whole and never cuts its
middle. An inspection result (`read`/`grep`/`list`) is consumed from the beginning, so its head
is kept; a command's output matters at its end, so `run` keeps its tail. Only a body still
exceeding its tool's budget is bounded (with an omission note). The full body is stored as a file and the node keeps a reference. Access is by
identifier, not by path:

- read a fragment — `recall { id, start, end }`;
- search the body — `search { id, pattern }`.

A `recall`/`search` leaves a node (an `action` + its `observation` under the state's plan), so
the fetched window stays on the state's tape like any step and elides with the state on `stop`.
A refused structural move creates no node: its reason arrives as a transient `tool` message
(`rejected <move>: <reason>`) on the next turn.

## 6. The system part

The system part is assembled per situation, not as a monolith:

- the **base prompt** holds only what is true on any turn — the role, the contract, and the state
  set with its transitions. It is stable, so it is a good cache prefix. The
  tool names/parameters/descriptions are **not** here: they ship in the request's `tools` field;
- the **tool surface** offered in that field is bound from `Context.applicable`: on a
  `request`/`transition` only `move` is offered, while a state is open the apply tools and `stop`
  are offered (`recall`/`search` always), so a move the engine would refuse cannot be called at all;
- the **situation instruction** is appended last each turn (temporary, never stored):
  `request` (choose the first state, or `decline`; `what`/`done` — **from the request**), `plan`
  (the state's first step), `working` (`turnInstruction`: the criterion named explicitly — "This
  state's done criterion: "<criterion>". When it holds, `stop` — and nothing else; do not over-work
  the state"), `transition` (`transitionInstruction(island)`: the source of `what`/`done` is the
  `Finish state <label>` line of the just-finished state; the `next` neighbours are listed; choose
  the next state or Finish), `terminal` (call `stop` to end);
- the **constraints** are added as separate `system` messages.

The exact base/situation boundary is the subject of the following stage (the composite system
prompt).

## 7. Determinism

`project` is pure: the same events give the same tape. The only transient input is a refused
structural move's reason (§5); because it is derived from the same move, the projection stays
deterministic.
