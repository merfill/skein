# Skein — walkthrough: states and the dynamic tape

> Russian mirror — `docs/ru/walkthrough.md`.
>
> The source of truth is `ir.md`; the tape is `projection.md`; the states are `states.md`; the
> tools are `tools.md`. This document shows one request end to end.

## 1. The idea

A coding agent usually treats the message tape as memory: every action and result is appended, and
the model reconstructs the current goal and the relevant evidence from that accumulation.

Skein keeps the memory in an append-only journal. The tape is a **projection** of that journal,
rebuilt on every turn. The journal is monotone; the tape is not: a closed state leaves only a short
trace on the tape, while its data stay in the journal and are reachable by id.

A **state** is a frame of work, not a step and not a command. The model names it with `move`; the
state kind supplies the goal, the completion condition (`Done when`), the instruction (`Plan`) and
the tool surface. The model works the state in ordinary ReAct turns. When it replies with text, the
executor records that reply as the state's `stop`; the state closes and the next state is chosen.
The executor does not decide when a state is finished.

The request is reference, not the goal: it explains why the task exists, but the open state's goal
is the only active goal for the turn.

## 2. How the tape is built

The tape starts with the base prompt (`B1` role and `B2` principles) and any constraints. Then come
the request and the current state:

```
system   BASE_PROMPT
system   Constraint (k1): never touch paths matching ...
user     <the request>
system   <request brief: coordinates + environment>          ← fresh request only
user     <request instruction: choose a startable state>
system   Start state Patch
system   <state brief: coordinates + environment subset>
assistant  <tool call> + reasoning
tool       <result>
...
user     Goal: <state goal>
         Your earlier guess (may be wrong): <what>
         Done when: "<state condition>". When it holds, reply with the result as text only.
         Plan:
         <state instruction>
         The original user request is context for this state, not its goal.
```

The request is the first `user` turn, after the base prompt and any constraints, on every turn. The
working prompt is recomputed each turn and never stored. An open state carries its brief and its
turns; a closed state leaves only:

```
system   Start state Patch
system   Finish state Patch — <why>
system   Artifacts: src/parse.py          ← when the state used write or edit
```

The brief, the working prompt and the turns leave the tape. The data stay in the journal.

After a state closes, the transition prompt is appended as a `system` turn:

```
system   The engine recorded this state's result on the `Finish state Patch — …` line above.

         Choose exactly one next state:
         - Verification — the change is applied, and the edited lines read back.
         - Research — the work turns out to be a situation, not a defect to locate and fix.

         Call `move` alone with `what` = the object or situation the next state works on
         (≤20 words), not the task; leave `done` out, and do not do that state's work on this turn.
```

The next states are rendered from `next[].when`, not from their work descriptions. `move` is the
only tool offered at a transition. A fresh request offers `move` and `decline`; an open state offers
its apply tools plus `recall` and `search`; the terminal state offers none, because it is closed by
text.

## 3. A worked example

### 3.1 The task

`/app` is a small Python project with `src/parse.py`, `Makefile` and `tests/`. A change broke the
parser, so `make test` fails. The request is:

> "I broke the build; make `make test` pass."

Constraint `k1`: do not touch the tests.

### 3.2 The request

Before the first state, the tape is the base prompt, the constraint, the request, the request brief
and the request instruction:

```
system   # Role ... ## How you work ... ## General instructions ...
system   Constraint (k1): never touch paths matching tests/**
user     "I broke the build; make `make test` pass."
system   Workspace root: /app / Workspace repository: ... / environment
user     Choose exactly one of three values:
         - Patch when the task is to find an error in the existing code and fix it by editing an existing file.
         - Construction when the task is to write new file(s) explicitly.
         - Research in all other cases.
         The original user request is context for this choice, not the goal.
```

The task is a defect in an existing file, so the model starts in Patch.

### 3.3 Patch

The model calls `move { state: "patch", what: "the parse loop that breaks on the last token" }`.
The tape opens Patch:

```
system   Start state Patch
system   Workspace root: /app / Workspace repository: ... / environment
assistant [a1] grep { pattern: "def parse" } + reasoning
tool       [o1] src/parse.py:63 ...
assistant [a2] read { filePath: "src/parse.py", offset: 40, limit: 50 } + reasoning
tool       [o2] ... lines 40-89 ...
assistant [a3] edit { filePath: "src/parse.py", oldString: "...", newString: "..." } + reasoning
tool       [m] mutated src/parse.py
user     Goal: find the defect in the existing artifact and make the change it needs.
         Your earlier guess (may be wrong): the parse loop that breaks on the last token
         Done when: "the plan is complete: the error is found and fixed". When it holds,
         reply with the result as text only — no tool call.
         Plan:
         1. Find the file with the coordinates and the cause of the error.
         2. Fix the error and stop with a report about it.
         The original user request is context for this state, not its goal.
```

The criterion holds: the target is named with its coordinates, the cause is named, and the change
is applied. The model replies with text; the executor records it as the state's `stop`:

```
system   Start state Patch
system   Finish state Patch — line 63 drops the last token; the loop boundary is off by one.
system   Artifacts: src/parse.py
```

### 3.4 Verification

The transition prompt offers End or Verification. The model moves to Verification:

```
system   The engine recorded this state's result on the `Finish state Patch — …` line above.
         Choose exactly one next state:
         - Verification — the change is applied, and the edited lines read back.
         - Research — the work turns out to be a situation, not a defect to locate and fix.
         Call `move` alone with `what` = the object or situation the next state works on ...
```

```
system   Start state Verification
system   <environment facts>
user     Goal: check the changed artifact against the goal's acceptance.
         Done when: "the acceptance holds: the acceptance command passes, or every declared
         constraint holds, and the result is derived from the source material, not synthesized".
         Plan:
         Run the acceptance command if the workspace has one; otherwise check the declared
         constraints, and read the output itself — a zero exit status is not proof ...
assistant [a4] bash { command: "make test" } + reasoning
tool       [o4] exit 1 — IndexError: list index out of range
```

The change moved the loop boundary; on the last iteration the code reads `tokens[i + 1]` past the
end of the list. The verification failed. The model closes Verification with the literal failure:

```
system   Start state Verification
system   Finish state Verification — make test: exit 1 — IndexError: list index out of range
```

The transition prompt now offers End or Patch. The model chooses Patch: the target was right, but
the change or the cause it relied on was not. On the `Verification → Patch` move the executor emits
a `revert` and restores the files to their pre-patch state, updating the versions:

```
system   Start state Patch
system   <pre-patch coordinates and environment>
...
assistant [a5] edit { filePath: "src/parse.py", oldString: "...", newString: "..." } + reasoning
tool       [m] mutated src/parse.py
...
system   Finish state Patch — the boundary check was missing; the change now keeps the last token.
system   Artifacts: src/parse.py
```

The second Verification runs the same command:

```
system   Start state Verification
system   <environment facts>
assistant [a6] bash { command: "make test" } + reasoning
tool       [o6] exit 0
```

The model closes Verification with a passing result:

```
system   Finish state Verification — make test: exit 0
```

There is no separate "previous failed attempt" block: the failed attempt remains in the `Finish`
lines of the closed states.

### 3.5 End

The transition prompt offers End. The model moves to End:

```
system   Start state End
system   This is End.

         The work is done; complete the request. Reply with the final report as text only,
         with no tool calls.

         Read the tape — the request, the states the task passed, what each of them did,
         the files it changed, and how the result was checked — and write the report from
         those records in GitHub-flavored Markdown: what was done and where, how it was
         verified, and what is still open. Keep it as short as the result allows: lead with
         the answer, then only the detail the user needs to act. Do not enumerate files,
         states or checks, and do not restate the request, unless the user asked for a
         detailed report.
```

End has no turns and no tools. The model replies with the report as text; the executor records that
reply as the terminal `stop`, and the run ends with `request_addressed`:

```
system   Finish state End — <the report>
```

## 4. What remains in the IR

The tape showed the work; the journal kept it. The work model is a flat sequence of states, each
with a flat list of turns:

```
request
├─ move patch          turns: a1 grep, a2 read, a3 edit
├─ move verification   turns: a4 bash (exit 1)
│  └─ revert           files v2 → v1 on the move to Patch
├─ move patch          turns: a5 edit
├─ move verification   turns: a6 bash (exit 0)
└─ move end            no turns; a text reply closes it
```

A state's turns are its ordered actions, each with an observation or a file mutation. A state is
never a turn, and a turn is never a state.

A closed state's data are still addressable. For example, an observation from the first Patch can
be read while a later state is open:

```
recall { id: "o2" }        → the body of the read window, as a normal turn of the open state
search { id: "o4", pattern: "IndexError" }  → matching lines from the failed run
```

Both calls create an action and an observation in the open state's turns, so their result stays on
the tape while the state is open and elides with it on closure.

## 5. Notes

- **`what` is a guess.** The state's goal is `island.what`; `what` is the model's optional note
  about the concrete subject. The legacy `done` field is not offered and is not rendered.
- **The completion condition comes from the state kind.** The model sees it as `Done when`; it
  never supplies a `done` field.
- **`stop` is a record, not a tool.** A text reply closes the state; the executor writes the
  `stop` relation.
- **The tape is not monotone.** A closed state leaves `Start` and `Finish` (plus `Artifacts:` when
  it used `write` or `edit`); its brief, working prompt and turns leave the tape.
- **Reasoning is stored.** The reasoning of a turn rides as the assistant message's reasoning part;
  the visible text that closes a state becomes the `why` of its `Finish` line.
- **No criterion gate.** The executor records the closure; it does not evaluate the model's reply.
- **The tool surface follows the state.** Request: `move`/`decline`; open state: apply tools plus
  `recall`/`search`; transition: `move`; End: none.
- **A failed verification returns to Patch.** The executor reverts the last Patch when the move out
  of a failed Verification is made; the failure remains in the closed states' `Finish` lines.
