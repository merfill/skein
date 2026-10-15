# Skein — system prompt: behavior and blocks

> **Note.** The prompt is split into a stable **base** and **situation instructions**
> (`request` / `plan` / `working` / `transition` / `terminal`) — see `src/loop/prompt/blocks.ts`
> and `docs/ir_semantics.md` §6–7. A block's text is a system message; the tool contract is
> separate (`PROPOSAL_TOOLS` → the request's `tools` field).

> Russian mirror — `docs/system_prompt_ru.md`.

Related: `docs/ir_semantics.md` (IR semantics: the prompt is the doxa's policy over it),
`docs/tools.md` (tool contract), `docs/projection.md` (what the model sees),
`docs/plans/archive/system_prompt_revision_plan.md` (revision plan and phases),
`src/loop/prompt/` (assembly), `tests/prompt.test.ts` (L1 tests).

This is the **source of truth about prompt behavior**. The code follows it: a behavior
change goes "edit here → edit the block → test".

## 0. Principle

The prompt is an **operational spec of the doxa's policy**, not a paragraph of text. It is
made of **blocks**, and one block is responsible for **one behavior**. A block's behavior
is checked at three levels:

- **L1 — static contract** (`tests/prompt.test.ts`, offline, CI): structure, tool names,
  required phrasings;
- **L2 — fixture scenarios** (under `SKEIN_LIVE=true`): trajectory shape on a fixture;
- **L3 — acceptance/bench**: real tasks, including the controlled experiment.

Honestly: L2–L3 depend on LLM non-determinism and are therefore weak; L1 is mandatory,
L2 is under the gate, L3 is acceptance.

## 1. Assembly model

- The prompt has a stable **base** (`BASE_PROMPT`, true on any move) and per-situation **node
  instructions** (`NODE_INSTRUCTIONS`, keyed by `Situation`: `request` / `plan` / `working` /
  `transition` / `terminal`), assembled in `src/loop/prompt/blocks.ts` (re-exported by
  `src/loop/prompt/index.ts`): each is its blocks' texts joined with `\n\n`.
- A block is `{ id: string; text: string }`; the IDs are stable (B1…).
- `src/loop/propose.ts` builds the message list as: `BASE_PROMPT`, the constraints, the tape
  (the history), then the situation's instruction **appended last** — temporary, re-derived from
  the situation each turn, never stored in the history (`docs/ir_semantics.md` §6).
- The tool contract (names, parameters, descriptions) is **not** copied into the prompt text:
  it is sent as the request's `tools` field (native function-calling), generated from the
  single registry `PROPOSAL_TOOLS` (`src/llm/tools.ts`). The prompt only tells the model to
  call the available tools.

**Assembly invariants:**

1. one block = one behavior; no duplication between blocks;
2. every behavior has an ID and a §2 entry;
3. the assembled prompt equals the concatenation of blocks (checked by L1);
4. the prompt does **not** repeat the tool descriptions — they ship in the request's `tools`
   (checked by L1).

## 2. Blocks

The prompt is deliberately plain (an "opencode-style" trim, Phase 11): it states what the
engine requires, not how to think. Strategy lives in the tool `description`s and the tape.
Current blocks:

| ID | Behavior | Basis | Status |
|---|---|---|---|
| B0 | Frame: a coding agent implemented as a state machine — stages of work with exit criteria, transitions as preconditions; files/directories on disk; independent calls are batched | `prompt_state_machine_concept` | in code |
| B4 | The walk (`move { state, what, done }` declares the state, its goal and its stop condition — a state IS its goal; the first `apply` seeds the plan; `stop` finishes it and forces the transition); the whole state set with a `Done` per state; the conditioned transitions grouped by source, rendered from `ISLANDS` | `src/ir/islands.ts` | in code |
| B6 | Request situation: choose the starting state (`move`, with `what`/`done` scoped to it — **from the request**) or `decline`; the startable states | `tools` §5.1 | in code |
| B7 | Plan situation: take the state's first step (the next tool call); act on the goal and the tape; no change history | `ir_semantics` §4.2 | in code |
| B8 | Working situation **block** — superseded by `turnInstruction` (below): work the state now; when the criterion holds, `stop` (no criterion gate) | `ir_semantics` §4.3–4.4 | defined, not wired |
| B9 | Transition situation (dynamic — `transitionInstruction(island)`): the source of `what`/`done` is the `Finish state <label>` line of the just-finished state; the `next` neighbours (+ Finish) are listed; "choose the next state (`move`) or Finish and `stop`" | `ir_semantics` §4.1 | in code |
| B10 | Terminal situation: the Finish state — call `stop` to end the request | `ir_semantics` §4.4 | in code |
| B13 | Output discipline: **removed** (the base prompt carries the contract) | — | cut |
| B19 | The workspace is the source of truth — the change is already in the files; find it by reading the code and reproducing the failure; do not assume a VCS/`git`/diff/history; a `git` failure is not retried | `tests/prompt.test.ts` | in code |

A state is rendered **on the tape**, not injected per turn: a `Start state <label>` marker (an
`assistant` turn) followed by the state's goal as a `user` turn (`<what>` + `Done when: <done>.`).
The request is a **temporary** `user` turn — shown when a state is chosen (`request` /
`transition`), dropped while a state is worked. On an open state, the per-turn instruction is
`turnInstruction` (appended last, temporary): `This state's done criterion: "<criterion>". When it
holds, \`stop\` — and nothing else; do not over-work the state.` A stalled state also gets a soft
nudge (`Context.nudge`, `docs/ir_semantics.md` §2.8).

Removed in the opencode-style trim (Phase 11): **B3/B4/B5** (folded), **B8** (VCS policy),
**B9** (external reference / diff playbook), **B11** (revision loop), **B15** (stop — now a
bullet in B7), **B17** (foreground — now in the `bash` description). Also cut: **B10** (the
failure-diagnosis playbook) and the localize→edit trigger from **B16**, and the
diff/localization steering from the `webfetch`/`grep` descriptions. The rationale: these were
opinionated strategy heuristics; the prompt now keeps only the engine contract, and a generic
coding model strategizes from the tape and the tool descriptions.

Then (Phase 13) the prompt drops every tool mechanic and moves to the `tools` field: **B12**
(the tool index — a verbatim copy of the `tools` descriptions), **B14** (stream discipline — in
the `bash` description) and **B16** (constraints/stale-read — in the `edit`/`write` descriptions
and enforced by the engine) are gone; **B1**/**B2**/**B13** are reworded as a plain coding
agent (no doxa/logos vocabulary), and **B7** is trimmed to the situational contract.

### Per-block detail

- **B1** frames a plain coding agent with access to the files and directories on disk; it makes
  one or more moves per turn, which the engine executes in order and returns the results. A
  batch must be independent: no call may depend on a sibling's result. The tape/projection is an
  engine concern, not prompt text.
- **B4** states the walk: `move { state, what }` declares the state AND its goal (a state IS
  its goal), the first `apply` seeds the plan, further `apply`s work it, `stop` finishes it and
  forces the transition decision; a `move` while a state is open is refused. It renders the
  candidate initial states (`Start`) and the conditioned transitions from `ISLANDS`.
- **B6** (request) fixes the first move: `move { state, what }` chooses the starting state and
  its goal (or `decline` for a non-actionable request). A bash command stays literal, from the
  workspace root, with a `cd <dir> &&` prefix in a subdirectory; if the request names no command,
  the state's first action is a discovery one (`ls`, `cat README.md`). The `cd` rule is echoed in
  the `move` `description` — the schema the model sees on every call.
- **B7** (plan situation) gives the declared state's FIRST plan item — an ordinary tool call
  (`apply`): any tool, usually a bash command. The engine runs it at once and it seeds the
  state's plan. There are no sub-states.
- **B8** (working situation) fixes the loop **search → implement**: search first and widely (a
  batch of independent reads/greps), and once the exact change is named, `edit`/`write` at once;
  when the state's criterion holds, `stop` it (no criterion gate). A `move` while the state is
  open is refused. `stop` closes the state and is the only closure.
- **B9** (transition) is the forced decision after a `stop`: `move { state, what }` to the next
  state (routes from B4), or `move { state: "finish" }` when the work is done. Give `note` to
  summarize the state being left.
- **B10** (terminal) is the Finish state: call `stop` to finish the request.
- **B18** gives short micro-examples of a move to anchor its form.
- **B13** keeps reasoning short — never recall/reconstruct code from memory, no code snippets in
  reasoning (to see code, `read`/`grep`/`webfetch`).
- **B12/B14/B16** no longer exist as blocks: the tool names/parameters/descriptions, the
  stdout/stderr + `pipefail` guidance and the constraints/stale-read rules live in the tool
  `description`s (`src/llm/tools.ts`) and, where enforceable, in the engine (repeat and
  `stale_base` refusals).

## 3. Cross-cutting invariants

1. no contradictions between blocks (checked by review and L1 phrasings);
2. the prompt does not repeat the tool descriptions — they ship in the request's `tools`
   (L1, Phase 13);
3. the prompt's character budget is an **open question** (§6): no target is fixed and no
   test enforces one.

## 4. What changed

- **Phase 1 (2026-10-07).** The text was moved into blocks without a behavior change; the
  `src/loop/prompt/` structure was assembled; an L1 assembly test was added. The texts are
  preserved verbatim (comparison with `HEAD` by normalized whitespace is identical; only
  the paragraph separators differ).
- **Phase 2 (2026-10-07).** B12 is generated from `PROPOSAL_TOOLS` (the `apply` drift is
  removed); the tool contract and arguments moved into the `description`s
  (`src/llm/tools.ts`); B14 and B15 are extracted from "Rules" into their own blocks; B16
  is trimmed to unique rules. Prompt: 20,338 → 17,718 characters.
- **Phase 3 (2026-10-07).** B8 is rewritten (git is fine when history exists; a failed git
  is not retried; local history ≠ an external reference); B9 is added (external reference
  and diff localization); the anti-git line is removed from B7 (the policy lives in B8).
  L2 fixtures: `reference-diff` (a reference snapshot → expect a `diff`) and `no-vcs` (no
  `.git` → no repeated git).
- **Phase 4 (2026-10-07).** Added the `fetch` tool (URL → workspace, read-only reference)
  and `apply_patch` (unified diff); `read`/`edit`/`write` no longer crash the run on a path
  outside the workspace — a refusal is recorded (like `grep`/`list`).
- **Phase 5 (2026-10-08).** B3/B4/B11 and the `move` description now state that the
  request's `alternatives` is the history of interpretations and that a `what` equal to a
  refuted option's label is refused `repeat_hypothesis`, even with `revises` (a live run
  re-proposed a refuted interpretation because B11 only spoke of the current goal).
- **Phase 6 (2026-10-09).** B7's repair routine gained the prepare/build step and B10 split
  its single "not found = wrong directory" rule into wrong directory (missing source path)
  vs unbuilt/unconfigured tree (missing build output → run the project's build; setup, not
  the defect). A live `fix-ocaml-gc` run applied the correct edit but read
  `No rule to make target '../Makefile.build_config'` as a directory error and never ran
  `./configure && make`, so its own criterion never passed (reward 1 only via the verifier's
  clean rebuild).
- **Phase 7 (2026-10-09).** B7/B16 add the **named-suspect trigger**: once the exact
  expression to change is named, the next action is `edit` — not more reading; B9 calls a
  reference diff a **lead, not a checklist** (a moved-upstream diff carries many unrelated
  deltas, so hunt the one invariant-breaking change). Engine: `invokeTools` no longer
  doubles the completion cap on a truncation — one brevity retry at the ceiling (a live
  transcript run turned one `read` into 4 calls / 60.9k completion tokens).
- **Phase 8 (2026-10-09).** The `run` description and B7 now say a build/test is run in the
  **foreground** (it blocks, one turn for the whole command) and that `background` is for
  non-terminating commands only. Engine (`workspace.ts`): `startJob` gives a job a short
  grace before handing back a handle, and `pollJob` waits for the job (up to the cap) instead
  of returning `running` at once — the shell writes its `$?` to `.skein/jobs/<id>.code` so
  the synchronous wait sees completion. A live `fix-ocaml-gc` run backgrounded three builds
  and spent 16 of 60 turns polling them (≈25% of the cost); a foreground run of the same
  builds finishes in one turn each (docs/tools.md §4.7).
- **Phase 9 (2026-10-09).** The workspace-root/`cd <dir> &&` rule moved into the
  `move` tool `description` (B6 already had it, but the tool schema is what the model
  attends to most). A live `fix-ocaml-gc` run interpreted the request — which named `ocaml/`
  and the bare `make -C testsuite one DIR=tests/basic` — with the bare command and only
  revised it late, turning most of the run into criterion churn. B7's interpretation bullet
  also gained the caveat. New live test `tests/live/root-cd.test.ts` (one call per layout).
- **Phase 10 (2026-10-09).** Goal reduction (`docs/plans/archive/goal_reduction_plan.md`): B3/B4/B6/
  B7/B11/B15 lose the criterion vocabulary. A goal is `what` with a plan
  seeded by the first `command`; `stop` closes it with no criterion gate; `revises`/
  `repeat_hypothesis`/`check_not_run`/`checkReady`/`nextAction`/`state` are gone. The
  `move` and `run` tool `description`s are rewritten accordingly (`run` is one plain
  foreground command — no `target`/`background`/`job`).
- **Phase 11 (2026-10-10).** Opencode-style trim: the prompt states the engine contract, not
  strategy. Removed **B9** (external reference / diff playbook), **B8** (VCS), **B11** (revision
  loop), **B17** (foreground), and the folded **B3/B4/B5**; **B15** moved into B7 (stop bullet);
  **B10** trimmed to the wrong-directory vs unbuilt-tree split; **B1/B6/B7/B13** reworded
  shorter. Motivated by the `fix-ocaml-gc` comparison: opencode's build prompt carries no
  diff/localization heuristics at all, yet localizes with the same model.
- **Phase 12 (2026-10-11).** Opencode tool-surface alignment: the model-facing tool names and
  params now match a coding model's priors (`read { filePath, offset, limit }`,
  `edit { filePath, oldString, newString }`, `write { filePath, content }`,
  `grep { pattern, path?, include?, from? }`, `fetch` → `webfetch`,
  `bash { command, workdir?, timeout? }`); the IR (`applySchema`) is unchanged and
  `toProposal`/`modelCall` translate both ways (`docs/ir_semantics.md` §7). `bash` gained
  `workdir`/`timeout` (`OP-AP-RUN-3`) and B14 was softened (pipes are allowed) — the hard
  pipe ban was a legacy of the old `run` that pushed the model into awkward commands.
- **Phase 13 (2026-10-11).** Prompt-by-prompt trim + the **batch** contract. The engine now
  accepts several tool calls in one doxa move (a batch): `invokeTools` maps every call,
  `executeNode` runs them in order in one turn and a terminal move (`move`/`stop`/
  `decline`) ends the batch; the projection renders a batch as one `assistant` with N
  `tool_calls` + N `tool` results (`docs/ir_semantics.md` §7). The prompt was rewritten for a
  plain coding agent: **B1** drops the doxa/logos framing, **B2** is plain labels, **B13** drops
  the discarded `thought` ritual, **B7** is trimmed to the situational contract, and **B12**/
  **B14**/**B16** are removed (their content lives in the tool descriptions / engine). Base
  prompt 7728 → 973 characters.
- **Phase 14 (2026-10-11).** Structural prompt rewrite (S1–S4): a stable base (contract +
  capabilities + output discipline), the request situation (B6) and the goal situation (B7 +
  micro-examples B18). Block **B12** (the tool index — a verbatim copy of the `tools`
  descriptions) is removed for good: the descriptions ship only in the request's `tools`, as
  invariant §1.4 requires. Motivated by a controlled A/B on `fix-ocaml-gc --net on` (see
  `docs/benches/best_bench.md`): with the index the model read and diffed more, made one edit
  and never stopped; without it — three edits, self-stop and half the cost.
- **Phase 15 (2026-10-13).** State protocol (`docs/plans/archive/state_protocol_plan.md`): the prompt
  now teaches the walk — `move` declares the state, a second turn concretizes that state's
  work (no sub-goals), `apply` works it, `stop` finishes it and forces the transition.
  Situations split five ways, with new blocks B8, B9 (transition), B10 (terminal); B4/B6/B7/B18
  reworded. The model declares the state and concretizes it in separate turns (a `move` ends the
  batch).
- **Phase 16 (2026-10-13).** Goal-into-move (`docs/plans/archive/goal_into_move_plan.md`): the goal
  node and the separate concretization operator are gone — a state IS its goal.
  `move { state, what }` declares the state AND its goal; the plan hangs directly off the
  `move` and is seeded by the state's first ordinary `apply`. Situations become `request` /
  `plan` / `working` / `transition` / `terminal`; B4/B6/B7/B8/B9 reworded (B7 now gives the
  first plan item, not a goal). The model surface offered each turn IS the frontier
  (`Context.applicable`).
- **Phase 17 (2026-10-13).** The closure is rendered as the state's own `move` result: while
  the state is open the result is a confirmation (`moved to <label>`); once stopped it is the
  closure line (`State <label>: finished — <why>`, from `move.stop`) — no separate `stopped:`
  assistant line and no changed-file list. Each state is exactly its `move` call plus that
  call's result. The offered tool surface is now **wired** to the frontier
  (`propose` → `toolNamesFor(applicable)` → `allowedTools`): on a transition only `move` is
  offered, so an `apply` at a transition cannot be called. B4/B9 gained the "trust the state's
  record" line.
- **Phase 18 (2026-10-14).** The state directives moved to the **active** form (imperative), and
  `Island.relief` was renamed to `Island.directive`, rendered in the state description as
  `Now: …`. B6/B7/B8/B9/B10 and `observationInstruction` became direct instructions. B13 split:
  do not invent content (memory) vs the current state's tape is authoritative (do not re-read).
  B19 rewritten from a ban to a redirect, and the `git` line removed from the `bash` description.
- **Phase 19 (2026-10-15).** The island delimits the **action surface**: `Island.applies` bounds
  the apply-tools of an open state, the frontier carries it (`Applicable.applies`), `toolNamesFor`
  binds the surface from it, and `classify` refuses a tool outside it (`not_in_state`). The
  write-class (`edit`/`write`/`apply_patch`) is Patch's alone, so Localization cannot
  pre-satisfy Patch (no empty-Patch loop). `observationInstruction` is island-aware (a state
  without a write tool is told to `stop`), `nudge` composes the island directive, and
  `Localization.directive` no longer edits. B19 drops "the change is already in the files"; B4
  states that tools are state-scoped. See `docs/prompt_state_machine_concept.md` §4.2 and
  `docs/ir_semantics.md` §2.5/§8.9.
- **Phase 20 (2026-10-15).** A **state is a decision, not a tool call**: `move`/`stop` render as
  `Start state <label>` / `Finish state <label> — <why>` markers with the goal as a `user` turn,
  and the request is a temporary `user` turn shown only at a state decision (`request` /
  `transition`); the `move` JSON result is gone. `turnInstruction` restates the state's criterion
  and makes `stop` the expected move when it holds (`call \`stop\` and nothing else — do not look
  ahead`); the `stop` tool description is the single line "call `stop` — and nothing else — when
  the current state's Done criteria are met"; the `move` description scopes `done` to the state
  (never a later state's work). The `transition`/`terminal` situations are now wired in
  `buildMessages` (they were defined but never appended). See `docs/ir_semantics.md` §7 and
  `docs/projection.md`.
- **Phase 21 (2026-10-15).** **Observable state criteria** (`src/ir/islands.ts`): `Localization` →
  "the failure is located — the file(s) and the offending code are named", `Patch` → "the fix is
  applied in the workspace", `Verification` → "the request's acceptance command now passes" (the
  island criterion is generic; the doxa concretes it on `move`). `turnInstruction` is rewritten:
  `This state's done criterion: "<criterion>". When it holds, \`stop\` — and nothing else; do not
  over-work the state.` (the "otherwise … single next step" and the next-state fragment are gone —
  they masked an unfulfillable criterion). `transitionInstruction` points at the just-finished
  state's `Finish state <label>` line as the **source** of `what`/`done`. The `stop` description =
  the state's outcome (no "next state"), `why` required; `done` is required on `move`. Details and
  the run — `docs/benches/best_bench.md` §"Latest version"; the tape — `docs/projection.md`.

## 5. Test map

| Level | Where | What it checks |
|---|---|---|
| L1 | `tests/prompt.test.ts` | assembly from blocks; unique IDs; the prompt does not repeat tool descriptions; stream separation + `pipefail` in the `bash` description; stale-read safeguard in `edit`/`write`; workspace root (prompt + `move` description) |
| L1 (Phase 2) | `tests/prompt.test.ts` | every `PROPOSAL_TOOLS` tool is registered; no `apply {`/`{ tool:` |
| L2 | `tests/live/scenarios.test.ts` | trajectory shape on a fixture (B7) |
| L3 | `bench/`, `docs/benches/bench_report.md` | acceptance; the controlled experiment (Phase 5) |

## 6. Open questions

- The target character budget for the prompt and what to move into tool `description`s.
- How strict B6/B7 should be (how much to dictate order vs leave flexibility).
- The prompt no longer carries a diff/localization heuristic (Phase 11); if one is wanted
  later it should be an optional tool-usage hint, not a base block.
