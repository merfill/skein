# Skein — system prompt: behavior and blocks

> **Note.** The prompt is split into a stable **base** and **node instructions** (request/goal)
> — see `src/loop/prompt/blocks.ts` and `docs/ir_semantics.md` §6–7. A block's text is a system
> message; the tool contract is separate (`PROPOSAL_TOOLS` → the request's `tools` field).

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
  instructions** (`NODE_INSTRUCTIONS`, keyed by `Situation`: `request` / `goal`), assembled in
  `src/loop/prompt/blocks.ts` (re-exported by `src/loop/prompt/index.ts`): each is its blocks'
  texts joined with `\n\n`.
- A block is `{ id: string; text: string }`; the IDs are stable (B1…).
- `src/loop/propose.ts` puts `BASE_PROMPT` then the situation's instruction into the message
  list (`docs/ir_semantics.md` §6).
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
| B1 | Frame: a coding agent with access to files/directories on disk; one or more moves per turn (a batch, independent calls) | `ir_semantics` §1 | in code |
| B0 | Frame: a coding agent implemented as a state machine — states with exit criteria, transitions as preconditions | `prompt_state_machine_concept` | in code |
| B4 | The state mechanism (move on with `create_goal` when the criterion holds); the candidate initial states (`Start`); the conditioned transitions grouped by source, rendered from `ISLANDS` | `src/ir/islands.ts` | in code |
| B6 | Goal from the request: interpret once, literal command verbatim, workspace root, `cd <dir> &&`, do not guess a command | `tools` §5.1 | in code |
| B7 | Loop: search → implement → verify; batch independent reads; once the exact change is named, `edit` at once; build and run the tests, then `stop` on success. After each result the model chooses the next move; to change state, `create_goal` (no failure needed); `stop` closes the goal (no criterion) | `ir_semantics` §4.1 | in code |
| B18 | Micro-examples of a move: recon in one batch; `edit` with the exact text; finish with `stop` | `tests/prompt.test.ts` | in code |
| B13 | Output discipline: keep reasoning short; never reconstruct code from memory (use `read`/`grep`/`webfetch`); no code snippets in reasoning | `tests/prompt.test.ts` | in code |

On an open goal, `NODE_INSTRUCTIONS.goal` is followed by `ISLAND_INSTRUCTIONS[state]` — the
focused island's work, closing criterion and constraints (`What / Done when / Constraints`),
keyed by the goal's authored `state` (`src/ir/islands.ts`, `docs/prompt_state_machine_concept.md`).
A stalled goal also gets a soft nudge (`Context.nudge`, `docs/ir_semantics.md` §2.8).

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
- **B6** interprets the request once with `create_goal { what, state, action }`: `state` names
  the island the goal starts in; `action` is the first plan item — any tool (a bash command
  stays literal, from the workspace root, with a `cd <dir> &&` prefix in a subdirectory). If
  the request names no command, the first action is a discovery one (`ls`, `cat README.md`).
  The same rule is in the `create_goal` `description` — the schema the model sees on every call.
- **B7** fixes the loop **search → implement → verify**: search first and widely (a batch of
  independent reads/greps), and once the exact change is named, `edit`/`write` at once; then
  build and run the tests, and `stop` on success. After each result the model chooses the next
  move; to move the work to the next state it calls `create_goal` (no failure is needed), and
  the engine places the sub-goal by the current item's outcome (a new alternative, or a new plan
  item when the plan is exhausted). `stop` closes the goal and is the only way to finish it (no
  criterion gate).
- **B18** gives short micro-examples of a move (recon in one batch; `edit` with the exact text;
  finish with `stop`) to anchor the form of a move.
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
- **Phase 5 (2026-10-08).** B3/B4/B11 and the `create_goal` description now state that the
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
  `create_goal` tool `description` (B6 already had it, but the tool schema is what the model
  attends to most). A live `fix-ocaml-gc` run interpreted the request — which named `ocaml/`
  and the bare `make -C testsuite one DIR=tests/basic` — with the bare command and only
  revised it late, turning most of the run into criterion churn. B7's interpretation bullet
  also gained the caveat. New live test `tests/live/root-cd.test.ts` (one call per layout).
- **Phase 10 (2026-10-09).** Goal reduction (`docs/plans/goal_reduction_plan.md`): B3/B4/B6/
  B7/B11/B15 lose the criterion vocabulary. A goal is `what` with a plan
  seeded by the first `command`; `stop` closes it with no criterion gate; `revises`/
  `repeat_hypothesis`/`check_not_run`/`checkReady`/`nextAction`/`state` are gone. The
  `create_goal` and `run` tool `description`s are rewritten accordingly (`run` is one plain
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
  `executeNode` runs them in order in one turn and a terminal move (`create_goal`/`stop`/
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

## 5. Test map

| Level | Where | What it checks |
|---|---|---|
| L1 | `tests/prompt.test.ts` | assembly from blocks; unique IDs; the prompt does not repeat tool descriptions; stream separation + `pipefail` in the `bash` description; stale-read safeguard in `edit`/`write`; workspace root (prompt + `create_goal` description) |
| L1 (Phase 2) | `tests/prompt.test.ts` | every `PROPOSAL_TOOLS` tool is registered; no `apply {`/`{ tool:` |
| L2 | `tests/live/scenarios.test.ts` | trajectory shape on a fixture (B7) |
| L3 | `bench/`, `docs/benches/bench_report.md` | acceptance; the controlled experiment (Phase 5) |

## 6. Open questions

- The target character budget for the prompt and what to move into tool `description`s.
- How strict B6/B7 should be (how much to dictate order vs leave flexibility).
- The prompt no longer carries a diff/localization heuristic (Phase 11); if one is wanted
  later it should be an optional tool-usage hint, not a base block.
