# Skein — system prompt revision plan

> Russian mirror — `docs/plans/system_prompt_revision_plan_ru.md`.

Related: `docs/plans/implementation_plan.md` (roadmap and status),
`docs/ir_semantics.md` (IR semantics: the prompt is the doxa's policy over it),
`docs/tools.md` (tool contract), `src/loop/propose.ts` (the current prompt),
`docs/bench_report.md` §4.4 (the opencode comparison).

Code is written only after a phase is agreed; the plan is refined step by step (as in
`docs/plans/tier1_plan.md`).

**Status.** All phases (1–5) are done (2026-10-07). Phases 1–4: blocks, document, L1/L2,
`fetch`/`apply_patch`, the guard; L2 live 18/18. Phase 5: a controlled A/B
(`ref-localize-{on,off}`, n=3, both agents) — the reference strategy is adopted, reward is
unchanged, input −23% (Skein) / −38% (opencode); opencode is cheaper in total (57k vs 99k
prompt tokens), with no architectural win on the easy task; report in
`docs/bench_report.md` §4.5.

## 1. Substance and fixed decisions

The system prompt (`src/loop/propose.ts`) is currently one unstructured literal, with
duplication and accumulated drift (it describes an `apply` operator that does not exist
under native tool-calling; rules are duplicated between the output section and "Rules").
The revision:

1. **The prompt is the doxa's policy** over the IR semantics. The source of truth is a
   separate document `docs/system_prompt.md` (+RU); the code follows it as the IR code
   follows `docs/ir_semantics.md`.
2. **Block assembly.** The prompt is assembled from named blocks `{id, text}`; one block
   is one behavior. This makes a block addressable and testable.
3. **Single source for the tool contract.** Block B12 (tool names and descriptions) is
   generated from `src/llm/tools.ts` (`PROPOSAL_TOOLS`), not hand-copied. Strategy (when
   and why) lives in the behavioral blocks.
4. **Three test levels** (L1/L2/L3, §6): a static text contract in CI; fixture scenarios
   under the live gate; acceptance on the bench.
5. **Behavioral changes** (the B8 VCS policy, the B9 external reference) are made only
   after the document and L1, as a separate phase.

Scope: we do not touch the IR semantics or the engine; we do not change the projection
context format; minimal diff per phase. Out of scope: making `apply_patch`/`fetch`
mandatory — Phase 4, a separate decision; embeddings, deep LSP, subagents, UI.

## 2. Block taxonomy

One block is one behavior, with a stable ID. The IDs go into `docs/system_prompt.md` and
the L1 tests.

| ID | Behavior | Basis | Level |
|---|---|---|---|
| B1 | Frame: the doxa proposes exactly one operator, the logos decides | `ir_semantics` §1, §7 | L1 |
| B2 | Capabilities / fragment bounds | `src/ir/fragment.ts` | L1 |
| B3 | Tree vocabulary: `request`/`goal`/`plan`/`check`/`achieved_under`/`refuted`/`addressed` | `ir_semantics` §2 | L1 |
| B4 | Reading the projection: `path`/`constraints`/`lastResult`/`calls`/`shown`/`applicable`/`checkReady`/`nextAction`/`budget` | `src/ir/project.ts` | L1 |
| B5 | Memory and working set: `shown`, `query {id}`, "no knowledge outside the context" | `tools` §4.4–4.5 | L1 |
| B6 | Goal from the request: literal commands verbatim, workspace root, `cd <dir> &&`, do not guess a command | `tools` §5.1 | L1 |
| B7 | Decomposition: stage sub-goals; a bug = reproduce/locate/fix; no separate verify | `ir_semantics` §4.1 | L2 |
| B8 | VCS/history policy (see §4, Phase 3) | this plan | L2 |
| B9 | External reference / differential localization (see §4, Phase 3) | this plan | L2 |
| B10 | Failure → cause: log → location, read symbol/macro definitions | `tools` §5 | L2 |
| B11 | Revision loop: `refuted` = progress, `revises` lists the failures | `ir_semantics` §4.1, §2.7 | L2 |
| B12 | Tool contract: flat names; generated from `PROPOSAL_TOOLS` | `src/llm/tools.ts` | L1 |
| B13 | Output discipline: `thought` ≤1 sentence, exactly one call | `tests/prompt.test.ts` | L1 |
| B14 | Stream discipline: no `2>&1`/`&>`, no pipe through `tail`/`head` | `tools` §4.3 | L1 |
| B15 | Stop condition: request `addressed` → stop | `ir_semantics` §6 | L2 |
| B16 | Constraints/safety: never violate a `constraint`, never edit on a stale read | `ir_semantics` §9 | L1 |

## 3. The separate document `docs/system_prompt.md`

Structure (modeled on `docs/ir_semantics.md`):

- §0 Principle: the prompt is the operational spec of the doxa's policy; a behavior
  change goes "edit here → edit the block → test".
- §1 Assembly model: blocks, order, invariants (no duplication; one block = one
  behavior; the tool contract from the registry).
- §2 Blocks B1–B16: for each — purpose, the exact instruction, the context fields it
  reads, what it forbids, degradation when absent, test.
- §3 Cross-cutting invariants (no contradictions between blocks; every tool named
  callably; character budget).
- §4 What changed and why (the git policy, the `apply` drift).
- §5 Test map L1/L2/L3.
- §6 Open questions.

## 4. Phases

### Phase 1 — skeleton and document (no behavior change)

**Goal.** Move the text into blocks, document it, change no behavior.

**Changes.**
- `src/loop/prompt/blocks.ts` — `PROMPT_BLOCKS: { id: string; text: string }[]` with the
  current text laid out as B1–B16.
- `src/loop/prompt/index.ts` — assembly: `SYSTEM_PROMPT = PROMPT_BLOCKS.map(b => b.text).join("\n\n")`;
  export `PROMPT_BLOCKS`/IDs.
- `src/loop/propose.ts` — imports `SYSTEM_PROMPT` from `prompt/` and re-exports it (keep
  the current import path in `tests/prompt.test.ts`).
- `docs/system_prompt.md` (+RU) — the document from §3.

**Why.** Without step 1, later edits would again rewrite the monolith.

**Verification.** `npm run typecheck`; `SKEIN_LIVE=false npx vitest run` (the old
`tests/prompt.test.ts` stays green); a new L1 test: IDs unique, `SYSTEM_PROMPT` equals
the concatenation of blocks. The diff is a text move (byte-identical except separators).

### Phase 2 — remove the drift (B12)

**Goal.** The prompt names tools exactly as they are registered.

**Changes.**
- B12 is generated from `PROPOSAL_TOOLS`: a `- <name>: <description>` line per tool; a
  call by name, without the `apply { action: { tool } }` wrapper and without the nested
  `{ tool: "read", ... }` notation.
- Remove duplication between the tool section and the trailing "Rules".
- Detailed argument prose stays in each tool's `description` (`src/llm/tools.ts`); the
  prompt carries only the generated index.

**Why.** After the move to native tool calls (`469be05`) the prompt stayed on the old
nested schema; `toProposal` rejects `apply` as `unknown tool call`.

**Verification.** L1: every `PROPOSAL_TOOLS[].function.name` appears as a callable name;
the prompt has no `apply {` and no `{ tool:`; offline tests.

### Phase 3 — behavior: VCS and the external reference (B8/B9)

**Goal.** Lift the "never git" over-correction and legitimize reference localization.

**Changes.**
- B8 (rewrite): git/history is a normal tool *when* the repository has it; in this
  harness `.git` may be absent — do not retry a failed `git`; "local history" and an
  "external reference" are different things.
- B9 (new): if an artifact has a canonical reference (upstream, a registry version, a
  sibling copy), obtaining it and diffing is a legitimate and often fastest
  localization. In IR terms: an artifact `file` with `external` provenance; the diff is
  an observation. First cut is via `run` (`curl`/`diff`), no new tool.
- L2 fixtures: (a) offline — a reference snapshot in the workspace, expect a diff
  localization; (b) a repository without `.git`, expect no repeated `git` commands.

**Why.** On `fix-ocaml-gc` opencode found the bug exactly this way (curl the upstream +
diff, one `edit`), while Skein worked manually; the prompt currently forbids this path
with its "no VCS" reflex.

**Verification.** `SKEIN_LIVE=true` fixtures (trajectory shape); L1 stays green;
`docs/system_prompt.md` §4 records the change.

### Phase 4 — tools for the strategy

**Goal.** Give the B9 strategy a first-class tool (by decision, as a separate sub-step
each).

**Changes (candidates, each with its own spec and diff).**
- `fetch`/`webfetch`: materializes a reference into the workspace (e.g. `.skein/ref/…`)
  and returns an `id`; the result is addressable and recallable via `query`.
- `apply_patch`: apply an upstream diff as one edit (opencode has it; we do not).
- Incidentally: reconcile the workspace guard with the reference — `read` on a path
  outside the workspace currently crashes the run (`bench_report.md` §4.4, problem 5).

**Verification.** `tests/ops/` for the new tool; a live scenario; an entry in
`docs/ir_operations.md` and `docs/tools.md`.

### Phase 5 — controlled experiment (intermediate result)

**Goal.** Show that Phases 3–4 actually change behavior, and separate the strategy's
contribution from the network confounder.

**Design.**
- A task with a canonical reference (of the same nature as `fix-ocaml-gc`, but
  controlled).
- One agent, one model, one budget — run under two conditions: network **off** and
  network **on**. The strategy's contribution = B − A.
- For the architectural comparison — both agents (Skein and opencode) under both
  conditions.
- Metrics: turns to localization, reward, whether the diff path appears in the
  trajectory.

**Changes.** A section in `docs/bench_report.md` (+RU); if needed, the Phase 3 offline
fixture as a reproducible base.

**Why last.** It depends on B8/B9 (Phase 3) and optionally `fetch`/`apply_patch`
(Phase 4); there is nothing to measure before them.

**Verification.** A report with A/B numbers; an explicit note about the confounder if
network matters.

## 5. Traceability

Each block B1–B16 gets: a `docs/system_prompt.md` §2 entry → a block in
`src/loop/prompt/blocks.ts` → an L1/L2 test. Phases 3–5 additionally get an entry in
`docs/plans/implementation_plan.md` (status/backlog).

## 6. Tests

- **L1 — static contract (offline, CI).** `tests/prompt.test.ts`: block IDs unique and
  present; `SYSTEM_PROMPT` equals the concatenation of blocks; every
  `PROPOSAL_TOOLS[].function.name` is named callably; no `apply {`/`{ tool:`; every
  required fragment (B6/B13/B14) is present; the character budget is not exceeded.
- **L2 — fixture scenarios (under `SKEIN_LIVE=true`).** Per behavior, a fixture plus a
  check of the **trajectory shape** (the strategy is present), not an exact output. The
  harness is `tests/live/scenarios.test.ts`. Honestly: flaky, not in CI.
- **L3 — acceptance/bench.** Runs on real tasks, including the Phase 5 experiment.

## 7. Risks and open questions

- **LLM non-determinism.** L2 is weak and flaky; hence L1 is mandatory, L2 only under
  the gate, L3 is acceptance.
- **Prompt length.** Blocks let us measure and trim; the current prompt is ~12k
  characters. Open: the target budget and what to move into tool descriptions.
- **Network as a confounder.** Any network-bound strategy biases the agent comparison
  (`bench_report.md` §4.4). Hence the paired off/on in Phase 5.
- **Phase 4 scope.** `fetch`/`apply_patch` are separate decisions; they are not in the
  mandatory scope.
