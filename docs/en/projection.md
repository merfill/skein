# Skein — the context projection: the message tape

> Russian mirror — `docs/ru/projection.md`.

> **Folded from the revision.** The projection is a message tape rebuilt from the tree every
> turn; the old `path`/`lastResult`/`shown`/`calls`/`budget` blocks are gone (the tape is the
> whole context; `Context.applicable` is kept only to bind the offered tool surface, §2).
> Source of truth — `docs/en/ir.md` §7; as-built — `docs/en/ir.md`; the operator
> registry — `docs/en/ir.md`.

## 1. Purpose

The context is what the model sees on the next step: **all its memory**. It looks like an
ordinary tape of messages (as in a ReAct agent) but is **rebuilt from the tree every turn** —
a projection, not an accumulating transcript. The same events always give the same tape.

## 2. Roles and the moves

- `system` — the base prompt, the constraints, the **current** state's fact block (coordinates
  plus its environment subset), and the current situation's instruction (appended last,
  temporary); a closed state carries no fact block;
- `user` — the request (leads the tape, every turn) and the per-turn working prompt after an
  open state's turns;
- `assistant` — the state markers and the doxa's calls;
- `tool` — command results.

| Turn | Messages |
|---|---|
| `move` | a **state is a decision, not a tool call**: a `system` marker `Start state <label>`, the focused fact block as a `system` turn, then — while the state is open — its turns. The goal, criterion and plan are appended by `buildMessages` as one `user` working prompt after the turns (`Goal: <island.what>`, the doxa's guess when set, `Done when`, `Plan`, request reference). The request leads the tape as the second message (right after the base prompt), on **every** turn — never dropped |
| `apply` | `assistant` (the call) + `tool` (the observation); the first `apply` after a `move` seeds the state's turns and its first action |
| `stop` | the state's closure, rendered as a `system` marker `Finish state <label> — <why>`; it adds no tool call. At the terminal state the request ends |
| `decline` | `assistant` (the reason `why`): the request is declined |

Every turn is a pair `assistant` + `tool`; the first `apply` after a `move` seeds the
state's turns. A command that ran and mutated a file (an edit) has no observation, so its `tool`
message reads `mutated <path>`. An open state is `Start state <label>` / brief / turns, with one
`user` working prompt appended after the turns; a closed one is only `Start state <label>` /
`Finish state <label>`. The
`Finish state` marker carries **only** the label
and the `stop` reason — never the list of changed files: a state that runs a build mutates
thousands of artifacts.

## 3. The tape is built by walking the tree

- the request is the first `user` turn (right after the base prompt), on every turn;
- the **probe** is one session `fact` (`add_node kind:"fact"`, `id: fact:session`) carrying
  `{ environment, material }`, recorded at request start. It is not a separate message after the
  request; the projection emits the block as a `system` turn in the **current** state's entry.
  The block comes from the state's own brief (`src/ir/briefs.ts`): every working state gets the
  coordinates (the workspace root, the repository status, the working directory when the shell
  starts outside the root) plus the environment subset its island needs; End gets nothing. The environment
  is a short list of facts (`Network is available`, interpreters, package managers, build/test
  tools, version-control tools), not an inventory of stock utilities. Closed states carry no
  block; the request turn has none;
- the coordinates are deterministic and are not a listing: no top-level entries, no paths, no
  file count. A state that needs the files lists them. Environment, extensions, configs, build
  commands and build state are **not** shown; a declared command is never
  presented as the acceptance;
- its states (`move` children) render in order: an **open** state (the current one) renders its
  `Start state` marker, brief and turns; a state **left behind** or stopped collapses to
  `Start state <label>` / `Finish state <label> — <why>`. No brief, turn messages or separate
  `stop` message remain;
- `buildMessages` appends one `user` working prompt after an open state's turns: the state's
  `Goal`, the doxa's unverified guess (`Your earlier guess (may be wrong): …`) when set,
  `Done when`, `Plan`, and the original request marked as reference; the request's presumptions
  are not carried into the state as facts;
- **the tape is not monotone.** When a state is left behind, its `apply` turns leave the tape;
  only its triple remains. Only the view goes, not the data: the tree stays complete;
- **the doxa's reasoning is not stored**: raw `thought` is not in the tree and does not enter
  the tape; its meaning lives in the `why` fields.

## 4. Markers and addresses

  so the model sees what already failed;
- each `assistant`/`tool` message is prefixed with the node id (`[id] …`), so any result can
  be addressed by id with `recall`/`search`.

## 5. Working with data

A result body is bounded by the tool itself, with a **per-tool** budget (`read` window 32K;
`grep`/`list`/`run` 8K; `recall` 64K); the `tool` message shows the tool's window whole and never cuts its
middle. An inspection result (`read`/`grep`/`list`) is consumed from the beginning, so its head
is kept; a command's output matters at its end, so `run` keeps its tail. Only a body still
exceeding its tool's budget is bounded (with an omission note). The full body is stored as a file and the node keeps a reference. Access is by
identifier, not by path:

- read a fragment — `recall { id, start, end }`;
- search the body — `search { id, pattern }`.

A `recall`/`search` leaves a node (an `action` + its `observation` among the state's turns), so
the fetched window stays on the state's tape like any step and elides with the state on `stop`.
A refused structural move creates no node: its reason arrives as a transient `tool` message
(`rejected <move>: <reason>`) on the next turn.

## 6. The system part

The system part is assembled per situation, not as a monolith:

- the **base prompt** holds only what is true on any turn — the role and the contract. It is
  stable, so it is a good cache prefix. The state map and transitions are scoped to the
  request/transition situation prompts. The
  tool names/parameters/descriptions are **not** here: they ship in the request's `tools` field;
- the **tool surface** offered in that field is bound from `Context.applicable`: on a
  `request`/`transition` only `move` is offered, while a state is open the apply tools are
  offered (`recall`/`search` always); `stop` is engine-owned (the doxa closes a state with text);
- the **situation prompt** is appended last for `request`, `transition`, `terminal` and the open
  state (`working`), always temporary, never stored. `working` appends one `user` turn with the
  state's `Goal`, guess, `Done when`, `Plan` and request reference. `request` (choose the first
  state, or `decline`; `what`/`done` — **from the
  request**), `transition` (`transitionInstruction(island)`: the source of `what`/`done` is the
  `Finish state <label>` line of the just-finished state; the `next` neighbours are listed; choose
  the next state or End), `terminal` ("This is End." + the text completion rule);
- the **constraints** are added as separate `system` messages.

The exact base/situation boundary is the subject of the following stage (the composite system
prompt).

## 7. Determinism

`project` is pure: the same events give the same tape. The only transient input is a refused
structural move's reason (§5); because it is derived from the same move, the projection stays
deterministic.

## 8. The cost of the projection

A focus change rewrites the tape, so the projection is not free. The cost splits into three
parts, and only the first two are structural:

- **prefix cache-miss.** The base prompt is a stable prefix, but a move changes the tape from
  the focus point on, so the tail is prefilled again. This is latency and money, not extra
  output;
- **one turn per transition.** Entering a state is a turn (a model call); a walk with more
  states costs more turns than a single pass. This is the price of explicit decision points and
  of the projection dropping stale content instead of carrying it;
- **re-framing reasoning.** The model has to reconcile "what was → why here → what to do".
  This one is **not** inevitable: it is a property of the state's spec, not of transitions as
  such. A crisp `Goal`, brief, instruction, criterion and a `Finish state` line cost little; a
  thin state (a spec-only Construction after `O→C`) invites the model to go exploring. Measure
  it as reasoning on the first turn after a transition against the second; a persistently
  expensive first turn is a state-definition bug, not provider noise.

Two consequences:

- the first two costs are accepted deliberately: they buy a deterministic projection and
  addressable closed states. A plain transcript pays elsewhere — with growing context and
  stale content;
- price the **result** (rubles per solved task, turns per task), not the transition: one extra
  short turn can be cheaper than one long, lost turn inside the old tape.

Provider noise is separate. Behind the meta-provider, different subcontractors may return a
move with no reasoning at all; the same input then yields a different route. This is a
statistical fluctuation, not something the prompt or effort can fix; the route metric is read
on the samples that do reason. The completion-cap retry is not a counterexample: it does not
reuse a cached "train of thought" — it rebuilds the model with reasoning disabled
(`reasoningOff`) and appends a brevity note (`src/llm/structured.ts:490`), so the request
itself changes. A prefix cache hit skips prefill and does not alter the sampling distribution.
