# Skein — the context projection: the message tape

> Russian mirror — `docs/projection_ru.md`.

> **Folded from the revision.** The projection is a message tape rebuilt from the tree every
> turn; the old `path`/`lastResult`/`shown`/`calls`/`applicable`/`budget` blocks are gone.
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
- `tool` — command results.

| Move | Messages |
|---|---|
| `create_goal` | `assistant` (the goal, each field labelled `[id] create_goal:` / `what:`, an absent field shown as `(none)`), then `assistant` (the first command call) + `tool` (the observation) |
| `apply` | `assistant` (the call) + `tool` (the observation) |
| `stop` | `assistant` (the reason `why`): the goal is closed |
| `decline` | `assistant` (the reason `why`): the request is declined |

Every plan item is a pair `assistant` + `tool`; creating and closing a goal are separate
`assistant` messages. A command that ran and mutated a file (an edit) has no observation, so
its `tool` message reads `mutated <path>`.

## 3. The tape is built by walking the tree

- the request is the first `user` turn;
- its goal renders its `create_goal` message and then its plan items and their alternatives,
  in order; a sub-goal alternative renders inline (with an alternative marker);
- **the tape is not monotone.** When a goal closes, its internal messages leave the tape; on
  its parent's arm only the closure message (`stop` with `why`) remains. Only the view goes,
  not the data: the tree stays complete. Going up further trims the same way;
- **the doxa's reasoning is not stored**: raw `thought` is not in the tree and does not enter
  the tape; its meaning lives in the `why` fields.

## 4. Markers and addresses

- an alternative command carries `alternative to step "…" (previous attempt: "…" — reason)`,
  so the model sees what already failed;
- each `assistant`/`tool` message is prefixed with the node id (`[id] …`), so any result can
  be addressed by id with `recall`/`search`.

## 5. Working with data

A result body is bounded by the tool itself, with a **per-tool** budget (`read` 64K;
`grep`/`list`/`run` 8K); the `tool` message shows the tool's window whole and never cuts its
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

- the **base prompt** holds only what is true on any move — the role, the contract (one move;
  the logos decides), the answer form, the tool index, the stream discipline. It is stable,
  so it is a good cache prefix;
- the **node instruction** holds the admissible moves and the rules of the current situation
  (a fresh request / an open goal);
- the **constraints** are added as separate `system` messages.

The exact base/node boundary is the subject of the following stage (the composite system
prompt).

## 7. Determinism

`project` is pure: the same events give the same tape. The only transient input is the
current turn's `recall`/`search` result (§5); because it is derived from the same move, the projection
stays deterministic.
