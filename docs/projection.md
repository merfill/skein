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

- `system` — the base prompt, the current node's instruction, and the constraints;
- `user` — the request;
- `assistant` — the doxa's moves;
- `tool` — command results;
- `system` — a state's description, shown once when the state is entered.

| Move | Messages |
|---|---|
| `move` | `assistant` (the call `move { state, what, note? }`) + `tool` (the result of that call): while the state is open the result is a confirmation (`moved to <label>`), followed by a `system` message with the state's description (`What / Done when`); once the state is stopped the result is the state's own **closure line** `State <label>: finished — <why>`, read from the `move.stop` relation |
| `apply` | `assistant` (the call) + `tool` (the observation); the first `apply` after a `move` seeds the state's plan and its first item |
| `stop` | the state's closure; it adds no message of its own — it is rendered as the result of that state's `move` (or, at the terminal state, the request ends) |
| `decline` | `assistant` (the reason `why`): the request is declined |

Every plan item is a pair `assistant` + `tool`; the first `apply` after a `move` seeds the
state's plan. A command that ran and mutated a file (an edit) has no observation, so its `tool`
message reads `mutated <path>`. The closure line carries **only** the state label and the `stop`
reason (plus the `note` the model passed on the move that left it) — never the list of changed
files: a state that runs a build mutates thousands of artifacts.

## 3. The tape is built by walking the tree

- the request is the first `user` turn;
- its states (`move` children) render in order: an **open** state renders its `move` call, its
  result, and then its plan items in order (the first `apply` seeds the plan); a **finished**
  state — the current one awaiting the transition, or one already left behind — collapses to
  just its `move` call and its result (the closure line `State <label>: finished — <why>`). No
  plan turns and no separate `stop` message remain;
- **the tape is not monotone.** When a state is left behind, its `apply` turns
  leave the tape; only its `move` + closure remain. Only the view goes, not the data: the tree
  stays complete;
- **the doxa's reasoning is not stored**: raw `thought` is not in the tree and does not enter
  the tape; its meaning lives in the `why` fields and the `move` `note`.

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

A `recall`/`search` creates no node, so its result is not in the tree: it is appended as a
transient `assistant` (the call with its arguments, not a bare name) + `tool` pair for the turn
that follows it. A refused structural move likewise
creates no node: its reason arrives as a transient `tool` message (`rejected <move>: <reason>`)
on the next turn.

## 6. The system part

The system part is assembled from the current node's intent, not as a monolith:

- the **base prompt** holds only what is true on any move — the role and the contract. It is
  stable, so it is a good cache prefix. The tool names/parameters/descriptions are **not** here:
  they ship in the request's `tools` field;
- the **tool surface** offered in that field is bound from `Context.applicable`: on a transition
  only `move` is offered, while a state is open the apply tools and `stop` are offered
  (`recall`/`search` always), so a move the engine would refuse cannot be called at all;
- the **node instruction** holds the admissible moves and the rules of the current situation
  (a fresh request / a state awaiting its first plan item / an open state / a finished state
  awaiting the transition / the terminal state); while a state is in focus, the state's
  `What / Done when / Constraints` follow it;
- the **constraints** are added as separate `system` messages;
- right after a tool result inside an open state, an **observation instruction** is appended as
  the last `system` message (`Context.result`): it restates the state's rule (`State` / `Goal` /
  `Done when` / `Constraints`) and asks whether `Done when` already holds — yes → `stop`; a step
  worked, more needed → the next action; failed/wrong step → a different action.

The exact base/node boundary is the subject of the following stage (the composite system
prompt).

## 7. Determinism

`project` is pure: the same events give the same tape. The only transient input is the
current turn's `recall`/`search` result (§5); because it is derived from the same move, the projection
stays deterministic.
