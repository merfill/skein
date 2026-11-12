# Skein — the context projection: the message tape

> Russian mirror — `docs/ru/projection.md`.
>
> The conceptual model is in `ir.md` §4; the operator registry is in `ir_operations.md`. This
> document describes the tape the model reads on each turn.

## 1. Purpose

The context is what the model sees on the next step: all of its memory. It looks like an ordinary
tape of messages, but it is rebuilt from the journal on every turn — a projection, not an
accumulating transcript. The same events always give the same tape.

The journal is monotone; the tape is not. Content leaves the tape when it is no longer relevant and
remains in the journal by address.

## 2. Roles

- `system` — the base prompt, the constraints, the brief for the current state, the state markers,
  and the situation prompt (appended last, temporary);
- `user` — the request, which leads the tape on every turn, and the working prompt of an open
  state;
- `assistant` — the model's tool calls, together with its reasoning part when the provider returns
  one;
- `tool` — the results of commands.

There is no separate message for `stop`: the model closes a state with a text reply, and the
executor records that reply as the state's closure.

## 3. What the tape contains

**The request.** The request is the first `user` turn, after the base prompt and any constraints, on
every turn. It is marked as reference in the working prompt: it explains why the task exists, but
the open state's goal is the only active goal for the turn.

**A fresh request.** Before the first `move`, the tape carries a request brief (the workspace
coordinates and the environment) as a `system` turn.

**An open state.** The tape carries:

1. a `system` marker `Start state <label>`;
2. the state's brief as a `system` turn: the workspace coordinates plus the part of the
   environment the state needs; End gets nothing, and closed states carry no brief;
3. the state's turns: each tool call is an `assistant` message, and its result is a `tool`
   message. The first `apply` after a `move` creates the turns and appends the first action;
4. after the turns, `buildMessages` appends one `user` working prompt with `Goal`, the model's
   earlier guess (`Your earlier guess (may be wrong): …`) when set, `Done when`, `Plan`, and the
   request marked as reference.

A command that changed files with a file tool (`edit`, `write` or `apply_patch`) has no
observation; its `tool` message reads `mutated <path>`.

**A closed state.** Only the `system` markers remain:

- `Start state <label>`;
- `Finish state <label> — <why>`, read from the state's closure;
- `Artifacts: <paths>` when the state used `write` or `edit`. Shell mutations and `apply_patch` are
  excluded.

The brief and the turns leave the tape. The `Finish state` line carries the state's result, not a
list of every file a build touched.

**A declined request.** The tape carries an `assistant` message with `declined: <why>`. No state is
created.

**A session.** The session agent reads the trace of each unit, not its details: the unit id and
type, the request or utterance, the result, the status, and the answer or operation. Details are
reached with the memory tools and become observations of the calling unit. See
`sessions.md`.

**A plan.** While a plan is executing, the session agent's context receives a separate `system`
block: the active plan, its item statuses and the current item. Only the current item's work order
reaches the unit's agent — the session agent picks the operation and opens the unit — never the whole
list. The line `plan <id>: done|aborted (n/N)` is
the special plan-completion element in the session trace; `plan_started`/`plan_finished` are
session-journal events, and the block is rebuilt from them every turn.

**Reasoning.** The reasoning of a turn is stored on its action and rendered as the assistant
message's reasoning part. It is not a visible answer and is not a separate tape message. The
visible text that closes a state becomes the `why` of its `Finish` line.

## 4. Addresses and elision

Every `assistant` and `tool` message is prefixed with its record id (`[id] …`), so any result can
be addressed by id with `recall` or `search`. A closed state's details are not shown, but they
remain in the journal and are one address away. A refused structural move creates no record: its
reason arrives as a transient `assistant` call and a `tool` message, `rejected <move>: <reason>`,
on the next turn.

## 5. Working with data

Every tool result shares one inline budget, 8K:

- an inspection result (`read`, `grep`, `list`, `recall`, `search`) keeps its head up to 8K; a
  larger body is paged (`read` `offset`/`limit`, `recall` `start`/`end`);
- a command's output (`bash`) keeps its tail up to 8K, because the error and exit code are at the
  end.

The `tool` message shows the tool's window whole and never cuts its middle. Only a body that still
exceeds the budget is bounded, with a note about the omission. The executor stores the full body as
a file and the record keeps a reference. Access is by identifier, not by path:

- read a fragment — `recall { id, start, end }`;
- search the body — `search { id, pattern }`.

A `recall` or `search` leaves an action and its observation among the state's turns, so the fetched
window stays on the tape while the state is open and leaves with the state on closure.

## 6. The system part

The system part is assembled per situation, not as a monolith:

- the **base prompt** holds only what is true on any turn — the role and the contract. It is
  stable, so it is a good cache prefix. The state map and the transitions are scoped to the
  request and transition prompts. Tool names, parameters and descriptions are not in the base
  prompt: they ship in the request's `tools` field;
- the **tool surface** is bound from `Context.applicable`: a fresh request offers `move` and
  `decline`; a transition offers `move`; an open state offers the state's apply tools plus
  `recall` and `search`; the terminal state offers none, because the model closes it with text.
  There is no `stop` tool;
- the **situation prompt** is appended last for `request`, `transition`, `terminal` and the open
  state (`working`), always temporarily and never stored. `working` appends one `user` turn with
  the state's `Goal`, guess, `Done when`, `Plan` and the request marked as reference. `request`
  asks for the first state or `decline`; `transition` reads the just-finished state's `Finish`
  line, lists the next states and asks for the choice; `terminal` carries the completion rule;
- the **constraints** are added as separate `system` messages.

The `what` of a `move` is an optional note. The legacy `done` field is not offered to the model
and is not rendered.

## 7. Determinism and the transient refusal

`project` is pure: the same events give the same tape. The only transient input is the reason of a
refused structural move; because it is derived from the same move, the projection remains
deterministic.

## 8. The cost of the projection

A focus change rewrites the tape. The cost has three parts:

- **prefix cache miss.** The base prompt is a stable prefix, but a `move` changes the tape from the
  focus point on, so the tail is sent again;
- **one turn per transition.** Entering a state is a model call. A walk with more states costs more
  turns than a single pass;
- **re-framing.** The model must reconcile what happened, why it is here and what to do next. A
  crisp `Goal`, brief, instruction and `Finish state` line make this cheap; a thin state invites
  exploration. Measure the reasoning on the first turn after a transition against the second; a
  persistently expensive first turn is a state-definition bug, not provider noise.

Price the result — rubles per solved task, turns per task — not the transition. One extra short
turn can be cheaper than one long, lost turn inside a growing tape.
