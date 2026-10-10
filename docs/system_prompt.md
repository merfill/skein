# Skein — system prompt: behavior and blocks

> **Note (IR revision folded; a next stage).** The prompt is now split into a stable **base**
> and **node instructions** (request/goal) — see `src/loop/prompt/blocks.ts` and
> `docs/ir_semantics.md` §6–7. The per-block detail below predates that split and the message
> tape; the composite base/node prompt is the following stage, so this document is expected to
> change.

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

- The prompt is assembled in `src/loop/prompt/index.ts` from `PROMPT_BLOCKS`
  (`src/loop/prompt/blocks.ts`): `SYSTEM_PROMPT = PROMPT_BLOCKS.map(b => b.text).join("\n\n")`.
- A block is `{ id: string; text: string }`; the IDs are stable (B1…).
- `src/loop/propose.ts` re-exports `SYSTEM_PROMPT` (keeps the tests' import path).
- The technical tool contract is **generated from the registry** `PROPOSAL_TOOLS`
  (`src/llm/tools.ts`), not copied into the text (Phase 2).

**Assembly invariants:**

1. one block = one behavior; no duplication between blocks;
2. every behavior has an ID and a §2 entry;
3. the assembled prompt equals the concatenation of blocks (checked by L1);
4. the tool names match the registry (checked by L1).

## 2. Blocks

The prompt is deliberately plain (an "opencode-style" trim, Phase 11): it states what the
engine requires, not how to think. Strategy lives in the tool `description`s and the tape.
Current blocks:

| ID | Behavior | Basis | Status |
|---|---|---|---|
| B1 | Frame: the doxa proposes exactly one operator, the logos decides; the context is a message tape rebuilt each turn | `ir_semantics` §1, §7 | in code |
| B2 | Capabilities from `FRAGMENT`; anything else is outside the fragment | `src/ir/fragment.ts` | in code |
| B6 | Goal from the request: literal commands verbatim, workspace root, `cd <dir> &&`, do not guess a command | `tools` §5.1 | in code |
| B7 | Work one command per turn; `apply` follows the outcome; a sub-goal decomposes a step; `stop` closes the goal (no criterion); a large result body is addressed by id with `recall`/`search` | `ir_semantics` §4.1 | in code |
| B12 | Tool contract: flat names generated from `PROPOSAL_TOOLS` | `src/llm/tools.ts` | in code (generated) |
| B13 | Output discipline: `thought` ≤1 sentence, exactly one call; output+reasoning short — never recall/reconstruct code from memory, no code snippets in reasoning | `tests/prompt.test.ts` | in code |
| B14 | Stream discipline: no `2>&1`/`&>`, no pipe through `tail`/`head` | `tools` §4.3 | in code |
| B16 | Constraints/safety: never violate a `constraint`, never edit on a stale read | `ir_semantics` §9 | in code (trimmed) |

Removed in the opencode-style trim (Phase 11): **B3/B4/B5** (folded), **B8** (VCS policy),
**B9** (external reference / diff playbook), **B11** (revision loop), **B15** (stop — now a
bullet in B7), **B17** (foreground — now in the `run` description). Also cut: **B10** (the
failure-diagnosis playbook) and the localize→edit trigger from **B16**, and the
diff/localization steering from the `fetch`/`grep` descriptions. The rationale: these were
opinionated strategy heuristics; the prompt now keeps only the engine contract, and a generic
coding model strategizes from the tape and the tool descriptions.

### Per-block detail

- **B1** sets the role: the doxa only proposes; refusals and tool failures are the only facts
  the engine adds. The context is a message tape rebuilt from the tree each turn, not a
  dialogue.
- **B2** lists `FRAGMENT` (inspect/modify/execute/verify/abduce).
- **B6** forbids guessing a command; the first command is literal, from the workspace root,
  with a `cd <dir> &&` prefix in a subdirectory. If the request names no command, the first
  item is a discovery command (`ls`, `cat README.md`). The same rule is in the `create_goal`
  `description` (B12) — the schema the model sees on every call.
- **B7** fixes the loop: work ONE command per turn; `apply` follows the outcome of the current
  step (a SUCCEEDED command is a new plan item, a FAILED one a new alternative marked
  `alternative to step …`). `create_goal` while the goal is open decomposes the step into a
  sub-goal. `stop` closes the goal and is the only way to finish it (no criterion gate). A
  large result body is addressed by id: `recall { id, start?, end? }` re-reads a fragment,
  `search { id, pattern }` finds a pattern inside it.
- **B10** was removed: the failure→cause playbook (wrong-directory vs unbuilt-tree) was an
  opinionated heuristic; the log on the tape and the tool descriptions carry it.
- **B12** lists the tools; generated from `PROPOSAL_TOOLS`, so drift is impossible.
- **B13** bounds `thought` (≤1 sentence; a decision, not analysis) and keeps output/reasoning short — never recall/reconstruct code from memory, no code snippets in reasoning (to see code, `read`/`grep`/`fetch`).
- **B14** forbids `2>&1`/`&>` and pipes through `tail`/`head`.
- **B16** keeps only the unique safety rules (constraints, stale read); the localize→edit
  trigger was removed as a strategy crutch.

## 3. Cross-cutting invariants

1. no contradictions between blocks (checked by review and L1 phrasings);
2. every registry tool is named callably (L1, Phase 2);
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

## 5. Test map

| Level | Where | What it checks |
|---|---|---|
| L1 | `tests/prompt.test.ts` | assembly from blocks; unique IDs; stream discipline; workspace root (prompt + `create_goal` description); wrong-directory reaction; setup (unbuilt tree) vs wrong directory |
| L1 (Phase 2) | `tests/prompt.test.ts` | every `PROPOSAL_TOOLS` tool is named; no `apply {`/`{ tool:` |
| L2 | `tests/live/scenarios.test.ts` | trajectory shape on a fixture (B7/B10/B16) |
| L3 | `bench/`, `docs/benches/bench_report.md` | acceptance; the controlled experiment (Phase 5) |

## 6. Open questions

- The target character budget for the prompt and what to move into tool `description`s.
- How strict B6/B7 should be (how much to dictate order vs leave flexibility).
- The prompt no longer carries a diff/localization heuristic (Phase 11); if one is wanted
  later it should be an optional tool-usage hint, not a base block.
