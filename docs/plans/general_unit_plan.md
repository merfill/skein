# General unit — a non-coding task with one work segment

> Russian mirror — `docs/plans/general_unit_plan_ru.md`.
>
> Status: implemented (first slice). Typecheck clean; offline suite — **528 passed,
> 40 skipped**. No live model run yet.

## 1. Why

A request to analyse a benchmark task, explain how something was done, or compare approaches
was routed to the coding `task` unit. The coding islands then forced `research → construction`:
`research` has no transition to `end` (`src/ir/islands.ts`), so a pure analysis was pushed into
productive work. The fix is a separate unit for general tasks, not a new coding state.

The session prompt is also tightened: `start` is for work that changes files or runs
side-effecting commands; analysis uses `respond` or `general`.

## 2. The unit

`UnitType = "general"`; it is **not** a coding island. The IR shape is the same as a task:

```text
request → move(general) → plan → items → actions → observations → stop
```

- one work segment, no island transitions, no `end` state;
- `move.payload.state` is the unit-level label `general`; `moveIsland` returns `undefined`, so the
  coding state machine never sees it;
- the plan is an ordinary plan; `read`/`grep`/`list` actions append items and observations;
- `stop` on the move closes the only segment and the unit; `stop.why` is the final answer;
- `attentionOf` derives `completed` from that `stop`.

The unit has its own journal and isolation: it sees only the reformulated request and its own
tool results, never the session L0 or other units.

## 3. Loop and prompt

`GENERAL_BASE_PROMPT` is a unit/state prompt, not a tool catalogue:

```text
You are a general analysis agent. You work in one state, General.
State: General — answer the request from the material.
Done: the answer is complete and supported by what you read.
This state only reads: do not change files and do not run mutating commands.
Answer in GitHub-flavored Markdown. When the answer is complete, close the state with `stop`;
put the final answer in `why`.
```

The tape is:

```text
system: base prompt
user:   reformulated request
assistant/tool: read/grep/list calls and results
system: Finish state General — <answer/why>
```

Tool names and descriptions are supplied through the tool surface, not the prompt. The general
model surface is `read`, `grep`, `list` and `stop`; mutating tools are not offered.

## 4. Session routing

New operation `general { text }`. The session prompt distinguishes:

- `respond` — quick answer, clarification, confirmation;
- `general` — self-contained non-coding analysis/explanation/comparison/investigation that may
  need several read-only turns and its own record;
- `start` — work that changes files or runs commands with side effects.

The general agent sees only `text`; the session agent reformulates the request so it stands
alone. There is no post-task report: the unit's `stop.why` is the answer.

## 5. UI

- The existing right-hand task panel shows the general unit as one `general` state with turns,
  tokens and actions; there is no separate general window.
- The existing history overlay can show the unit as a task-like row.
- Trace rows are prefixed `[general]`; the final answer is a normal Markdown assistant turn.
- The header's `Σ` includes general model calls; `ctx` remains the session agent's context.

## 6. Files

- `src/session/general.ts` — prompt, loop, IR seed, progress and telemetry.
- `src/llm/general.ts` — model proposer (`read/grep/list/stop` surface).
- `src/session/types.ts`, `operations.ts`, `session.ts`, `driver.ts`, `session_outline.ts` —
  unit type, operation, pending type, dispatch/resume/cancel, completion and L0.
- `src/session/session_agent.ts`, `src/llm/session_agent.ts` — approved routing and tool
  descriptions.
- `src/tui/*` — general progress prefix, live journal, panel/history inclusion.
- `tests/general_unit.test.ts`.

## 7. Deferred

- `probe`/`fetch` in the general tool surface;
- a live scenario proving the session agent chooses `general` for analysis;
- general-specific report/summary (the answer is `stop.why` for now);
- a separate history filter or badge if the mixed list becomes noisy;
- mapping `general` into the coding base prompt is deliberately absent.

## 8. Commands

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'
npm run cli -- --dir <project>
```
